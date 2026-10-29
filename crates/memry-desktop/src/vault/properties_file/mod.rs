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
//!   [`MAX_PROPERTIES_BYTES`], frontmatter that does not parse or has no `properties` key (no
//!   frontmatter at all, a blank line before it), a `properties` that is not a map, or aliases
//!   that expand far past the file's own size. The caller gets
//!   [`PropertiesFileError::Unreadable`], which Electron shows as [`UNREADABLE_KEY`]. Only a
//!   missing or blank file, a frontmatter with nothing in it, or `properties:` with nothing
//!   under it, holds no definitions. Electron reads the files without `properties` as empty
//!   and its next write replaces them, so this is stricter: a file refused here is one
//!   Electron would have emptied;
//! - the bytes are `matter.stringify(body, { ...data, properties })`: definitions in the
//!   file's order with a new one last, each in the shape of its type, and the frontmatter's
//!   other keys and the body after it as the file holds them. For every file Electron writes
//!   (no other key, no body) these are Electron's bytes; Electron drops the rest, a hand edit
//!   such as a definition indented out of `properties`. A key inside a definition that no
//!   build's schema names is not kept, as no build keeps it;
//! - writes are serialized by one process-wide lock, and each reads the file again, so a
//!   definition another writer added meanwhile survives. Right before the rename the file is
//!   read again: another process's write since our read (any change of its bytes, whatever
//!   its size and modification time) stops ours ([`PropertiesFileError::Write`]) instead of
//!   being lost. That narrows the window to the rename itself; it does not close it. A read
//!   that fails for a moment (a Windows sharing violation) is retried as a write's rename is.
//!   The file is written only when the definitions changed or a `relation` entry went, and
//!   then only when its bytes change.
//!
//! Which definitions the app shows is the union of this file and the synced
//! `property_definition` items, the file winning for every name it lists (Step 13): its
//! caller reads with [`read`] and folds the rows in through [`update`]. Electron's reload also
//! writes the file back at once when it dropped a `relation` entry; the Step 13 open does the
//! same by calling [`update`] with a change that does nothing, which writes only then.
//!
//! A hard-linked file is read and replaced as Electron's `readFile` and `atomicWrite` do. The
//! read only takes definitions from it, and the replace renames a new file over the vault's
//! name, so the other name keeps its bytes and nothing outside the vault is written.

mod model;

use std::io::{self, Read as _};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

pub use model::{
    Definitions, PropertiesFile, PropertyDefinition, PropertyKind, SelectOption, StatusCategories,
    StatusCategory, parse, steps,
};

use super::fs_atomic::{self, RETRY_DELAYS_MS};
use super::layout::MEMRY_DIR;
use super::note_file::{NoteFileError, still_contained, target};
use crate::shell::file_open::{LinkPolicy, OpenError, open_under_root_with};

pub const PROPERTIES_FILE: &str = "properties.md";
/// The i18n key of the message for a write refused because the file cannot be read.
pub const UNREADABLE_KEY: &str = "errors:property.definitionsFileUnreadable";
/// A real file is a few kilobytes (24 status properties written by Electron take 1.7 KB). Past
/// this it is not read at all. Read whole, a file at the cap holds up to about 100 times its
/// size while it is read (`tests/properties_file_memory.rs`): about 100 MB here.
pub const MAX_PROPERTIES_BYTES: u64 = 1024 * 1024;

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

fn retry_delays() -> [Duration; 3] {
    RETRY_DELAYS_MS.map(Duration::from_millis)
}

/// The file's bytes, or `None` when there is none. An I/O error comes back as the system gave
/// it, so [`fs_atomic::with_transient_retry`] can tell one that passes.
fn load_bytes(vault: &Path) -> io::Result<Option<Vec<u8>>> {
    let file = match open_under_root_with(vault, PROPERTIES_REL, LinkPolicy::Allow) {
        Ok(Some(file)) => file,
        Ok(None) => return Ok(None),
        Err(OpenError::Io(error)) => return Err(error),
        Err(error) => return Err(io::Error::other(error.to_string())),
    };
    let mut bytes = Vec::new();
    file.take(MAX_PROPERTIES_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_PROPERTIES_BYTES {
        return Err(io::Error::other(format!(
            "larger than {MAX_PROPERTIES_BYTES} bytes"
        )));
    }
    Ok(Some(bytes))
}

/// The file's text, or `None` when there is no file.
fn load(vault: &Path) -> Result<Option<String>, PropertiesFileError> {
    let bytes = fs_atomic::with_transient_retry(&retry_delays(), || load_bytes(vault))
        .map_err(|error| unreadable(vault, error.to_string()))?;
    // Electron decodes bad bytes as U+FFFD, and its next write would keep only those.
    bytes
        .map(String::from_utf8)
        .transpose()
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
///
/// The lock is one process-wide mutex held across file IO: call this on a blocking thread,
/// never on the async runtime. `change` must not call [`update`] (the lock is not reentrant,
/// so that deadlocks) nor wait on another lock (the database, the config file), so no two
/// locks are ever taken in two orders: read what it needs before, and act on its result after.
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
        Some(raw) if raw == bytes => Ok(result),
        raw => write(vault, raw.as_deref(), &bytes).map(|()| result),
    }
}

/// Puts `bytes` in place of the file read as `read` (`None`: there was none). Right before the
/// rename the file is read again and compared byte for byte: a file another writer changed,
/// created or removed since is not written over.
fn write(vault: &Path, read: Option<&str>, bytes: &str) -> Result<(), PropertiesFileError> {
    let (path, aimed_at) = target(vault, PROPERTIES_REL)
        .map_err(|error: NoteFileError| write_failed(vault, error.to_string()))?;
    let delays = retry_delays();
    let mut between = || {};
    let mut contained = still_contained(vault, PROPERTIES_REL, &path, aimed_at, &mut between);
    // An error passes through as it came: a transient one retries the whole write.
    let mut unchanged = || {
        contained()?;
        if load_bytes(vault)?.as_deref() == read.map(str::as_bytes) {
            Ok(())
        } else {
            Err(io::Error::other(
                "another writer changed the file since it was read",
            ))
        }
    };
    let written = match read {
        Some(_) => {
            fs_atomic::atomic_replace_checked(&path, bytes.as_bytes(), &delays, &mut unchanged)
        }
        // Create-only as well: a file that appears after the check is still never replaced.
        None => fs_atomic::atomic_create_checked(&path, bytes.as_bytes(), &delays, &mut unchanged),
    };
    written.map_err(|error| write_failed(vault, error.source.to_string()))
}
