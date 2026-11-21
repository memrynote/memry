//! Path algebra for canvas folders: Electron's `canvas/folder-paths.ts`, rule
//! for rule.
//!
//! A canvas folder is a path relative to `<vault>/canvases`, always
//! forward-slashed (`Work/Q3`), with `None` meaning the root. No I/O: the store,
//! the sync apply and the file layer all need the same rules.
//!
//! Folders arrive from peers in canvas payloads, so the cleanup is total and
//! never yields a `.` or `..` segment for a later path join to act on.

use unicode_normalization::UnicodeNormalization;

use crate::api::errors::StorageError;

/// Deepest nesting a new canvas folder may reach (`MAX_CANVAS_FOLDER_DEPTH`).
/// The file layer's recursive walk stops at the same depth.
pub const MAX_CANVAS_FOLDER_DEPTH: usize = 8;

/// A folder a caller asked for that no canvas may be filed under. The message
/// names no folder, because it is user content and the message reaches the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CanvasFolderError {
    #[error("Canvas folders cannot nest deeper than 8 levels")]
    Depth,
    #[error("Canvas folder name cannot be empty")]
    InvalidName,
    /// `rewrite_folder_prefix` from the root, which would re-root every folder.
    #[error("Canvas folder rewrite needs a source folder")]
    NoSource,
    /// The destination is taken by a live folder or a directory.
    #[error("A canvas folder with that name already exists")]
    Exists,
    /// The move would nest a folder inside its own subtree.
    #[error("A canvas folder cannot be moved into its own descendant")]
    Descendant,
}

impl CanvasFolderError {
    /// Electron's `CanvasFolderErrorCode` (`canvas/folder-errors.ts`).
    pub fn code(self) -> &'static str {
        match self {
            Self::Depth => "CANVAS_FOLDER_DEPTH",
            Self::InvalidName | Self::NoSource => "CANVAS_FOLDER_INVALID_NAME",
            Self::Exists => "CANVAS_FOLDER_EXISTS",
            Self::Descendant => "CANVAS_FOLDER_DESCENDANT",
        }
    }
}

impl From<CanvasFolderError> for StorageError {
    fn from(error: CanvasFolderError) -> Self {
        Self::Invalid {
            what: format!("{}: {error}", error.code()),
        }
    }
}

/// Comparison key for "is this the same file or folder", never for opening one:
/// NFC, because macOS stores names decomposed, and lowercased, because macOS
/// and Windows default to case-insensitive filesystems.
pub fn canvas_path_key(relative_path: &str) -> String {
    relative_path.nfc().collect::<String>().to_lowercase()
}

/// The canonical form of a folder a caller asked for: `None` for the root,
/// otherwise slash-joined trimmed segments with `.`, `..` and empty ones
/// dropped. Refuses a folder deeper than [`MAX_CANVAS_FOLDER_DEPTH`].
pub fn normalize_folder(folder: Option<&str>) -> Result<Option<String>, CanvasFolderError> {
    let segments = folder_segments(folder);
    check_depth(segments.len())?;
    Ok(join(&segments))
}

/// [`normalize_folder`] for a folder already stored, which never fails: a row
/// filed past the cap by another device stays readable and movable, in full.
pub fn normalize_stored_folder(folder: Option<&str>) -> Option<String> {
    join(&folder_segments(folder))
}

/// The parts of a folder path, cleaned up as [`normalize_stored_folder`] does.
pub fn folder_segments(folder: Option<&str>) -> Vec<&str> {
    folder
        .unwrap_or_default()
        .split('/')
        .map(js_trim)
        .filter(|segment| !segment.is_empty() && *segment != "." && *segment != "..")
        .collect()
}

/// `name` as a child of `parent`. Refuses a name that cleans up to nothing and
/// a result past the depth cap.
pub fn join_folder(parent: Option<&str>, name: &str) -> Result<String, CanvasFolderError> {
    let base = normalize_folder(parent)?;
    let leaf = normalize_folder(Some(name))?.ok_or(CanvasFolderError::InvalidName)?;
    let joined = match base {
        Some(base) => format!("{base}/{leaf}"),
        None => leaf,
    };
    check_depth(joined.split('/').count())?;
    Ok(joined)
}

/// One level up, or `None` at or below the first level.
pub fn parent_folder(folder: Option<&str>) -> Option<String> {
    let segments = folder_segments(folder);
    join(&segments[..segments.len().saturating_sub(1)])
}

/// Whether `candidate` is `ancestor` or beneath it, segment by segment through
/// [`canvas_path_key`]. Every folder is beneath the root.
pub fn is_descendant_folder(candidate: Option<&str>, ancestor: Option<&str>) -> bool {
    let ancestor = folder_segments(ancestor);
    let candidate = folder_segments(candidate);
    candidate.len() >= ancestor.len()
        && ancestor
            .iter()
            .zip(&candidate)
            .all(|(a, c)| canvas_path_key(a) == canvas_path_key(c))
}

/// Re-roots `folder` from under `from` to under `to`. A folder outside `from`
/// comes back as stored. Refuses a root `from` and a result past the cap.
pub fn rewrite_folder_prefix(
    folder: Option<&str>,
    from: &str,
    to: &str,
) -> Result<Option<String>, CanvasFolderError> {
    let from_segments = folder_segments(Some(from));
    if from_segments.is_empty() {
        return Err(CanvasFolderError::NoSource);
    }
    if !is_descendant_folder(folder, Some(from)) {
        return Ok(normalize_stored_folder(folder));
    }
    let mut segments = folder_segments(Some(to));
    segments.extend_from_slice(&folder_segments(folder)[from_segments.len()..]);
    check_depth(segments.len())?;
    Ok(join(&segments))
}

fn check_depth(depth: usize) -> Result<(), CanvasFolderError> {
    if depth > MAX_CANVAS_FOLDER_DEPTH {
        return Err(CanvasFolderError::Depth);
    }
    Ok(())
}

fn join(segments: &[&str]) -> Option<String> {
    (!segments.is_empty()).then(|| segments.join("/"))
}

/// `String.prototype.trim`: ECMAScript white space and line terminators. Rust's
/// `trim` differs on two characters: it strips U+0085, which JavaScript keeps,
/// and keeps U+FEFF, which JavaScript strips.
pub(super) fn js_trim(segment: &str) -> &str {
    segment.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

#[cfg(test)]
mod tests;
