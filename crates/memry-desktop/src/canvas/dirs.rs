//! Canvas folder directories on disk (Electron's `canvas/scene-file.ts` and the directory walks
//! of `canvas/reconcile.ts`): the listing, the portable rename of a directory made outside the
//! app, and the two removals of an emptied folder's directory.
//!
//! Neither removal is recursive. A directory goes with `rmdir`, which refuses one holding
//! anything at all (a hidden file, a cloud client's staging folder, a document whose own delete
//! failed): what is still in there is the user's. Neither ever touches the `canvases` root or a
//! path that leaves it, and neither fails: a refused removal is retried by the next reconcile.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use memry_core::domain::canvas::folder_paths::MAX_CANVAS_FOLDER_DEPTH;

use super::scene_file::{portable_canvas_folder, resolve_canvas_file};
use crate::vault::fs_atomic::rename_no_replace;
use crate::vault::layout::CANVAS_DIR;

/// The absolute directory of a stored folder, or `None` for the `canvases` root and a path that
/// leaves it (`canvasFolderDirPath`). The stored path is used as it is, even past the depth cap.
fn canvas_folder_dir_path(vault: &Path, folder: &str) -> Option<PathBuf> {
    let absolute = resolve_canvas_file(vault, &format!("{CANVAS_DIR}/{folder}")).ok()?;
    (absolute != vault.join(CANVAS_DIR)).then_some(absolute)
}

/// `removeEmptyCanvasFolderDirs`: removes a folder's directory and every directory beneath it,
/// deepest first, each only once it is empty. Dot entries are not descended into. `true` when
/// the folder's own directory is gone afterwards.
pub fn remove_empty_canvas_folder_dirs(vault: &Path, folder: &str) -> bool {
    canvas_folder_dir_path(vault, folder).is_some_and(|dir| prune_empty_dirs(&dir, 0))
}

/// `removeCanvasFolderDirIfEmpty`: removes one folder's own directory when it is empty, without
/// descending: a directory beneath it may belong to a folder that is still live. `true` when it
/// is gone afterwards.
pub fn remove_canvas_folder_dir_if_empty(vault: &Path, folder: &str) -> bool {
    canvas_folder_dir_path(vault, folder).is_some_and(|dir| rmdir_if_empty(&dir))
}

fn prune_empty_dirs(dir: &Path, depth: usize) -> bool {
    if depth > MAX_CANVAS_FOLDER_DEPTH {
        return false;
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => return error.kind() == io::ErrorKind::NotFound,
    };
    for entry in entries.flatten() {
        let hidden = entry.file_name().to_string_lossy().starts_with('.');
        // `file_type` does not follow a link, so the prune never leaves the vault.
        if !hidden && entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            prune_empty_dirs(&entry.path(), depth + 1);
        }
    }
    rmdir_if_empty(dir)
}

fn rmdir_if_empty(dir: &Path) -> bool {
    match fs::remove_dir(dir) {
        Ok(()) => true,
        Err(error) if error.kind() == io::ErrorKind::NotFound => true,
        Err(error) => {
            // Not empty is the expected refusal. The kind only: folder names are user content.
            if !matches!(
                error.kind(),
                io::ErrorKind::DirectoryNotEmpty | io::ErrorKind::AlreadyExists
            ) {
                tracing::warn!(scope = "CanvasReconcile", kind = ?error.kind(), "could not remove an emptied canvas folder directory");
            }
            false
        }
    }
}

/// Every directory under `canvases/` as a folder path, sorted. Dot directories and links are
/// skipped, and the walk stops at the depth cap (`listCanvasFolderDirs`).
pub(super) fn list_canvas_folder_dirs(vault: &Path) -> Vec<String> {
    let mut found = Vec::new();
    walk_dirs(&vault.join(CANVAS_DIR), &mut Vec::new(), &mut |segments| {
        found.push(segments.join("/"));
        true
    });
    found.sort();
    found
}

/// Renames every directory under `canvases/` to its portable spelling, shallowest first, so
/// each stored folder is the on-disk one (`canonicalizeCanvasFolderDirs`). A taken name is
/// numbered (`Work 2`), never merged into; a refused rename leaves the directory as it is.
pub(super) fn canonicalize_canvas_folder_dirs(vault: &Path) {
    let root = vault.join(CANVAS_DIR);
    walk_dirs(&root, &mut Vec::new(), &mut |segments| {
        let parent = segments[..segments.len() - 1]
            .iter()
            .fold(root.clone(), |dir, segment| dir.join(segment));
        let name = segments.last().cloned().unwrap_or_default();
        // Descended under the name it has now.
        if let Some(last) = segments.last_mut() {
            *last = portable_name(&parent, &name);
        }
        true
    });
}

fn portable_name(parent: &Path, name: &str) -> String {
    // `None` for a name that clears to nothing: renaming it would invent a folder.
    let Ok(Some(canonical)) = portable_canvas_folder(Some(name)) else {
        return name.to_owned();
    };
    if canonical == name {
        return name.to_owned();
    }
    let mut target = canonical.clone();
    let mut counter = 1;
    while parent.join(&target).symlink_metadata().is_ok() {
        counter += 1;
        target = format!("{canonical} {counter}");
    }
    match rename_no_replace(&parent.join(name), &parent.join(&target)) {
        Ok(()) => target,
        Err(error) => {
            tracing::warn!(scope = "CanvasReconcile", kind = ?error.kind(), "could not rename a canvas folder to its portable name");
            name.to_owned()
        }
    }
}

/// Visits each directory below `dir`, parent first, with its segments; `visit` may rename the
/// last segment and returns whether to descend.
fn walk_dirs(
    dir: &Path,
    segments: &mut Vec<String>,
    visit: &mut dyn FnMut(&mut Vec<String>) -> bool,
) {
    if segments.len() >= MAX_CANVAS_FOLDER_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| !name.starts_with('.'))
        .collect();
    names.sort();
    for name in names {
        segments.push(name);
        if visit(segments) {
            let here = dir.join(segments.last().map_or("", String::as_str));
            walk_dirs(&here, segments, visit);
        }
        segments.pop();
    }
}
