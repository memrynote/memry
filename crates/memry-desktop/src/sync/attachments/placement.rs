//! Where a downloaded embed ends up, before it is recorded (`onDownloadNeeded`,
//! `sync-attachment-handlers.ts:690-698`). The manifest names the file by the name it was
//! uploaded under, and the download puts it in `attachments/<noteId>/`; the note's body is the
//! authority:
//! - a body that links the file outside every note's folder (`sources/x.zip`) gets it moved there
//!   (`placeDownloadedFile`, #2755);
//! - a body that renamed it in the note's folder gets it renamed (`applyDownloadedAttachmentName`,
//!   #1714).
//!
//! Neither replaces a file, and neither rewrites the body. A failure is logged and leaves the
//! file where it landed.
//!
//! A download can land before the body that links it: [`place_linked_downloads`] places it
//! once the write-back wrote that body (`placeLinkedDownloads`, `crdt-writeback.ts:724`).

use std::io::{self, Read};
use std::path::Path;

use memry_core::api::errors::StorageError;
use memry_core::sync::attachments::backfill::embedded_files;
use memry_core::sync::attachments::queue::{VaultFiles, absolute};
use memry_core::sync::attachments::store::{files, upload_queue};
use rusqlite::{Connection, OptionalExtension, params};

use crate::attachments::reconcile_downloaded_name;
use crate::vault::file_types::file_type_of_extension;
use crate::vault::fs_atomic::rename_no_replace;

/// A note body is read up to this size, as the backfill reads it.
const MAX_BODY_BYTES: u64 = 32 * 1024 * 1024;

/// Settles the file `rel` (vault-relative) a download put in `attachments/<owner>/`, and moves
/// its record if it has one (`moveRecord`). Answers where the file is.
pub(super) fn settle(
    conn: &Connection,
    vault: &dyn VaultFiles,
    owner: &str,
    rel: String,
    now_ms: i64,
) -> Result<String, StorageError> {
    let Some(body) = body_of(conn, vault, owner)? else {
        return Ok(rel);
    };
    let placed = place(conn, vault, owner, &rel, &body)?.unwrap_or_else(|| rel.clone());
    let settled = match placed.rsplit_once('/') {
        Some((folder, name)) if placed == rel && folder == format!("attachments/{owner}") => {
            let name = reconcile_downloaded_name(vault.root(), owner, name, &body);
            format!("{folder}/{name}")
        }
        _ => placed,
    };
    if settled != rel {
        files::move_record(conn, owner, &rel, &settled, now_ms)?;
    }
    Ok(settled)
}

/// `placeLinkedDownloads`: every recorded file of `owner` in `attachments/<owner>/` that its
/// body links elsewhere moves there ([`linked_path`]), and its record with it.
pub(crate) fn place_linked_downloads(
    conn: &Connection,
    vault: &dyn VaultFiles,
    owner: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let Some(body) = body_of(conn, vault, owner)? else {
        return Ok(());
    };
    let folder = format!("attachments/{owner}/");
    for row in files::records(conn, owner)? {
        if row.path.starts_with(&folder)
            && let Some(to) = place(conn, vault, owner, &row.path, &body)?
        {
            files::move_record(conn, owner, &row.path, &to, now_ms)?;
        }
    }
    Ok(())
}

/// Moves the file `rel` to its [`linked_path`], answering where it went. A failed move is logged
/// and leaves the file.
fn place(
    conn: &Connection,
    vault: &dyn VaultFiles,
    owner: &str,
    rel: &str,
    body: &str,
) -> Result<Option<String>, StorageError> {
    let Some(to) = linked_path(conn, vault, owner, rel, body)? else {
        return Ok(None);
    };
    Ok(match move_to(vault.root(), rel, &to) {
        Ok(()) => Some(to),
        Err(error) => {
            tracing::warn!(owner_id = owner, %error, "a downloaded attachment stays where it landed");
            None
        }
    })
}

/// The markdown of the live note `owner`, `None` when it has no `.md` file to read.
fn body_of(
    conn: &Connection,
    vault: &dyn VaultFiles,
    owner: &str,
) -> Result<Option<String>, StorageError> {
    let path: Option<String> = conn
        .query_row(
            "SELECT f.path FROM note_files f JOIN notes n ON n.id = f.note_id
             WHERE f.note_id = ?1 AND n.deleted_at IS NULL",
            params![owner],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    let Some(path) = path.filter(|path| path.ends_with(".md")) else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    match vault.open(&path) {
        Ok(file) => file.take(MAX_BODY_BYTES).read_to_end(&mut bytes),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => Err(error),
    }
    .map_err(|error| StorageError::Failed {
        what: format!("the body of {owner}: {error}"),
    })?;
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

/// `linkedPathOf`: the one path the body embeds outside every note's folder with the file's
/// name, when the body does not also link the file where it is, the name is no note type of its
/// own (that one reaches its path through its own sync), and the path is free and inside the
/// vault.
fn linked_path(
    conn: &Connection,
    vault: &dyn VaultFiles,
    owner: &str,
    rel: &str,
    body: &str,
) -> Result<Option<String>, StorageError> {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    let ext = name.rsplit_once('.').map_or("", |(_, ext)| ext);
    if file_type_of_extension(ext).is_some() {
        return Ok(None);
    }
    let note_path: String = conn
        .query_row(
            "SELECT path FROM note_files WHERE note_id = ?1",
            params![owner],
            |row| row.get(0),
        )
        .map_err(failed)?;
    let embedded = embedded_files(body, &note_path, owner);
    if embedded.iter().any(|file| file == rel) {
        return Ok(None);
    }
    let mut linked = Vec::new();
    for file in embedded {
        if file.rsplit('/').next() == Some(name) && outside_note_folders(conn, vault, owner, &file)?
        {
            linked.push(file);
        }
    }
    Ok(match linked.as_slice() {
        [one] if is_free_inside(vault.root(), one) => linked.pop(),
        _ => None,
    })
}

/// `embeddedFilesOutsideNoteFolders`, for one file: under `attachments/`, a folder that is no
/// live note's; elsewhere, no file note whose bytes are uploaded or queued.
fn outside_note_folders(
    conn: &Connection,
    vault: &dyn VaultFiles,
    owner: &str,
    file: &str,
) -> Result<bool, StorageError> {
    if let Some(rest) = file.strip_prefix("attachments/") {
        let folder = rest.split('/').next().unwrap_or_default();
        return Ok(folder != owner && !is_live_note(conn, folder)?);
    }
    let file_note: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT n.id, n.attachment_id FROM note_files f JOIN notes n ON n.id = f.note_id
             WHERE f.path = ?1 AND n.deleted_at IS NULL",
            params![file],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(failed)?;
    Ok(match file_note {
        None => true,
        Some((_, Some(_))) => false,
        Some((id, None)) => !upload_queue::has_pending(conn, &id, &absolute(vault, file))?,
    })
}

fn is_live_note(conn: &Connection, id: &str) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT 1 FROM notes WHERE id = ?1 AND deleted_at IS NULL",
        params![id],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(failed)
}

/// `isFreeInsideVault`: nothing is at `rel`, and its nearest folder that exists resolves inside
/// the vault (no link out of it).
fn is_free_inside(root: &Path, rel: &str) -> bool {
    let target = root.join(rel);
    if target.symlink_metadata().is_ok() {
        return false;
    }
    let Ok(root) = root.canonicalize() else {
        return false;
    };
    target
        .ancestors()
        .skip(1)
        .find(|dir| dir.symlink_metadata().is_ok())
        .and_then(|dir| dir.canonicalize().ok())
        .is_some_and(|dir| dir.starts_with(&root))
}

/// Moves the file without replacing one at `to` (Electron links, then unlinks).
fn move_to(root: &Path, from: &str, to: &str) -> io::Result<()> {
    let target = root.join(to);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    rename_no_replace(&root.join(from), &target)
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
