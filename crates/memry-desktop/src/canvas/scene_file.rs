//! Canvas documents on disk (`canvas/scene-file.ts`): the portable name of a canvas file and
//! folder, path allocation, reading under the vault root, atomic writes, the listing walk and the
//! best-effort rename.
//!
//! Stored paths are vault-relative and always forward-slashed (`canvases/Work/Plan.excalidraw`),
//! so a vault copied between platforms opens; they are split on `/` and joined natively when
//! opened, and a path from another device's record that would leave the vault is refused.
//!
//! Departures from Electron, each so a user's document is never lost:
//! - a write states what it expects at the path ([`Expect`]): a new document never replaces a
//!   file that appeared meanwhile, and a save never replaces a file that changed on disk since
//!   the app read it. Electron overwrites both.
//! - a rename never replaces another document at the target; Electron's `renameSync` does.
//! - path allocation counts any entry at a candidate path as taken, a dangling link included.

use std::collections::HashSet;
use std::fs;
use std::io::{self, Read as _};
use std::path::{Path, PathBuf};
use std::time::Duration;

use memry_core::domain::canvas::folder_paths::{
    CanvasFolderError, MAX_CANVAS_FOLDER_DEPTH, canvas_path_key, folder_segments, normalize_folder,
};
use sha2::{Digest as _, Sha256};

use crate::shell::file_open::OpenError;
use crate::vault::fs_atomic::{self, RETRY_DELAYS_MS};
use crate::vault::layout::{CANVAS_DIR, CANVAS_FILE_EXT};
use crate::vault::paths::{is_js_space, open_vault_file, safe_join, sanitize_filename};

/// Excalidraw's own library format, so the file opens in excalidraw.com too.
pub const CANVAS_LIBRARY_FILE: &str = "library.excalidrawlib";

/// A stored path names a place outside the vault.
#[derive(Debug, thiserror::Error)]
#[error("a canvas path leaves the vault")]
pub struct PathEscapes;

/// A canvas document as read: its text and the sha256 of its bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasDocument {
    pub text: String,
    pub sha256: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ReadError {
    /// The document is a link out of the vault: never read, never written.
    #[error("the canvas document links outside the vault")]
    Outside,
    #[error("the canvas document cannot be read: {0}")]
    Unreadable(OpenError),
}

/// What a write expects to find at its path.
#[derive(Debug, Clone, Copy)]
pub enum Expect<'a> {
    /// Nothing: a new document.
    New,
    /// The document as read, by the sha256 of its bytes. A file changed or removed since is
    /// [`WriteError::Changed`], checked right before the new file takes its place.
    Unchanged(&'a str),
    /// Anything: the new document replaces whatever is there.
    Any,
}

/// Why a write did not happen. Messages name no path: a path is title-derived user content.
#[derive(Debug, thiserror::Error)]
pub enum WriteError {
    #[error(transparent)]
    Escapes(#[from] PathEscapes),
    /// [`Expect::New`] found a file there.
    #[error("a canvas document already exists there")]
    Exists,
    /// [`Expect::Unchanged`] found the document changed or gone.
    #[error("the canvas document changed on disk since it was read")]
    Changed,
    /// The document as it is could not be read to compare with.
    #[error("the canvas document cannot be read: {0}")]
    Unreadable(OpenError),
    #[error("the canvas document could not be written ({:?})", .0.kind())]
    Io(io::Error),
}

/// The absolute path of a stored canvas path (`resolveCanvasFile`).
pub fn resolve_canvas_file(vault: &Path, relative: &str) -> Result<PathBuf, PathEscapes> {
    let segments: Vec<&str> = relative
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect();
    if segments.contains(&"..") {
        return Err(PathEscapes);
    }
    safe_join(vault, &segments).ok_or(PathEscapes)
}

/// The folder a stored canvas path sits in, `None` for the canvases root (`folderOfCanvasPath`).
pub fn folder_of_canvas_path(relative: &str) -> Option<String> {
    let segments: Vec<&str> = relative.split('/').filter(|s| !s.is_empty()).collect();
    let folder = segments.get(1..segments.len().saturating_sub(1))?;
    (!folder.is_empty()).then(|| folder.join("/"))
}

/// The on-disk spelling of a canvas folder (`portableCanvasFolder`): each segment cleared like a
/// file name. Refused past the depth cap. Idempotent.
pub fn portable_canvas_folder(folder: Option<&str>) -> Result<Option<String>, CanvasFolderError> {
    let normalized = normalize_folder(folder)?;
    let segments: Vec<String> = folder_segments(normalized.as_deref())
        .into_iter()
        .map(|segment| portable_canvas_base(Some(segment)))
        .collect();
    Ok((!segments.is_empty()).then(|| segments.join("/")))
}

/// A vault-relative path for a canvas titled `title` in `folder`, numbered past every path on
/// disk and in `taken` (paths claimed earlier in one batch), compared case- and
/// normalization-insensitively. `current`, the canvas's own path, never collides, so a
/// case-only title change keeps its file (`allocateCanvasPath`). The folder of the result is
/// the one to store ([`folder_of_canvas_path`]): `CON` lands in `CON canvas`.
pub fn allocate_canvas_path(
    vault: &Path,
    title: Option<&str>,
    taken: &HashSet<String>,
    current: Option<&str>,
    folder: Option<&str>,
) -> Result<String, CanvasFolderError> {
    let base = portable_canvas_base(title);
    let folder = portable_canvas_folder(folder)?;
    let claimed: HashSet<String> = taken.iter().map(|path| canvas_path_key(path)).collect();
    let own = current.map(canvas_path_key);
    let in_folder = |name: &str| match &folder {
        Some(folder) => format!("{CANVAS_DIR}/{folder}/{name}{CANVAS_FILE_EXT}"),
        None => format!("{CANVAS_DIR}/{name}{CANVAS_FILE_EXT}"),
    };
    let mut candidate = in_folder(&base);
    let mut counter = 1;
    while own.as_deref() != Some(canvas_path_key(&candidate).as_str())
        && (claimed.contains(&canvas_path_key(&candidate)) || is_taken(vault, &candidate))
    {
        counter += 1;
        candidate = in_folder(&format!("{base} {counter}"));
    }
    Ok(candidate)
}

fn is_taken(vault: &Path, relative: &str) -> bool {
    resolve_canvas_file(vault, relative).is_ok_and(|path| fs::symlink_metadata(path).is_ok())
}

/// `portableCanvasBase`: a file name every platform takes. Trailing dots and spaces go (Win32
/// trims them, so `Plan.` and `Plan` would be one file), and a Windows device name gets a
/// ` canvas` suffix.
fn portable_canvas_base(title: Option<&str>) -> String {
    let title = title
        .map(|title| title.trim_matches(is_js_space))
        .unwrap_or("");
    let sanitized = sanitize_filename(if title.is_empty() { "Canvas" } else { title });
    let base = sanitized.trim_end_matches(['.', ' ']);
    match base {
        "" => "Canvas".to_owned(),
        base if is_reserved_name(base) => format!("{base} canvas"),
        base => base.to_owned(),
    }
}

/// `WINDOWS_RESERVED_NAMES` of `scene-file.ts`, which counts `COM0` and `LPT0` too.
fn is_reserved_name(base: &str) -> bool {
    let lower = base.to_ascii_lowercase();
    if matches!(lower.as_str(), "con" | "prn" | "aux" | "nul") {
        return true;
    }
    ["com", "lpt"].iter().any(|device| {
        lower.strip_prefix(device).is_some_and(|rest| {
            let mut chars = rest.chars();
            matches!((chars.next(), chars.next()), (Some(c), None) if c.is_ascii_digit() || matches!(c, '\u{b9}' | '\u{b2}' | '\u{b3}'))
        })
    })
}

/// A canvas document, or `None` when nothing readable is at `relative` (missing, or a folder in
/// its place). Read through the opened file, so a link out of the vault is
/// [`ReadError::Outside`] and nothing is read from it.
pub fn read_canvas_file(vault: &Path, relative: &str) -> Result<Option<CanvasDocument>, ReadError> {
    if resolve_canvas_file(vault, relative).is_err() {
        return Err(ReadError::Unreadable(OpenError::Outside));
    }
    let delays = RETRY_DELAYS_MS.map(Duration::from_millis);
    let mut bytes = Vec::new();
    let opened = fs_atomic::with_transient_retry(&delays, || {
        bytes.clear();
        match open_vault_file(vault, relative) {
            Ok(Some(mut file)) => file.read_to_end(&mut bytes).map(|_| Ok(true)),
            Ok(None) => Ok(Ok(false)),
            Err(OpenError::Io(error)) => Err(error),
            Err(other) => Ok(Err(other)),
        }
    });
    match opened {
        Ok(Ok(true)) => Ok(Some(document(bytes))),
        Ok(Ok(false) | Err(OpenError::NotRegular)) => Ok(None),
        Ok(Err(OpenError::Outside)) => Err(ReadError::Outside),
        Ok(Err(other)) => Err(ReadError::Unreadable(other)),
        Err(error) if is_absent(&error) => Ok(None),
        Err(error) => Err(ReadError::Unreadable(OpenError::Io(error))),
    }
}

/// ENOENT, ENOTDIR and EISDIR: the path names no document now.
fn is_absent(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory | io::ErrorKind::IsADirectory
    )
}

fn document(bytes: Vec<u8>) -> CanvasDocument {
    let sha256 = sha256_hex(&bytes);
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) => String::from_utf8_lossy(error.as_bytes()).into_owned(),
    };
    CanvasDocument { text, sha256 }
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Marks the check of [`Expect::Unchanged`] failing inside the atomic write.
#[derive(Debug, thiserror::Error)]
#[error("changed since it was read")]
struct ChangedOnDisk;

/// Writes `text` at `relative` atomically (temp file, then rename), as `expect` allows, and
/// returns the sha256 of what it wrote. Missing folders are made, except for a save over a
/// document as read, whose folder moving away fails the save.
pub fn write_canvas_file(
    vault: &Path,
    relative: &str,
    text: &str,
    expect: Expect<'_>,
) -> Result<String, WriteError> {
    let target = resolve_canvas_file(vault, relative)?;
    let delays = RETRY_DELAYS_MS.map(Duration::from_millis);
    let bytes = text.as_bytes();
    let written = match expect {
        Expect::New => fs_atomic::atomic_create_checked(&target, bytes, &delays, &mut || Ok(())),
        Expect::Any => fs_atomic::atomic_write_with(&target, bytes, &delays),
        Expect::Unchanged(sha256) => {
            let mut unchanged = || match read_canvas_file(vault, relative) {
                Ok(Some(document)) if document.sha256 == sha256 => Ok(()),
                Ok(_) => Err(io::Error::other(ChangedOnDisk)),
                Err(error) => Err(io::Error::other(error)),
            };
            fs_atomic::atomic_replace_checked(&target, bytes, &delays, &mut unchanged)
        }
    };
    match written {
        Ok(()) => Ok(sha256_hex(bytes)),
        Err(error) if error.already_exists() && matches!(expect, Expect::New) => {
            Err(WriteError::Exists)
        }
        Err(error) => Err(write_failure(error.source, expect)),
    }
}

/// What a failed atomic write means for the caller.
fn write_failure(error: io::Error, expect: Expect<'_>) -> WriteError {
    // A save over a document whose folder went away: the document is gone, not unwritable.
    let gone = matches!(expect, Expect::Unchanged(_)) && error.kind() == io::ErrorKind::NotFound;
    if gone
        || error
            .get_ref()
            .is_some_and(|inner| inner.is::<ChangedOnDisk>())
    {
        return WriteError::Changed;
    }
    if error.get_ref().is_some_and(|inner| inner.is::<ReadError>()) {
        let read = error
            .into_inner()
            .and_then(|inner| inner.downcast::<ReadError>().ok());
        return match read.map(|read| *read) {
            Some(ReadError::Unreadable(open)) => WriteError::Unreadable(open),
            _ => WriteError::Unreadable(OpenError::Outside),
        };
    }
    WriteError::Io(error)
}

/// Every canvas document's vault-relative path, sorted. Dot entries are skipped (a cloud
/// client's staging area), links are not followed, and the walk stops past the folder depth
/// cap, as creating a folder does (`listCanvasFiles`).
pub fn list_canvas_files(vault: &Path) -> Vec<String> {
    let mut found = Vec::new();
    walk(&vault.join(CANVAS_DIR), &mut Vec::new(), &mut found);
    found.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    found
}

fn walk(dir: &Path, segments: &mut Vec<String>, found: &mut Vec<String>) {
    if segments.len() > MAX_CANVAS_FOLDER_DEPTH {
        // The depth only: the segments are title-derived.
        tracing::warn!(
            scope = "CanvasSceneFile",
            depth = segments.len(),
            "skipping canvases nested deeper than {MAX_CANVAS_FOLDER_DEPTH} folders; they cannot be opened in the app"
        );
        return;
    }
    // An unreadable folder must not take the whole listing down.
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            tracing::warn!(
                scope = "CanvasSceneFile",
                "skipping a canvas entry whose name is not UTF-8"
            );
            continue;
        };
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        if kind.is_dir() {
            segments.push(name);
            walk(&entry.path(), segments, found);
            segments.pop();
        } else if kind.is_file() && name.to_lowercase().ends_with(CANVAS_FILE_EXT) {
            let mut path = vec![CANVAS_DIR.to_owned()];
            path.extend(segments.iter().cloned());
            path.push(name);
            found.push(path.join("/"));
        }
    }
}

/// Moves a canvas document after a title or folder change and returns where it is: the old path
/// when it cannot move, so the file is never lost (`renameCanvasFile`). Another document at the
/// target is never replaced; a case- or normalization-only change of the document's own name
/// renames in place.
pub fn rename_canvas_file(vault: &Path, from: &str, to: &str) -> String {
    if from == to {
        return from.to_owned();
    }
    match try_rename(vault, from, to) {
        Ok(()) => to.to_owned(),
        Err(error) => {
            tracing::warn!(scope = "CanvasSceneFile", kind = ?error.kind(), "could not rename canvas file; keeping the previous path");
            from.to_owned()
        }
    }
}

fn try_rename(vault: &Path, from: &str, to: &str) -> io::Result<()> {
    let escapes = |_| io::Error::new(io::ErrorKind::InvalidInput, PathEscapes);
    let from_abs = resolve_canvas_file(vault, from).map_err(escapes)?;
    let to_abs = resolve_canvas_file(vault, to).map_err(escapes)?;
    let parent = to_abs.parent().unwrap_or(vault);
    fs::create_dir_all(parent)?;
    let delays = RETRY_DELAYS_MS.map(Duration::from_millis);
    let own_name = canvas_path_key(from) == canvas_path_key(to) && !holds_exact_name(&to_abs);
    fs_atomic::with_transient_retry(&delays, || {
        if own_name {
            fs::rename(&from_abs, &to_abs)
        } else {
            fs_atomic::rename_no_replace(&from_abs, &to_abs)
        }
    })
}

/// Whether the folder lists an entry spelled exactly like `path`'s name. A case-insensitive
/// volume answers a lookup of `plan` with `Plan`, so only the listing tells a second document
/// from the document's own differently cased name.
fn holds_exact_name(path: &Path) -> bool {
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return false;
    };
    fs::read_dir(parent)
        .map(|entries| entries.flatten().any(|entry| entry.file_name() == name))
        .unwrap_or(false)
}
