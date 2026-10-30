//! The journal of folder moves that go entry by entry, and the sweep that finishes what a crash
//! left of one (#3754).
//!
//! A crash, a kill or a power cut mid-move leaves files in the hidden staging folder
//! (`.memry-move-<12 hex>`, [`super::move_dir`]), where neither the user nor the watcher sees
//! them: at the next open the watcher would report those notes removed, and their removal
//! deletes them. So before its staging folder exists, a move writes a record
//! `.memry/moves/<12 hex>.json` naming its source and its staging folder, vault-relative, and
//! drops it once the move is done or fully undone. The vault open sweeps before any open hook,
//! so before the watcher starts:
//!
//! - A record whose staging folder is there: everything in it goes back into the source with
//!   the rollback's own put-back, which never replaces (a name taken meanwhile keeps its file
//!   and the note comes back beside it as a conflict copy, and what cannot go back waits in a
//!   visible `<source name> (incomplete move)` folder). The record goes once nothing is staged.
//!   Run again, the put-back finishes what a kill stopped: every staged entry goes back to its
//!   own path, in any order.
//! - A record whose staging folder is gone: the move was done or undone; the record goes.
//! - A folder named exactly `.memry-move-<12 hex>` that no usable record names (Electron
//!   stages its moves under the same name, with no journal): its source is unknown, so it is
//!   renamed whole into a visible `Moved folder (incomplete move)` beside it, never deleted.
//!
//! The sweep touches no other folder: no name off by a character, no link, nothing in a dot
//! or excluded folder, no record that leads out of the vault or names a staging folder other
//! than its own. A record of a newer version, and its staging folder, are that build's. A
//! move still running in this process (the vault closed and opened again mid-move) is skipped.
//!
//! `.memry/moves/` is the shipped format: `{"version": 1, "from": "<rel>", "staging": "<rel>"}`
//! with `/`-separated vault-relative paths. A build reads every version 1 record, whichever
//! build wrote it, and leaves any other version alone.

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use super::fs_atomic::atomic_create;
use super::layout::MEMRY_DIR;
use super::move_dir::{self, Step};
use super::walk::Limits;
use crate::shell::file_open::{Resolution, resolve_under_root};

const SCOPE: &str = "move_journal";

/// The journal's folder inside [`MEMRY_DIR`].
const MOVES_DIR: &str = "moves";
pub(super) const STAGING_PREFIX: &str = ".memry-move-";
/// The hex digits of a move's id: Electron's `randomBytes(6)`.
pub(super) const ID_LEN: usize = 12;
const VERSION: u32 = 1;
/// The visible name of a staging folder whose source is unknown.
const UNKNOWN_SOURCE: &str = "Moved folder";

/// The ids of the moves running in this process.
static IN_FLIGHT: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

fn in_flight() -> MutexGuard<'static, BTreeSet<String>> {
    IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Serialize, Deserialize)]
struct Record {
    version: u32,
    from: String,
    staging: String,
}

#[derive(Deserialize)]
struct Header {
    version: u32,
}

/// The id of an exact staging folder name: `.memry-move-` and 12 lowercase hex digits.
pub(super) fn staging_id(name: &str) -> Option<&str> {
    let id = name.strip_prefix(STAGING_PREFIX)?;
    let hex = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
    (id.len() == ID_LEN && id.bytes().all(hex)).then_some(id)
}

/// `path` relative to `vault`, `/`-separated: plain names only.
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

/// The record of a move that is running: dropped by [`Journaled::forget`], and kept for the
/// next open's sweep when the move ends with files still staged. Marks the move in flight
/// while it lives.
pub(super) struct Journaled {
    id: String,
    path: PathBuf,
}

impl Journaled {
    /// Writes the record of the move from `from` through `staging`, both vault-relative.
    pub(super) fn write(vault: &Path, id: &str, from: &str, staging: &str) -> io::Result<Self> {
        in_flight().insert(id.to_owned());
        let journaled = Journaled {
            id: id.to_owned(),
            path: vault
                .join(MEMRY_DIR)
                .join(MOVES_DIR)
                .join(format!("{id}.json")),
        };
        let record = Record {
            version: VERSION,
            from: from.to_owned(),
            staging: staging.to_owned(),
        };
        let bytes = serde_json::to_vec(&record).map_err(io::Error::other)?;
        if let Some(folder) = journaled.path.parent() {
            fs::create_dir_all(folder)?;
        }
        atomic_create(&journaled.path, &bytes).map_err(|error| error.source)?;
        Ok(journaled)
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
    /// Visible folders holding what could not go back, and any staging folder that could not
    /// even be renamed into one.
    pub kept: Vec<PathBuf>,
}

impl Sweep {
    /// Something did not go back under its own name.
    pub fn left_beside(&self) -> bool {
        !self.conflict_copies.is_empty() || !self.kept.is_empty()
    }
}

/// Puts back or shows what interrupted moves left in `vault` (module doc). `exclude` is the
/// vault's exclude list: no staging folder is looked for inside an excluded folder.
pub fn sweep(vault: &Path, exclude: &[String]) -> Sweep {
    sweep_checked(vault, exclude, &mut |_| Ok(()))
}

/// [`sweep`] with a hook that runs before every step and can fail it.
#[doc(hidden)]
pub fn sweep_checked(
    vault: &Path,
    exclude: &[String],
    hook: &mut dyn FnMut(Step<'_>) -> io::Result<()>,
) -> Sweep {
    let mut swept = Sweep::default();
    let mut owned = BTreeSet::new();
    for (id, record) in records(vault) {
        if in_flight().contains(&id) || put_back(vault, &id, &record, hook, &mut swept) {
            owned.insert(id);
        }
    }
    for staging in staging_folders(vault, exclude) {
        let id = staging
            .file_name()
            .and_then(|name| staging_id(name.to_str()?))
            .unwrap_or_default();
        if owned.contains(id) || in_flight().contains(id) {
            continue;
        }
        tracing::warn!(scope = SCOPE, "showing a staging folder no record names");
        swept
            .kept
            .extend(move_dir::show_staged(&staging, UNKNOWN_SOURCE, hook));
    }
    swept
}

/// The records in the journal, by id. A file that is no record is left alone.
fn records(vault: &Path) -> Vec<(String, PathBuf)> {
    let folder = vault.join(MEMRY_DIR).join(MOVES_DIR);
    let entries = match fs::read_dir(&folder) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => {
            tracing::warn!(scope = SCOPE, kind = ?error.kind(), "the move journal is unreadable");
            return Vec::new();
        }
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let id = name.strip_suffix(".json")?;
            staging_id(&format!("{STAGING_PREFIX}{id}"))?;
            Some((id.to_owned(), entry.path()))
        })
        .collect()
}

/// Sweeps the move of one record. True when the record's staging folder is the record's own
/// business: put back, gone, or a newer build's.
fn put_back(
    vault: &Path,
    id: &str,
    record: &Path,
    hook: &mut dyn FnMut(Step<'_>) -> io::Result<()>,
    swept: &mut Sweep,
) -> bool {
    let text = match fs::read(record) {
        Ok(text) => text,
        Err(error) => {
            tracing::warn!(scope = SCOPE, kind = ?error.kind(), "a move record is unreadable");
            return false;
        }
    };
    match serde_json::from_slice::<Header>(&text) {
        Ok(header) if header.version == VERSION => {}
        Ok(_) => return true,
        Err(_) => {
            tracing::warn!(
                scope = SCOPE,
                "a move record is not JSON; its folder is shown"
            );
            return false;
        }
    }
    let Some((from, staging)) = serde_json::from_slice::<Record>(&text)
        .ok()
        .and_then(|r| resolve(vault, id, &r))
    else {
        tracing::warn!(
            scope = SCOPE,
            "a move record leads elsewhere; its folder is shown"
        );
        forget(record, hook);
        return false;
    };
    if fs::symlink_metadata(&staging).is_ok_and(|meta| meta.is_dir()) {
        let left = move_dir::put_back_staged(&from, &staging, hook);
        swept.undone += 1;
        swept.conflict_copies.extend(left.conflict_copies);
        swept.kept.extend(left.kept);
    }
    // Gone, or a file or a link that took the name, which is never put back or followed.
    if !fs::symlink_metadata(&staging).is_ok_and(|meta| meta.is_dir()) {
        forget(record, hook);
    }
    true
}

/// The source and the staging folder a version 1 record names, when both are inside the vault
/// and the staging folder is the record's own: `.memry-move-<its id>`.
fn resolve(vault: &Path, id: &str, record: &Record) -> Option<(PathBuf, PathBuf)> {
    let inside = |rel: &str| {
        matches!(
            resolve_under_root(vault, rel),
            Ok(Resolution::Inside(_) | Resolution::Missing)
        )
    };
    let own = record
        .staging
        .rsplit('/')
        .next()
        .and_then(staging_id)
        .is_some_and(|staged| staged == id);
    (own && inside(&record.staging) && inside(&record.from))
        .then(|| (vault.join(&record.from), vault.join(&record.staging)))
}

/// Folders named exactly `.memry-move-<12 hex>` in the vault, outside dot and excluded folders,
/// never through a link. Bounded in steps like the vault walk ([`Limits`]).
fn staging_folders(vault: &Path, exclude: &[String]) -> Vec<PathBuf> {
    let limits = Limits::DEFAULT;
    let mut found = Vec::new();
    let mut visited = 0;
    let mut stack = vec![(vault.to_owned(), 0)];
    while let Some((folder, depth)) = stack.pop() {
        let entries = match fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(error) => {
                tracing::warn!(scope = SCOPE, kind = ?error.kind(), "a folder was not searched for staging folders");
                continue;
            }
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > limits.max_entries {
                tracing::warn!(scope = SCOPE, "the staging folder search stopped at a cap");
                return found;
            }
            // Not followed: a link is never a staging folder, and never entered.
            if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if staging_id(name).is_some() {
                found.push(entry.path());
            } else if !name.starts_with('.')
                && !exclude.iter().any(|excluded| excluded == name)
                && depth < limits.max_depth
            {
                stack.push((entry.path(), depth + 1));
            }
        }
    }
    found
}
