//! The vault's Excalidraw library (shapes panel) as one plain file,
//! `canvases/library.excalidrawlib` (`canvas/library-file.ts`). Library items do not sync, so
//! the file is the only store.

use std::path::Path;

use memry_core::domain::canvas::file_format::{library_items, library_text};
use serde_json::Value;

use super::scene_file::{
    CANVAS_LIBRARY_FILE, CanvasDocument, Expect, ReadError, WriteError, read_canvas_file,
    write_canvas_file,
};
use crate::vault::layout::CANVAS_DIR;

fn library_path() -> String {
    format!("{CANVAS_DIR}/{CANVAS_LIBRARY_FILE}")
}

/// Every library item. A missing, malformed or outside-linked file is an empty panel: a broken
/// library never takes the canvas surface down (`readCanvasLibrary`).
pub fn read_canvas_library(vault: &Path) -> Result<Vec<Value>, ReadError> {
    let document = match read_library(vault) {
        Ok(Some(document)) => document,
        Ok(None) | Err(ReadError::Outside) => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    Ok(library_items(&document.text).unwrap_or_else(|| {
        // The next save replaces the corrupt file with the list the panel holds.
        tracing::error!(
            scope = "CanvasLibraryFile",
            "canvas library file is not readable JSON; showing an empty panel"
        );
        Vec::new()
    }))
}

/// Writes the full list Excalidraw handed over; `false` when the file already holds it or links
/// outside the vault, which is the user's to keep (`writeCanvasLibrary`). A file changed on disk
/// since it was read here is never replaced.
pub fn write_canvas_library(vault: &Path, items: &[Value]) -> Result<bool, WriteError> {
    let next = library_text(items);
    let current = match read_library(vault) {
        Ok(current) => current,
        Err(ReadError::Outside) => return Ok(false),
        Err(ReadError::Unreadable(error)) => return Err(WriteError::Unreadable(error)),
    };
    let expect = match &current {
        Some(document) if document.text == next => return Ok(false),
        Some(document) => Expect::Unchanged(&document.sha256),
        None => Expect::New,
    };
    write_canvas_file(vault, &library_path(), &next, expect)?;
    Ok(true)
}

/// The library file, `None` when there is none. A link outside the vault is logged here.
fn read_library(vault: &Path) -> Result<Option<CanvasDocument>, ReadError> {
    match read_canvas_file(vault, &library_path()) {
        Err(ReadError::Outside) => {
            tracing::warn!(
                scope = "CanvasLibraryFile",
                "canvas library file links outside the vault; it is neither read nor saved"
            );
            Err(ReadError::Outside)
        }
        other => other,
    }
}
