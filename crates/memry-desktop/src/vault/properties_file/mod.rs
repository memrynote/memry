//! `<vault>/.memry/properties.md`: the one owner of the property definitions file
//! (`PropertyDefinitionsService` file handling in `apps/desktop/src/main/vault/property-definitions.ts`).
//!
//! The file is shared with Electron builds and with older and newer builds of this app: YAML
//! frontmatter with one key, `properties`, a map from a property's name to its definition.
//! Every writer goes through [`update`]:
//!
//! - the file is read as gray-matter reads it, and each entry on its own, so an entry this
//!   build cannot read (a newer type, a hand edit gone wrong) is kept and written back as it
//!   is. A `relation` entry is dropped, as Electron drops it: older builds refuse the file on
//!   one;
//! - a file that exists but cannot be read is never replaced: not UTF-8, larger than
//!   [`MAX_PROPERTIES_BYTES`], frontmatter that does not parse, a `properties` that is not a
//!   map, or aliases that expand past the file's own size. The caller gets
//!   [`PropertiesFileError::Unreadable`], which Electron shows as [`UNREADABLE_KEY`]. Only a
//!   missing or empty file holds no definitions;
//! - the bytes are `matter.stringify('', { properties })`, Electron's: definitions in the
//!   file's order with a new one last, each in the shape of its type. A key inside a definition
//!   that no build's schema names, a top-level key beside `properties` and a body are not
//!   kept, as no Electron build keeps them;
//! - writes are serialized by one process-wide lock, and each reads the file again, so a
//!   definition another writer added meanwhile survives. Another process's write between our
//!   read and our rename stops ours ([`PropertiesFileError::Write`]) instead of being lost.
//!   The file is written only when the definitions changed or a `relation` entry went, and
//!   then only when its bytes change.
//!
//! Which definitions the app shows is the union of this file and the synced
//! `property_definition` items, the file winning for every name it lists (Step 13): its
//! caller reads with [`read`] and folds the rows in through [`update`].

mod model;

use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

pub use model::{
    Definitions, PropertiesFile, PropertyDefinition, PropertyKind, SelectOption, StatusCategories,
    StatusCategory, parse, steps,
};

use super::fs_atomic::{self, RETRY_DELAYS_MS};
use super::hash::content_hash;
use super::layout::MEMRY_DIR;
use super::note_file::{NoteFileError, still_contained, target, write_note_over};
use crate::shell::file_open::{LinkPolicy, open_under_root_with};

pub const PROPERTIES_FILE: &str = "properties.md";
/// The i18n key of the message for a write refused because the file cannot be read.
pub const UNREADABLE_KEY: &str = "errors:property.definitionsFileUnreadable";
/// A real file is a few kilobytes. Past this it is not read at all.
pub const MAX_PROPERTIES_BYTES: u64 = 4 * 1024 * 1024;

/// `<vault>/.memry/properties.md`, vault-relative with `/` separators.
const PROPERTIES_REL: &str = ".memry/properties.md";

#[derive(Debug, thiserror::Error)]
pub enum PropertiesFileError {
    /// The file exists but cannot be read. A write would replace what it could not parse, so
    /// it refuses. The message never holds file content.
    #[error("the property definitions file {path} cannot be read: {message}")]
    Unreadable { path: String, message: String },
    #[error("the property definitions file {path} cannot be written: {message}")]
    Write { path: String, message: String },
}

pub fn properties_path(vault: &Path) -> PathBuf {
    vault.join(MEMRY_DIR).join(PROPERTIES_FILE)
}

fn unreadable(vault: &Path, message: impl Into<String>) -> PropertiesFileError {
    PropertiesFileError::Unreadable {
        path: properties_path(vault).display().to_string(),
        message: message.into(),
    }
}

fn write_failed(vault: &Path, message: impl Into<String>) -> PropertiesFileError {
    PropertiesFileError::Write {
        path: properties_path(vault).display().to_string(),
        message: message.into(),
    }
}

/// The file's text, or `None` when there is no file.
fn load(vault: &Path) -> Result<Option<String>, PropertiesFileError> {
    let file = match open_under_root_with(vault, PROPERTIES_REL, LinkPolicy::Allow) {
        Ok(Some(file)) => file,
        Ok(None) => return Ok(None),
        Err(error) => return Err(unreadable(vault, error.to_string())),
    };
    let mut bytes = Vec::new();
    file.take(MAX_PROPERTIES_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| unreadable(vault, e.to_string()))?;
    if bytes.len() as u64 > MAX_PROPERTIES_BYTES {
        return Err(unreadable(
            vault,
            format!("larger than {MAX_PROPERTIES_BYTES} bytes"),
        ));
    }
    // Electron decodes bad bytes as U+FFFD, and its next write would keep only those.
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| unreadable(vault, "not valid UTF-8"))
}

fn parsed(vault: &Path, raw: &str) -> Result<PropertiesFile, PropertiesFileError> {
    parse(raw).map_err(|message| unreadable(vault, message))
}

/// What the file holds; no definitions when it is missing or empty. Runs the reader once:
/// call it on a blocking thread.
pub fn read(vault: &Path) -> Result<PropertiesFile, PropertiesFileError> {
    match load(vault)? {
        None => Ok(PropertiesFile::default()),
        Some(raw) => parsed(vault, &raw),
    }
}

/// Serializes every write of every vault's definitions file in this process.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Reads the file, lets `change` edit its definitions and writes it back. `change` runs under
/// the write lock on the file as it is now. A file that cannot be read is an error and stays
/// as it is; a missing one starts empty.
pub fn update<R>(
    vault: &Path,
    change: impl FnOnce(&mut Definitions) -> R,
) -> Result<R, PropertiesFileError> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let raw = load(vault)?;
    let mut file = match &raw {
        None => PropertiesFile::default(),
        Some(raw) => parsed(vault, raw)?,
    };
    let before = file.definitions.clone();
    let result = change(&mut file.definitions);
    if file.definitions == before && !file.healed() {
        return Ok(result);
    }
    let bytes = file
        .serialize()
        .map_err(|message| write_failed(vault, message))?;
    match raw {
        Some(raw) if raw == bytes => {}
        Some(raw) => write_note_over(vault, PROPERTIES_REL, &bytes, &content_hash(&raw))
            .map_err(|error| write_failed(vault, error.to_string()))?,
        None => create(vault, &bytes)?,
    }
    Ok(result)
}

/// Writes a new file; a file that appears meanwhile is never replaced.
fn create(vault: &Path, bytes: &str) -> Result<(), PropertiesFileError> {
    let (path, aimed_at) = target(vault, PROPERTIES_REL)
        .map_err(|error: NoteFileError| write_failed(vault, error.to_string()))?;
    let delays = RETRY_DELAYS_MS.map(Duration::from_millis);
    let mut between = || {};
    let mut check = still_contained(vault, PROPERTIES_REL, &path, aimed_at, &mut between);
    fs_atomic::atomic_create_checked(&path, bytes.as_bytes(), &delays, &mut check)
        .map_err(|error| write_failed(vault, error.source.to_string()))
}
