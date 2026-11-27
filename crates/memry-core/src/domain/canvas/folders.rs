//! Canvas folder writes that span records: the index half of Electron's
//! `canvas/folder-store.ts` (`createCanvasFolder`, `relocateFolder`,
//! `setCanvasFolderIcon`, `deleteCanvasFolder`). Each is one transaction with
//! the outbox rows of every record it touches. The directories are the
//! shell's, which moves or makes them before it calls here and undoes the
//! move when the call fails.
//!
//! Every path here is canonical: the on-disk spelling the shell makes with
//! `portableCanvasFolder`. A record's id is its path's ([`canvas_folder::sync_id`]),
//! so `Work` and `work` are one folder.

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::domain::canvas_folder::{self, CanvasFolder};
use crate::domain::desktop_records::{self, live};
use crate::domain::notes::failed;
use crate::storage::nested_tx;
use crate::storage::repositories::Change;
use crate::sync::outbox;

use super::folder_paths::{
    CanvasFolderError, canvas_path_key, folder_segments, is_descendant_folder,
    rewrite_folder_prefix,
};
use super::store::{placements, set_folder_in, tombstone_in};

/// Why a folder write did not happen.
#[derive(Debug, thiserror::Error)]
pub enum FolderWriteError {
    /// A refusal the user can act on (`CanvasFolderErrorCode`).
    #[error(transparent)]
    Refused(#[from] CanvasFolderError),
    #[error(transparent)]
    Storage(#[from] StorageError),
}

/// A folder moved or renamed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Relocated {
    /// The folder at its new path.
    pub folder: CanvasFolder,
    /// Each canvas it carried, with the folder it is filed under now.
    pub canvases: Vec<(String, Option<String>)>,
}

/// `storedFolderPath`: a canonical folder in the spelling its live record was
/// stored with, or as given when it has none. `None` is the root.
pub fn stored_path(
    conn: &Connection,
    canonical: Option<&str>,
) -> Result<Option<String>, StorageError> {
    let Some(canonical) = canonical.filter(|path| !path.is_empty()) else {
        return Ok(None);
    };
    Ok(Some(
        canvas_folder::get(conn, canonical)?.map_or_else(|| canonical.to_owned(), |f| f.path),
    ))
}

/// `createCanvasFolder`: makes the folder at `canonical` live, and every
/// ancestor that has no record. A live folder of that path (any case) is
/// returned as it is.
pub fn create(
    conn: &Connection,
    vault_id: &str,
    canonical: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<CanvasFolder, StorageError> {
    let existing = canvas_folder::get(conn, canonical)?;
    let stored = existing.as_ref().map_or(canonical, |folder| &folder.path);
    let tx = nested_tx::begin(conn).map_err(failed)?;
    mint_ancestors(&tx, vault_id, stored, device_id, now_ms)?;
    let folder = match existing.clone() {
        Some(folder) => folder,
        None => canvas_folder::upsert_in(&tx, vault_id, canonical, None, device_id, now_ms)?,
    };
    tx.commit().map_err(failed)?;
    Ok(folder)
}

/// `relocateFolder`: moves the live folder `from` (a rename or a move) to
/// `to`, with every folder and canvas beneath it. A case-only rename keeps the
/// record; any other path is a new record and the old one is deleted, as the
/// id is the path. Refuses a move into its own subtree and onto a live folder.
pub fn relocate(
    conn: &Connection,
    vault_id: &str,
    from: &CanvasFolder,
    to: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Relocated, FolderWriteError> {
    if from.path == to {
        return Ok(Relocated {
            folder: from.clone(),
            canvases: Vec::new(),
        });
    }
    if canvas_path_key(&from.path) != canvas_path_key(to) {
        if is_descendant_folder(Some(to), Some(&from.path)) {
            return Err(CanvasFolderError::Descendant.into());
        }
        if canvas_folder::get(conn, to)?.is_some() {
            return Err(CanvasFolderError::Exists.into());
        }
    }
    let mut canvases = Vec::new();
    for (id, folder) in placements(conn, vault_id)? {
        if is_descendant_folder(folder.as_deref(), Some(&from.path)) {
            canvases.push((
                id,
                rewrite_folder_prefix(folder.as_deref(), &from.path, to)?,
            ));
        }
    }
    let mut folders = Vec::new();
    for folder in canvas_folder::list(conn)? {
        if is_descendant_folder(Some(&folder.path), Some(&from.path)) {
            let next = rewrite_folder_prefix(Some(&folder.path), &from.path, to)?
                .ok_or(CanvasFolderError::InvalidName)?;
            folders.push((folder, next));
        }
    }

    let tx = nested_tx::begin(conn).map_err(failed)?;
    for (id, folder) in &canvases {
        set_folder_in(&tx, id, folder.as_deref(), device_id, now_ms)?;
    }
    for (folder, next) in &folders {
        if canvas_folder::sync_id(next) != folder.id {
            canvas_folder::tombstone_in(&tx, &folder.id, device_id, now_ms)?;
        }
    }
    mint_ancestors(&tx, vault_id, to, device_id, now_ms)?;
    let mut target = None;
    for (folder, next) in &folders {
        let written = if canvas_folder::sync_id(next) == folder.id {
            respell(&tx, folder, next, device_id, now_ms)?
        } else {
            let icon = Some(folder.icon.as_deref());
            canvas_folder::upsert_in(&tx, vault_id, next, icon, device_id, now_ms)?
        };
        if folder.id == from.id {
            target = Some(written);
        }
    }
    let folder = target.ok_or_else(|| StorageError::NotFound {
        what: format!("no canvas folder {}", from.id),
    })?;
    tx.commit().map_err(failed)?;
    Ok(Relocated { folder, canvases })
}

/// `setCanvasFolderIcon`: `None` when no live folder has that path.
pub fn set_icon(
    conn: &Connection,
    vault_id: &str,
    canonical: &str,
    icon: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<Option<CanvasFolder>, StorageError> {
    let Some(folder) = canvas_folder::get(conn, canonical)? else {
        return Ok(None);
    };
    canvas_folder::upsert(conn, vault_id, &folder.path, Some(icon), device_id, now_ms).map(Some)
}

/// `deleteCanvasFolder`: deletes every canvas and folder at or beneath
/// `canonical` and writes a deleted record for each folder on the way that has
/// none, so a peer that holds only the directories drops them too. Returns
/// the ids of the deleted canvases.
pub fn delete(
    conn: &Connection,
    vault_id: &str,
    canonical: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<String>, StorageError> {
    let inside: Vec<(String, Option<String>)> = placements(conn, vault_id)?
        .into_iter()
        .filter(|(_, folder)| is_descendant_folder(folder.as_deref(), Some(canonical)))
        .collect();
    let folders: Vec<CanvasFolder> = canvas_folder::list(conn)?
        .into_iter()
        .filter(|folder| is_descendant_folder(Some(&folder.path), Some(canonical)))
        .collect();
    let stored = inside
        .iter()
        .filter_map(|(_, folder)| folder.as_deref())
        .chain(folders.iter().map(|folder| folder.path.as_str()));
    let implied = implied_paths(canonical, stored);

    let tx = nested_tx::begin(conn).map_err(failed)?;
    for (id, _) in &inside {
        tombstone_in(&tx, id, device_id, now_ms)?;
    }
    for folder in &folders {
        canvas_folder::tombstone_in(&tx, &folder.id, device_id, now_ms)?;
    }
    for path in &implied {
        canvas_folder::insert_if_absent_in(&tx, vault_id, path, true, device_id, now_ms)?;
    }
    tx.commit().map_err(failed)?;
    Ok(inside.into_iter().map(|(id, _)| id).collect())
}

/// `mintAncestorFolderRows`: a record for each proper ancestor of `path` that
/// has none. A deleted ancestor stays deleted, as in Electron.
fn mint_ancestors(
    tx: &Connection,
    vault_id: &str,
    path: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let segments = folder_segments(Some(path));
    for depth in 1..segments.len() {
        let ancestor = segments[..depth].join("/");
        canvas_folder::insert_if_absent_in(tx, vault_id, &ancestor, false, device_id, now_ms)?;
    }
    Ok(())
}

/// A case-only rename of one record: the path is rewritten in place.
fn respell(
    tx: &Connection,
    folder: &CanvasFolder,
    next: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<CanvasFolder, StorageError> {
    let stored = live(tx, canvas_folder::ITEM_TYPE, &folder.id, "canvas folder")?;
    let changes = vec![("path", Change::set(next))];
    desktop_records::edit(
        tx,
        canvas_folder::ITEM_TYPE,
        &folder.id,
        &stored,
        changes,
        device_id,
        now_ms,
    )?;
    outbox::enqueue(
        tx,
        &outbox::Change::upsert(canvas_folder::ITEM_TYPE, &folder.id),
        now_ms,
    )?;
    canvas_folder::get(tx, next)?.ok_or_else(|| StorageError::Failed {
        what: format!("canvas folder {} did not project", folder.id),
    })
}

/// `impliedFolderPaths`: `root` and every folder between it and each of
/// `stored`, once per case-insensitive path, first spelling kept.
fn implied_paths<'a>(root: &str, stored: impl Iterator<Item = &'a str>) -> Vec<String> {
    let root_segments = folder_segments(Some(root));
    let mut seen = std::collections::HashSet::new();
    let mut paths = Vec::new();
    let mut collect = |segments: &[&str]| {
        for depth in root_segments.len()..=segments.len() {
            let path = segments[..depth].join("/");
            if seen.insert(canvas_path_key(&path)) {
                paths.push(path);
            }
        }
    };
    collect(&root_segments);
    for folder in stored {
        let mut segments = root_segments.clone();
        segments.extend(
            folder_segments(Some(folder))
                .into_iter()
                .skip(root_segments.len()),
        );
        collect(&segments);
    }
    paths
}

#[cfg(test)]
mod tests;
