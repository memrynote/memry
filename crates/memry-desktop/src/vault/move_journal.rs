//! The journal of folder moves that go entry by entry, and the sweep that finishes what a crash
//! left of one (#3754).
//!
//! A crash, a kill or a power cut mid-move leaves files in the hidden staging folder
//! (`.memry-move-<12 hex>`, [`super::move_dir`]), where neither the user nor the watcher sees
//! them: at the next open the watcher would report those notes removed, and their removal
//! deletes them. So before its staging folder exists, a move writes a record
//! `.memry/moves/<12 hex>.json` naming its source and its staging folder, and drops it once the
//! move is done or fully undone. The vault open sweeps before any open hook, so before the
//! watcher starts:
//!
//! - A record whose staging folder is there: everything in it goes back into the source with
//!   the rollback's own put-back, which never replaces (a name taken meanwhile keeps its file
//!   and the note comes back beside it as a conflict copy, and what cannot go back waits in a
//!   visible `<source name> (incomplete move)` folder). The record goes once nothing is staged.
//!   Run again, the put-back finishes what a kill stopped: every staged entry goes back to its
//!   own path, in any order.
//! - A record whose staging folder is gone: the move was done or undone; the record goes.
//! - A folder named exactly `.memry-move-<12 hex>` that no usable record names (Electron stages
//!   its moves under the same name, with no journal; a newer build's record; a record that
//!   leads elsewhere or is no record): its source is unknown or not ours to trust, so it is
//!   renamed into a visible `Moved folder (incomplete move)` beside it, never deleted.
//!
//! The open's note count finds those folders ([`super::init::count_markdown_files`]): an exact
//! name outside dot and excluded folders, never through a link ([`is_staging_name`] decides).
//! The sweep touches no other folder: no record that leads out of the vault, names a staging
//! folder other than its own, or puts back into its staging folder or the app's folder. A move
//! still running in this process (the vault closed and opened again mid-move) is skipped; the
//! guard is per process, so another process moving in the same vault is not seen.
//!
//! A record is untrusted input: it is listed only as a regular file (a link or a FIFO named as
//! one is dropped, never followed), opened under the vault (`file_open::open_under_root`'s
//! checks: no FIFO blocks, nothing outside is read) and read at most [`RECORD_MAX`] bytes; one
//! that keeps changing while it is opened is kept for a later sweep. A journal folder that
//! is a link is neither read nor written.
//!
//! The format, `{"version": 1, "from": "<rel>", "staging": "<rel>", "shown": "<rel>"}` with
//! `/`-separated vault-relative paths, ships with the app: every build reads every version 1
//! record. `from` is absent for a staging folder that is only shown. `shown` names the visible
//! folder a show moves into, written before anything moves there, so a sweep killed mid-show is
//! still reported by the next. A new field old builds may ignore keeps version 1; the version
//! goes up only for a change old builds must not act on, and they then only show the folder.

use std::collections::BTreeSet;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::fs_atomic::{RETRY_DELAYS_MS, atomic_create, atomic_write, with_transient_retry};
use super::layout::{MEMRY_DIR, MOVES_DIR};
use super::move_dir::{self, Step};
use crate::shell::file_open::{
    LinkPolicy, OpenError, Resolution, open_checked, resolve_under_root,
};

const SCOPE: &str = "move_journal";

pub(super) const STAGING_PREFIX: &str = ".memry-move-";
/// The hex digits of a move's id: Electron's `randomBytes(6)`.
pub(super) const ID_LEN: usize = 12;
const VERSION: u32 = 1;
/// The most bytes a record holds; a longer file is no record.
const RECORD_MAX: u64 = 4096;
/// The visible name of a staging folder whose source is unknown.
const UNKNOWN_SOURCE: &str = "Moved folder";

/// The ids of the moves running in this process.
static IN_FLIGHT: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

fn in_flight() -> MutexGuard<'static, BTreeSet<String>> {
    IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Record {
    version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    from: Option<String>,
    staging: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shown: Option<String>,
}

#[derive(Deserialize)]
struct Header {
    version: u32,
}

/// A folder of this name is a move's staging folder: `.memry-move-` and 12 lowercase hex digits.
pub fn is_staging_name(name: &str) -> bool {
    staging_id(name).is_some()
}

pub(super) fn staging_id(name: &str) -> Option<&str> {
    let id = name.strip_prefix(STAGING_PREFIX)?;
    let hex = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
    (id.len() == ID_LEN && id.bytes().all(hex)).then_some(id)
}

/// `path` relative to `vault`, `/`-separated: plain names only. Lexical, so `path` starts with
/// `vault` spelled the same way.
pub(super) fn vault_relative(vault: &Path, path: &Path) -> io::Result<String> {
    let invalid = || io::Error::new(io::ErrorKind::InvalidInput, "not a folder of the vault");
    let rel = path.strip_prefix(vault).map_err(|_| invalid())?;
    let mut parts = Vec::new();
    for component in rel.components() {
        match component {
            Component::Normal(name) => parts.push(name.to_str().ok_or_else(invalid)?),
            _ => return Err(invalid()),
        }
    }
    Ok(parts.join("/"))
}

/// `rel`'s names joined to `vault` one at a time: a `\\?\` path takes no `/`.
fn join(vault: &Path, rel: &str) -> PathBuf {
    rel.split('/')
        .fold(vault.to_owned(), |path, name| path.join(name))
}

fn record_rel(id: &str) -> String {
    format!("{MEMRY_DIR}/{MOVES_DIR}/{id}.json")
}

/// The journal folder when it may be read and written: a real folder inside the vault, or none
/// yet. A link, or a `.memry` that leads out of the vault, is refused.
fn journal(vault: &Path) -> io::Result<Option<PathBuf>> {
    let refused = || {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "the move journal is not a folder",
        )
    };
    let folder = join(vault, &format!("{MEMRY_DIR}/{MOVES_DIR}"));
    if matches!(
        resolve_under_root(vault, &format!("{MEMRY_DIR}/{MOVES_DIR}"))?,
        Resolution::Outside
    ) {
        return Err(refused());
    }
    match fs::symlink_metadata(&folder) {
        Ok(meta) if meta.is_dir() => Ok(Some(folder)),
        Ok(_) => Err(refused()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Writes `record` at `path` in the vault's journal: a new one, or over the one there.
fn store(vault: &Path, path: &Path, record: &Record, new: bool) -> io::Result<()> {
    journal(vault)?;
    let bytes = serde_json::to_vec(record).map_err(io::Error::other)?;
    let written = if new {
        atomic_create(path, &bytes)
    } else {
        atomic_write(path, &bytes)
    };
    written.map_err(|error| error.source)
}

/// The record of a move that is running: dropped by [`Journaled::forget`], and kept for the
/// next open's sweep when the move ends with files still staged. Marks the move in flight
/// while it lives.
pub(super) struct Journaled {
    id: String,
    path: PathBuf,
    record: Record,
}

impl Journaled {
    /// Writes the record of the move from `from` through `staging`, both vault-relative.
    pub(super) fn write(vault: &Path, id: &str, from: &str, staging: &str) -> io::Result<Self> {
        in_flight().insert(id.to_owned());
        let journaled = Journaled {
            id: id.to_owned(),
            path: join(vault, &record_rel(id)),
            record: Record {
                version: VERSION,
                from: Some(from.to_owned()),
                staging: staging.to_owned(),
                shown: None,
            },
        };
        store(vault, &journaled.path, &journaled.record, true)?;
        Ok(journaled)
    }

    /// Names in the record the visible folder a rollback is about to move into.
    pub(super) fn will_show(&mut self, vault: &Path, visible: &Path) {
        self.record.shown = vault_relative(vault, visible).ok();
        if let Err(error) = store(vault, &self.path, &self.record, false) {
            tracing::warn!(scope = SCOPE, kind = ?error.kind(), "a move record was not updated");
        }
    }

    pub(super) fn forget(self, hook: &mut dyn FnMut(Step<'_>) -> io::Result<()>) {
        forget(&self.path, hook);
    }
}

impl Drop for Journaled {
    fn drop(&mut self) {
        in_flight().remove(&self.id);
    }
}

fn forget(record: &Path, hook: &mut dyn FnMut(Step<'_>) -> io::Result<()>) {
    let removed = hook(Step::Forget(record)).and_then(|()| fs::remove_file(record));
    match removed {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        // The next open drops it: its staging folder is gone.
        Err(error) => tracing::warn!(
            scope = SCOPE,
            kind = ?error.kind(),
            "a folder move's journal record was not dropped"
        ),
    }
}

/// What a sweep did. Paths name notes' folders: for the user, never for a log.
#[derive(Debug, Default)]
pub struct Sweep {
    /// Interrupted moves put back into their source.
    pub undone: usize,
    /// Notes that came back beside a file that took their name.
    pub conflict_copies: Vec<PathBuf>,
    /// Visible folders holding what an undone move could not put back, and any staging folder
    /// that could not even be renamed into one.
    pub kept: Vec<PathBuf>,
    /// Staging folders no usable record names, made visible.
    pub shown: Vec<PathBuf>,
}

impl Sweep {
    pub fn changed(&self) -> bool {
        self.undone > 0
            || !self.conflict_copies.is_empty()
            || !self.kept.is_empty()
            || !self.shown.is_empty()
    }
}

/// Puts back or shows what interrupted moves left in `vault` (module doc). `staged` are the
/// staging folders the open's note count found.
pub fn sweep(vault: &Path, staged: &[PathBuf]) -> Sweep {
    sweep_checked(vault, staged, &mut |_| Ok(()))
}

/// [`sweep`] with a hook that runs before every step and can fail it.
#[doc(hidden)]
pub fn sweep_checked(
    vault: &Path,
    staged: &[PathBuf],
    hook: &mut dyn FnMut(Step<'_>) -> io::Result<()>,
) -> Sweep {
    let mut swept = Sweep::default();
    let mut owned = BTreeSet::new();
    for id in records(vault, hook) {
        if in_flight().contains(&id) || sweep_record(vault, &id, hook, &mut swept) {
            owned.insert(id);
        }
    }
    for staging in staged {
        let Some(id) = staging.file_name().and_then(|n| staging_id(n.to_str()?)) else {
            continue;
        };
        let real = fs::symlink_metadata(staging).is_ok_and(|meta| meta.is_dir());
        if !real || !staging.starts_with(vault) || owned.contains(id) || in_flight().contains(id) {
            continue;
        }
        tracing::warn!(
            scope = SCOPE,
            "showing a staging folder no usable record names"
        );
        swept
            .shown
            .extend(show_unrecorded(vault, staging, id, hook));
    }
    swept
}

/// The ids of the records in the journal. Anything else named as one is dropped: a link or a
/// FIFO (only its name, never its target), and never a folder.
fn records(vault: &Path, hook: &mut dyn FnMut(Step<'_>) -> io::Result<()>) -> Vec<String> {
    let folder = match journal(vault) {
        Ok(Some(folder)) => folder,
        Ok(None) => return Vec::new(),
        Err(error) => {
            tracing::warn!(scope = SCOPE, kind = ?error.kind(), "the move journal is not read");
            return Vec::new();
        }
    };
    let entries = match fs::read_dir(&folder) {
        Ok(entries) => entries,
        Err(error) => {
            tracing::warn!(scope = SCOPE, kind = ?error.kind(), "the move journal is unreadable");
            return Vec::new();
        }
    };
    let mut ids = Vec::new();
    for entry in entries.flatten() {
        let Some(id) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.strip_suffix(".json"))
            .filter(|id| is_staging_name(&format!("{STAGING_PREFIX}{id}")))
            .map(str::to_owned)
        else {
            continue;
        };
        match entry.file_type() {
            Ok(kind) if kind.is_file() => ids.push(id),
            // A folder is not removed: the failed drop is logged.
            _ => {
                tracing::warn!(scope = SCOPE, "a move record is no regular file; dropped");
                forget(&entry.path(), hook);
            }
        }
    }
    ids
}

/// The record's bytes, read bounded and retried while it is held or replaced for a moment. A
/// record that keeps changing is `ResourceBusy`, which keeps it for a later sweep.
fn read_record(
    vault: &Path,
    id: &str,
    hook: &mut dyn FnMut(Step<'_>) -> io::Result<()>,
) -> io::Result<Option<Vec<u8>>> {
    let delays = RETRY_DELAYS_MS.map(Duration::from_millis);
    let rel = record_rel(id);
    let path = join(vault, &rel);
    with_transient_retry(&delays, || {
        let mut stepped = Ok(());
        let opened = open_checked(vault, &rel, LinkPolicy::RejectHardLinks, &mut || {
            if stepped.is_ok() {
                stepped = hook(Step::ReadRecord(&path));
            }
        });
        stepped?;
        let file = match opened {
            Ok(Some(file)) => file,
            Ok(None) => return Ok(None),
            Err(OpenError::Io(error)) => return Err(error),
            Err(changing @ OpenError::KeptChanging) => {
                return Err(io::Error::new(io::ErrorKind::ResourceBusy, changing));
            }
            Err(refused) => return Err(io::Error::new(io::ErrorKind::InvalidData, refused)),
        };
        let mut bytes = Vec::new();
        file.take(RECORD_MAX + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > RECORD_MAX {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "too long"));
        }
        Ok(Some(bytes))
    })
}

/// Sweeps the move of one record. Returns whether the record owns its staging folder: false
/// for one that is unusable (dropped), cannot be read or checked now, or is a newer build's
/// (kept), whose folder is then only shown.
fn sweep_record(
    vault: &Path,
    id: &str,
    hook: &mut dyn FnMut(Step<'_>) -> io::Result<()>,
    swept: &mut Sweep,
) -> bool {
    let path = join(vault, &record_rel(id));
    let bytes = match read_record(vault, id, hook) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return false,
        Err(error) if error.kind() == io::ErrorKind::InvalidData => {
            tracing::warn!(
                scope = SCOPE,
                "a move record is no record; its folder is shown"
            );
            forget(&path, hook);
            return false;
        }
        Err(error) => {
            tracing::warn!(scope = SCOPE, kind = ?error.kind(), "a move record is unreadable");
            return false;
        }
    };
    match serde_json::from_slice::<Header>(&bytes) {
        Ok(header) if header.version == VERSION => {}
        Ok(_) => return false,
        Err(_) => {
            tracing::warn!(
                scope = SCOPE,
                "a move record is not JSON; its folder is shown"
            );
            forget(&path, hook);
            return false;
        }
    }
    let mut record = match serde_json::from_slice::<Record>(&bytes) {
        Ok(record) => record,
        Err(_) => {
            tracing::warn!(
                scope = SCOPE,
                "a move record has no folders; its folder is shown"
            );
            forget(&path, hook);
            return false;
        }
    };
    let (from, staging, shown) = match resolve(vault, id, &record) {
        Resolved::Usable {
            from,
            staging,
            shown,
        } => (from, staging, shown),
        Resolved::Unchecked(kind) => {
            tracing::warn!(
                scope = SCOPE,
                ?kind,
                "a move record cannot be checked; kept"
            );
            return false;
        }
        Resolved::Elsewhere => {
            tracing::warn!(
                scope = SCOPE,
                "a move record leads elsewhere; its folder is shown"
            );
            forget(&path, hook);
            return false;
        }
    };
    // A sweep killed mid-show: the folder it named is in sight already.
    if let Some(shown) = shown.filter(|s| fs::symlink_metadata(s).is_ok_and(|m| m.is_dir())) {
        match from {
            Some(_) => swept.kept.push(shown),
            None => swept.shown.push(shown),
        }
    }
    let mut will_show = |visible: &Path| {
        record.shown = vault_relative(vault, visible).ok();
        if let Err(error) = store(vault, &path, &record, false) {
            tracing::warn!(scope = SCOPE, kind = ?error.kind(), "a move record was not updated");
        }
    };
    if fs::symlink_metadata(&staging).is_ok_and(|meta| meta.is_dir()) {
        match &from {
            Some(from) => {
                let left = move_dir::put_back_staged(from, &staging, hook, &mut will_show);
                swept.undone += 1;
                swept.conflict_copies.extend(left.conflict_copies);
                swept.kept.extend(left.kept);
            }
            None => swept.shown.extend(move_dir::show_staged(
                &staging,
                UNKNOWN_SOURCE,
                hook,
                &mut will_show,
            )),
        }
    }
    // Gone, or a file or a link that took the name, which is never put back or followed.
    if !fs::symlink_metadata(&staging).is_ok_and(|meta| meta.is_dir()) {
        forget(&path, hook);
    }
    true
}

enum Resolved {
    Usable {
        from: Option<PathBuf>,
        staging: PathBuf,
        shown: Option<PathBuf>,
    },
    /// A path of the record leads out of the vault, or the record names a staging folder not its
    /// own, or puts back into its staging folder or the app's folder.
    Elsewhere,
    /// A path of the record could not be checked now (a folder on it is unreadable).
    Unchecked(io::ErrorKind),
}

/// The folders a version 1 record names, when they are inside the vault, the staging folder is
/// the record's own (`.memry-move-<its id>`), and the source is neither in it nor in the app's
/// folder (in any letter case).
fn resolve(vault: &Path, id: &str, record: &Record) -> Resolved {
    let own = record
        .staging
        .rsplit('/')
        .next()
        .and_then(staging_id)
        .is_some_and(|staged| staged == id);
    if !own {
        return Resolved::Elsewhere;
    }
    let paths = [
        Some(&record.staging),
        record.from.as_ref(),
        record.shown.as_ref(),
    ];
    for rel in paths.into_iter().flatten() {
        match resolve_under_root(vault, rel) {
            Ok(Resolution::Inside(_) | Resolution::Missing) => {}
            Ok(Resolution::Outside) => return Resolved::Elsewhere,
            Err(error) => return Resolved::Unchecked(error.kind()),
        }
    }
    if let Some(from) = &record.from
        && (within(from, &record.staging) || within(from, MEMRY_DIR))
    {
        return Resolved::Elsewhere;
    }
    Resolved::Usable {
        from: record.from.as_deref().map(|rel| join(vault, rel)),
        staging: join(vault, &record.staging),
        shown: record.shown.as_deref().map(|rel| join(vault, rel)),
    }
}

/// `rel` is `folder` or inside it, comparing names in any ASCII letter case.
fn within(rel: &str, folder: &str) -> bool {
    let mut names = rel.split('/');
    folder.split('/').all(|f| {
        names
            .next()
            .is_some_and(|name| name.eq_ignore_ascii_case(f))
    })
}

/// Shows a staging folder no usable record names. A new record names the visible folder
/// first, so a sweep killed mid-show is still reported; a record kept under its id (a newer
/// build's, one not readable now) is never replaced.
fn show_unrecorded(
    vault: &Path,
    staging: &Path,
    id: &str,
    hook: &mut dyn FnMut(Step<'_>) -> io::Result<()>,
) -> Vec<PathBuf> {
    let path = join(vault, &record_rel(id));
    let staging_rel = vault_relative(vault, staging).ok();
    let mut wrote = false;
    let shown = move_dir::show_staged(staging, UNKNOWN_SOURCE, hook, &mut |visible| {
        let Some(staging) = staging_rel.clone() else {
            return;
        };
        let record = Record {
            version: VERSION,
            from: None,
            staging,
            shown: vault_relative(vault, visible).ok(),
        };
        match store(vault, &path, &record, true) {
            Ok(()) => wrote = true,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                tracing::warn!(scope = SCOPE, kind = ?error.kind(), "a show was not journaled");
            }
        }
    });
    if wrote && !fs::symlink_metadata(staging).is_ok_and(|meta| meta.is_dir()) {
        forget(&path, hook);
    }
    shown
}
