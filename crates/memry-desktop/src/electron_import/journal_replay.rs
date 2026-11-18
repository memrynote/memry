//! Replays Electron's bulk-apply journal (`sync-bulk-apply-journal.json`) into a vault before
//! it is imported, as Electron's next pull would (`replayBulkApplyJournal`,
//! `apps/desktop/src/main/sync/bulk-apply.ts:661`): note files whose rows committed while their
//! bytes never reached the vault are written, and files a remote delete removed are unlinked.
//!
//! The journal is read, never changed or removed: going back to Electron replays it again, and
//! every decision below is a no-op the second time. Each entry is decided as Electron decides
//! it (`isAlreadyLanded` :763, `isDeleteStillDue` :749). Every entry not applied is listed in
//! [`Replay::skipped`]: a file newer than the journal (Electron keeps it too), and three
//! refusals of our own: a write whose `sha256` does not match its content (Electron writes
//! it), a path outside the vault or through a symlink (Electron writes wherever the entry
//! points), and a write that failed (Electron logs it and drops the journal).

use std::collections::HashMap;
use std::fs;
use std::io::{self, Read as _};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::ImportError;
use super::profile::ElectronProfile;
use crate::vault::fs_atomic::{RETRY_DELAYS_MS, atomic_write_checked};

/// `JOURNAL_FILE_NAME` (`bulk-apply.ts:42`), in Electron's userData.
pub const JOURNAL_FILE: &str = "sync-bulk-apply-journal.json";
/// A journal holds one pulled page's note files. Larger than this is not one Electron wrote.
pub const MAX_JOURNAL_BYTES: u64 = 256 * 1024 * 1024;
const WHAT: &str = "bulk-apply journal";

/// One file op, as `PendingVaultFileOp` (`bulk-apply.ts:55-74`).
#[derive(Debug, Clone, PartialEq)]
pub enum JournalOp {
    Write {
        content: String,
        /// `false` when a `sha256` is recorded and is not the content's.
        sha_matches: bool,
    },
    /// `deferredAt`: wall-clock milliseconds when the delete was deferred.
    Delete { deferred_at: f64 },
}

#[derive(Debug, Clone, PartialEq)]
pub struct JournalEntry {
    /// Position in the journal's `entries`.
    pub index: usize,
    /// `absolutePath`, as Electron recorded it.
    pub path: String,
    pub op: JournalOp,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BulkApplyJournal {
    /// `writtenAt`; 0 for the bare-array journals of older builds.
    pub written_at: f64,
    /// The last entry per path (`latestOpPerPath`), in the order Electron applies them.
    pub entries: Vec<JournalEntry>,
    /// Indexes of entries of a kind this build does not know (`isPendingVaultFileOp`).
    pub unknown: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntrySkip {
    /// The recorded `sha256` is not the content's.
    ShaMismatch,
    /// Not an absolute path inside the vault, `..` in it, under `.memry/`, or through a symlink.
    UnsafePath,
    /// The file changed after the journal was written: Electron keeps the newer file.
    NewerOnDisk,
    WriteFailed(io::ErrorKind),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedEntry {
    pub index: usize,
    pub path: String,
    pub reason: EntrySkip,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Replay {
    pub written: Vec<PathBuf>,
    pub deleted: Vec<PathBuf>,
    /// Writes whose bytes are already there, and deletes of files already gone or newer.
    pub settled: usize,
    pub skipped: Vec<SkippedEntry>,
    /// Entries under another directory: another vault's, replayed with that vault.
    pub other_vault: usize,
}

thread_local! {
    static STEPS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Entries visited on this thread, for the complexity tests.
#[cfg(test)]
pub(crate) fn steps() -> usize {
    STEPS.with(std::cell::Cell::get)
}

fn step() {
    STEPS.with(|s| s.set(s.get() + 1));
}

impl BulkApplyJournal {
    /// The profile's journal. `Ok(None)` when there is none, which is the normal case.
    pub fn read(profile: &ElectronProfile) -> Result<Option<Self>, ImportError> {
        Self::read_capped(&profile.dir.join(JOURNAL_FILE), MAX_JOURNAL_BYTES)
    }

    fn read_capped(path: &Path, max_bytes: u64) -> Result<Option<Self>, ImportError> {
        let file = match fs::File::open(path) {
            Ok(file) => file,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(ImportError::io(path, err)),
        };
        let mut bytes = Vec::new();
        file.take(max_bytes + 1)
            .read_to_end(&mut bytes)
            .map_err(|err| ImportError::io(path, err))?;
        if bytes.len() as u64 > max_bytes {
            return Err(ImportError::UnsupportedLayout(WHAT));
        }
        Self::parse(&bytes).map(Some)
    }

    /// `replayBulkApplyJournal`'s parse: `{ writtenAt, entries }`, or a bare array of entries.
    /// JSON nests at most `serde_json`'s 128 levels; deeper fails the parse. A lone surrogate
    /// escape, which `JSON.parse` accepts and `serde_json` refuses, reads as U+FFFD: Node writes
    /// and hashes such a string as U+FFFD too.
    pub fn parse(bytes: &[u8]) -> Result<Self, ImportError> {
        let value: Value = serde_json::from_slice(bytes)
            .or_else(|_| serde_json::from_slice(&replace_lone_surrogates(bytes)))
            .map_err(|err| ImportError::parse(WHAT, byte_offset(bytes, &err)))?;
        let (written_at, raw) = match value {
            Value::Array(entries) => (0.0, entries),
            Value::Object(mut object) => match object.remove("entries") {
                Some(Value::Array(entries)) => (
                    object
                        .get("writtenAt")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0),
                    entries,
                ),
                _ => return Err(ImportError::UnsupportedLayout(WHAT)),
            },
            _ => return Err(ImportError::UnsupportedLayout(WHAT)),
        };
        let mut entries = Vec::new();
        let mut unknown = Vec::new();
        for (index, entry) in raw.into_iter().enumerate() {
            step();
            match parse_entry(index, entry) {
                Some(entry) => entries.push(entry),
                None => unknown.push(index),
            }
        }
        Ok(Self {
            written_at,
            entries: latest_per_path(entries),
            unknown,
        })
    }
}

/// `isPendingVaultFileOp` (`bulk-apply.ts:732`).
fn parse_entry(index: usize, entry: Value) -> Option<JournalEntry> {
    let Value::Object(mut object) = entry else {
        return None;
    };
    let Some(Value::String(path)) = object.remove("absolutePath") else {
        return None;
    };
    let op = match (object.remove("kind"), object.remove("content")) {
        (Some(Value::String(kind)), _) if kind == "delete" => JournalOp::Delete {
            deferred_at: object.get("deferredAt")?.as_f64()?,
        },
        (None, Some(Value::String(content))) => {
            // `entry.sha256 ?? sha256Hex(content)`: null counts as absent.
            let sha_matches = match object.get("sha256") {
                None | Some(Value::Null) => true,
                Some(Value::String(sha)) => *sha == sha256_hex(content.as_bytes()),
                Some(_) => false,
            };
            JournalOp::Write {
                content,
                sha_matches,
            }
        }
        _ => return None,
    };
    Some(JournalEntry { index, path, op })
}

/// Every `\uD800`-`\uDFFF` escape that is not half of a high-low pair becomes `\ufffd`. Same
/// length, so error offsets still point into `bytes`.
fn replace_lone_surrogates(bytes: &[u8]) -> Vec<u8> {
    let surrogate = |at: usize| -> Option<u16> {
        let escape = bytes.get(at..at + 6)?;
        if escape[..2] != *b"\\u" {
            return None;
        }
        let unit = u16::from_str_radix(std::str::from_utf8(&escape[2..]).ok()?, 16).ok()?;
        (0xd800..=0xdfff).contains(&unit).then_some(unit)
    };
    let mut out = bytes.to_vec();
    let mut at = 0;
    while at < bytes.len() {
        step();
        if bytes[at] != b'\\' {
            at += 1;
            continue;
        }
        match surrogate(at) {
            Some(0xd800..=0xdbff) if surrogate(at + 6).is_some_and(|low| low >= 0xdc00) => {
                at += 12;
            }
            Some(_) => {
                out[at..at + 6].copy_from_slice(b"\\ufffd");
                at += 6;
            }
            // Any other escape is two bytes or more; skipping two keeps `\\` from pairing up.
            None => at += 2,
        }
    }
    out
}

/// `latestOpPerPath` (`bulk-apply.ts:83`): the last op per path, ordered by where it was last
/// seen, as a JS `Map` with `delete` then `set` orders it.
fn latest_per_path(entries: Vec<JournalEntry>) -> Vec<JournalEntry> {
    let mut last: HashMap<&str, usize> = HashMap::with_capacity(entries.len());
    for (i, entry) in entries.iter().enumerate() {
        step();
        last.insert(&entry.path, i);
    }
    let keep: Vec<bool> = entries
        .iter()
        .enumerate()
        .map(|(i, entry)| last[entry.path.as_str()] == i)
        .collect();
    entries
        .into_iter()
        .zip(keep)
        .filter_map(|(entry, keep)| keep.then_some(entry))
        .collect()
}

/// Applies the entries under `vault` and reports every one. Entries elsewhere are counted in
/// [`Replay::other_vault`] and left for their own vault.
pub fn replay(journal: &BulkApplyJournal, vault: &Path) -> Replay {
    let mut out = Replay::default();
    for entry in &journal.entries {
        step();
        let skip = |reason| SkippedEntry {
            index: entry.index,
            path: entry.path.clone(),
            reason,
        };
        let target = match inside(vault, Path::new(&entry.path)) {
            Ok(Some(target)) => target,
            Ok(None) => {
                out.other_vault += 1;
                continue;
            }
            Err(()) => {
                out.skipped.push(skip(EntrySkip::UnsafePath));
                continue;
            }
        };
        match &entry.op {
            JournalOp::Write {
                sha_matches: false, ..
            } => out.skipped.push(skip(EntrySkip::ShaMismatch)),
            JournalOp::Write { content, .. } => {
                match write_due(&target, content.as_bytes(), journal.written_at) {
                    Due::Settled => out.settled += 1,
                    Due::Newer => out.skipped.push(skip(EntrySkip::NewerOnDisk)),
                    Due::Yes => match write(vault, &target, content.as_bytes()) {
                        Ok(()) => out.written.push(target),
                        Err(err) => out
                            .skipped
                            .push(skip(EntrySkip::WriteFailed(err.source.kind()))),
                    },
                }
            }
            JournalOp::Delete { deferred_at } => {
                // `isDeleteStillDue` (:749): a missing file needs no delete; one modified after
                // the delete was deferred stays.
                let Ok(meta) = fs::metadata(&target) else {
                    out.settled += 1;
                    continue;
                };
                if mtime_ms(&meta) > *deferred_at {
                    out.skipped.push(skip(EntrySkip::NewerOnDisk));
                    continue;
                }
                match fs::remove_file(&target) {
                    Ok(()) => out.deleted.push(target),
                    Err(err) if err.kind() == io::ErrorKind::NotFound => out.settled += 1,
                    Err(err) => out.skipped.push(skip(EntrySkip::WriteFailed(err.kind()))),
                }
            }
        }
    }
    out
}

enum Due {
    Yes,
    Settled,
    Newer,
}

/// `isAlreadyLanded`: the bytes are there, or the file changed after the journal was written
/// (whole milliseconds on both sides). A missing or unreadable file is due.
fn write_due(target: &Path, content: &[u8], written_at: f64) -> Due {
    let (Ok(meta), Ok(on_disk)) = (fs::metadata(target), fs::read(target)) else {
        return Due::Yes;
    };
    if sha256_hex(&on_disk) == sha256_hex(content) {
        Due::Settled
    } else if written_at > 0.0 && mtime_ms(&meta) > written_at {
        Due::Newer
    } else {
        Due::Yes
    }
}

/// `Math.floor(stat.mtimeMs)`.
fn mtime_ms(meta: &fs::Metadata) -> f64 {
    let Ok(modified) = meta.modified() else {
        return 0.0;
    };
    match modified.duration_since(UNIX_EPOCH) {
        Ok(after) => after.as_millis() as f64,
        Err(before) => -(before.duration().as_secs_f64() * 1000.0).ceil(),
    }
}

/// The byte-preserving atomic writer (Step 12), with the path re-checked right before the
/// rename: folders it created on the way must still be folders, not links.
fn write(
    vault: &Path,
    target: &Path,
    content: &[u8],
) -> Result<(), crate::vault::fs_atomic::WriteError> {
    let delays = RETRY_DELAYS_MS.map(Duration::from_millis);
    atomic_write_checked(target, content, &delays, &mut || {
        if no_link_below(vault, target) {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "a link in the path",
            ))
        }
    })
}

/// `Ok(Some(path))` for a file inside `vault`, `Ok(None)` for a path in another directory,
/// `Err` for one the replay refuses: relative, with `.`, `..` or a root inside, under
/// `.memry/` in any case (APFS and NTFS fold case; Windows also drops trailing dots and
/// spaces), or through a symlink.
fn inside(vault: &Path, path: &Path) -> Result<Option<PathBuf>, ()> {
    if !path.is_absolute() {
        return Err(());
    }
    let Ok(rel) = path.strip_prefix(vault) else {
        return Ok(None);
    };
    let mut parts = rel.components();
    match parts.next() {
        Some(Component::Normal(first)) if !is_memry_dir(first) => {}
        _ => return Err(()),
    }
    if !parts.all(|part| matches!(part, Component::Normal(_))) {
        return Err(());
    }
    let target = vault.join(rel);
    if no_link_below(vault, &target) {
        Ok(Some(target))
    } else {
        Err(())
    }
}

/// Misses NTFS stream names (`.memry::$DATA`) and 8.3 short names (`MEMRY~1`): corrupt journals.
fn is_memry_dir(name: &std::ffi::OsStr) -> bool {
    let name = name.to_string_lossy();
    let name = if cfg!(windows) {
        name.trim_end_matches(['.', ' '])
    } else {
        &name
    };
    name.eq_ignore_ascii_case(".memry")
}

/// No existing component of `target` below `vault` is a symlink.
fn no_link_below(vault: &Path, target: &Path) -> bool {
    let Ok(rel) = target.strip_prefix(vault) else {
        return false;
    };
    let mut at = vault.to_path_buf();
    for part in rel.components() {
        at.push(part);
        match fs::symlink_metadata(&at) {
            Ok(meta) if meta.file_type().is_symlink() => return false,
            Ok(_) => {}
            Err(_) => return true,
        }
    }
    true
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// The byte offset of a `serde_json` error from its line and column.
fn byte_offset(bytes: &[u8], err: &serde_json::Error) -> usize {
    let line_start: usize = bytes
        .split(|b| *b == b'\n')
        .take(err.line().saturating_sub(1))
        .map(|line| line.len() + 1)
        .sum();
    line_start + err.column().saturating_sub(1)
}

#[cfg(test)]
mod tests;
