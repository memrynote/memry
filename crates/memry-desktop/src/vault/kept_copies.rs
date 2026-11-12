//! The hidden folders a kept note's delete writes its text into, and the open's sweep that
//! shows what no kept note owns there (#4272).
//!
//! A kept note (`notes::kept`) has no file, so an app delete writes its text from the document
//! and moves that file to the OS trash. When anything stands at the note's path, the copy goes
//! under the same name in a new hidden folder beside it: `f/.memry-kept-<12 hex>/a.md` for the
//! note `f/a.md`. The open walk, the watcher, Electron's indexer and watcher, the CLI and sync
//! skip dot folders, so a copy there is never taken as a note.
//!
//! **Reserved name, a vault-format contract.** A folder named exactly `.memry-kept-` and 12
//! lowercase hex digits ([`is_kept_name`]) is this app's. Older builds that do not know the name
//! skip it as any dot folder and lose nothing: its files stay on disk. Every newer build accepts
//! it and sweeps it at open as below; a name off by one character is a user's folder, never
//! touched.
//!
//! **The open's rule.** Before the watcher starts (beside the folder-move sweep,
//! [`super::move_journal`]), every regular file in such a folder (found by the open's note
//! count outside dot and excluded folders, never through a link) is one of two things:
//!
//! - **Owned**: a kept note's row names the copy's note path (`f/a.md`: the copy's name in the
//!   folder holding the hidden one). That is a delete still running (in this process or
//!   another), or one a crash stopped before its trash step. The copy only repeats text the
//!   note's document holds, and the note is still listed as kept, so the file stays hidden and
//!   is never swept or deleted: shown, it would be taken as a second note of the same text.
//! - **Ownerless**: the delete went through, and the copy came back from the trash (the
//!   Windows Recycle Bin and the Linux trash restore a file to the folder it left, the hidden
//!   one), or its note is no longer kept. It is renamed, never replacing anything, into the
//!   folder holding the hidden one as `<name> (incomplete delete)<ext>`, then
//!   `<name> (incomplete delete 2)<ext>` ..., the way a folder move's leftover becomes
//!   `<name> (incomplete move)`. The open walk then finds it as a note.
//!
//! A hidden folder left empty is removed. Anything else in it (a folder, a link) stays.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::fs_atomic::rename_no_replace;
use super::move_journal::vault_relative;

const SCOPE: &str = "kept_copies";

const PREFIX: &str = ".memry-kept-";
/// The hex digits of a hidden folder's id.
const ID_LEN: usize = 12;
/// The most visible names tried for one copy.
const VISIBLE_NAMES: u32 = 1000;

/// A folder of this name holds a kept note's copy: `.memry-kept-` and 12 lowercase hex digits.
pub fn is_kept_name(name: &str) -> bool {
    let hex = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
    name.strip_prefix(PREFIX)
        .is_some_and(|id| id.len() == ID_LEN && id.bytes().all(hex))
}

/// `rel`'s name in a new hidden folder beside it: `f/.memry-kept-<12 hex>/a.md` for `f/a.md`.
pub(crate) fn hidden_copy_path(rel: &str) -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let folder = format!("{PREFIX}{}", &id[..ID_LEN]);
    match rel.rsplit_once('/') {
        Some((parent, name)) => format!("{parent}/{folder}/{name}"),
        None => format!("{folder}/{rel}"),
    }
}

/// Shows the copies in `folders` (the hidden folders the open's note count found) that no kept
/// note owns (module doc). `owned` is asked with the copy's note path, vault-relative and
/// `/`-separated; it answers true when it cannot tell. Returns the visible files.
pub fn show_ownerless(
    vault: &Path,
    folders: &[PathBuf],
    owned: &mut dyn FnMut(&str) -> bool,
) -> Vec<PathBuf> {
    let mut shown = Vec::new();
    for folder in folders {
        let real = fs::symlink_metadata(folder).is_ok_and(|meta| meta.is_dir());
        let named = folder
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(is_kept_name);
        let (Some(parent), true, true) = (folder.parent(), real, named) else {
            continue;
        };
        let Ok(parent_rel) = vault_relative(vault, parent) else {
            continue;
        };
        let entries = match fs::read_dir(folder) {
            Ok(entries) => entries,
            Err(error) => {
                tracing::warn!(scope = SCOPE, kind = ?error.kind(), "a kept copy's folder is unreadable");
                continue;
            }
        };
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
                continue;
            }
            let note = match parent_rel.as_str() {
                "" => name.clone(),
                parent => format!("{parent}/{name}"),
            };
            if owned(&note) {
                continue;
            }
            match show(&entry.path(), parent, &name) {
                Ok(visible) => shown.push(visible),
                // The error kind only: the path is note-derived. The copy stays hidden.
                Err(error) => {
                    tracing::error!(scope = SCOPE, kind = ?error.kind(), "a kept copy stayed hidden")
                }
            }
        }
        match fs::remove_dir(folder) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            // Not empty: an owned copy, or something that is no copy.
            Err(_) if fs::read_dir(folder).is_ok_and(|mut left| left.next().is_some()) => {}
            Err(error) => {
                tracing::warn!(scope = SCOPE, kind = ?error.kind(), "an empty kept copy's folder stayed")
            }
        }
    }
    if !shown.is_empty() {
        tracing::warn!(
            scope = SCOPE,
            shown = shown.len(),
            "showed kept copies no kept note owns"
        );
    }
    shown
}

/// Renames `copy` into the first free `<name> (incomplete delete)<ext>` in `parent`.
fn show(copy: &Path, parent: &Path, name: &str) -> io::Result<PathBuf> {
    let (stem, ext) = match name.rfind('.') {
        Some(dot) if dot > 0 => name.split_at(dot),
        _ => (name, ""),
    };
    for n in 1..=VISIBLE_NAMES {
        let visible = parent.join(match n {
            1 => format!("{stem} (incomplete delete){ext}"),
            n => format!("{stem} (incomplete delete {n}){ext}"),
        });
        match rename_no_replace(copy, &visible) {
            Ok(()) => return Ok(visible),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::from(io::ErrorKind::AlreadyExists))
}
