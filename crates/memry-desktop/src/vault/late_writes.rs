//! What an outside writer puts in a note file after the app replaced it (#4289). A writer that
//! truncated the file and stalled before its write, or wrote a first chunk and stalled before
//! the rest, still holds the file the app's rename took off its path, and on Unix its writes
//! land there, in a file no path names. A write over a file the run did not write holds that
//! file open ([`Replaced`]) and keeps what the writer puts in it, for [`WATCH`], as a version of
//! the note: the app's text wins, and the outside text is kept (#4257 L1).
//!
//! The watch holds the vault weakly, so a close or a reopen never waits for it: a writer's
//! text that lands after its vault closed is not kept. On Windows the write holds no handle: a rename over a file a handle holds fails on a volume
//! without POSIX rename semantics, and the write would never land.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Weak};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use memry_core::api::vault::Vault;
use memry_core::markdown::frontmatter::split_frontmatter_block;

use super::hash::content_hash;
use super::note_file::MAX_NOTE_BYTES;

const SCOPE: &str = "vault_late_writes";

/// How long a replaced file is watched for its writer's bytes; only a file written within it
/// before the replace is.
pub const WATCH: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(100);
/// At most this many files are watched at once: each holds a thread and a file handle.
const MAX_WATCHED: usize = 32;
static WATCHED: AtomicUsize = AtomicUsize::new(0);

/// The file a write replaced, with the hash of the bytes it held then; open on Unix.
#[derive(Debug)]
pub struct Replaced {
    file: Option<File>,
    hash: String,
}

impl Replaced {
    pub(super) fn new(file: Option<File>, hash: &str) -> Self {
        Self {
            file,
            hash: hash.to_owned(),
        }
    }

    /// Keeps each text an outside writer puts in the replaced file within [`WATCH`] as a
    /// version of the note, on a thread of its own. For a file whose bytes are the run's own
    /// there is no writer to watch for, nor for one nobody wrote within [`WATCH`] (a file of an
    /// earlier run the open's reconcile writes).
    pub(crate) fn keep_late_writes(self, vault: &Arc<Vault>, note_id: &str) {
        let Some(file) = self.file.filter(written_lately) else {
            return;
        };
        if WATCHED.fetch_add(1, Ordering::Relaxed) >= MAX_WATCHED {
            WATCHED.fetch_sub(1, Ordering::Relaxed);
            return tracing::warn!(scope = SCOPE, note_id, "too many replaced files watched");
        }
        let (note, hash, vault) = (note_id.to_owned(), self.hash, Arc::downgrade(vault));
        let spawned = thread::Builder::new()
            .name("vault-late-writes".into())
            .spawn(move || {
                watch(&file, hash, &vault, &note);
                WATCHED.fetch_sub(1, Ordering::Relaxed);
            });
        if let Err(error) = spawned {
            WATCHED.fetch_sub(1, Ordering::Relaxed);
            tracing::error!(
                scope = SCOPE,
                note_id,
                "a replaced file is not watched for its writer: {error}"
            );
        }
    }
}

/// Reads the file once its size and time stop moving, and once more at the end of [`WATCH`]
/// (a write that kept both), and keeps each text it has not kept yet, while the vault is open.
fn watch(file: &File, mut kept: String, vault: &Weak<Vault>, note_id: &str) {
    let deadline = Instant::now() + WATCH;
    let mut last = stat(file);
    let mut moved = false;
    loop {
        thread::sleep(POLL);
        if vault.strong_count() == 0 {
            return;
        }
        let now = stat(file);
        let end = Instant::now() >= deadline;
        if now != last {
            (last, moved) = (now, true);
            if !end {
                continue;
            }
        }
        if moved || end {
            moved = false;
            if let Some(text) = read(file).filter(|text| !text.is_empty()) {
                let hash = content_hash(&text);
                if hash != kept {
                    keep(vault, note_id, &text);
                    kept = hash;
                }
            }
        }
        if end {
            return;
        }
    }
}

/// Whether the file was written within [`WATCH`] (or is dated ahead of the clock).
fn written_lately(file: &File) -> bool {
    let modified = file.metadata().and_then(|meta| meta.modified());
    // `elapsed` fails for a time ahead of the clock.
    modified.is_ok_and(|at| !at.elapsed().is_ok_and(|age| age >= WATCH))
}

fn stat(file: &File) -> Option<(u64, Option<SystemTime>)> {
    let meta = file.metadata().ok()?;
    Some((meta.len(), meta.modified().ok()))
}

fn read(mut file: &File) -> Option<String> {
    let mut bytes = Vec::new();
    let read = file
        .seek(SeekFrom::Start(0))
        .and_then(|_| file.take(MAX_NOTE_BYTES + 1).read_to_end(&mut bytes));
    match read {
        Ok(_) if bytes.len() as u64 <= MAX_NOTE_BYTES => {
            // A version holds what Electron would read of it.
            Some(String::from_utf8_lossy(&bytes).into_owned())
        }
        Ok(_) => {
            tracing::warn!(scope = SCOPE, "a replaced file grew past the read cap");
            None
        }
        Err(error) => {
            tracing::warn!(scope = SCOPE, "a replaced file could not be read: {error}");
            None
        }
    }
}

fn keep(vault: &Weak<Vault>, note_id: &str, text: &str) {
    let Some(vault) = vault.upgrade() else {
        return tracing::warn!(
            scope = SCOPE,
            note_id,
            "an outside writer's text in a replaced file came after its vault closed"
        );
    };
    let body = split_frontmatter_block(text).body;
    match vault.write_back().keep_outside_write(note_id, text, body) {
        Ok(true) => tracing::warn!(
            scope = SCOPE,
            note_id,
            "an outside writer wrote to a file the app had replaced; its text is kept as a version"
        ),
        // A version holds that text already.
        Ok(false) => {}
        Err(error) => tracing::error!(
            scope = SCOPE,
            note_id,
            "an outside writer's text in a replaced file was not kept: {error}"
        ),
    }
}
