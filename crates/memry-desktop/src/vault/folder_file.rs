//! `<folder>/.folder.md`: the one owner of a folder's settings file (`readFolderConfig`,
//! `writeFolderConfig` of `apps/desktop/src/main/vault/folders.ts`).
//!
//! The file is shared with Electron builds and with older and newer builds of this app, and the
//! folder views (Step 30) keep their views in it too. YAML frontmatter, read as gray-matter
//! reads it:
//!
//! - `icon` and `template` are strings, `inherit` is true unless it is `false`, `views` is a
//!   list, and `formulas`, `properties` and `summaries` are objects (a list too, as JavaScript
//!   counts one); a key of another type reads as absent ([`FolderFile::config`]);
//! - a file that cannot be read is never replaced: not UTF-8, larger than
//!   [`MAX_FOLDER_FILE_BYTES`], frontmatter that does not parse or is not a map, or aliases
//!   that expand past [`node_budget`]. Electron reads the first ones as no file and its next
//!   write replaces them, the folder's saved views with them (#720); here the write refuses
//!   ([`FolderFileError::Unreadable`]);
//! - the bytes are `matter.stringify('', config)` with the modelled keys in Electron's order
//!   (`icon`, `template`, `inherit: false`, `views`, `formulas`, `properties`, `summaries`),
//!   each only when it says something. For every file Electron writes these are its bytes
//!   (`tests/fixtures/electron-vault/folder-md.json`). Two things Electron drops are kept, for
//!   the newer build or the person that wrote them: keys no build here models, after the
//!   modelled ones, and text after the frontmatter;
//! - a file left with nothing to say is removed, as Electron removes it; one whose bytes would
//!   not change is not written.
//!
//! Writes are serialized by one process-wide lock and each reads the file again under it, so
//! two edits of one folder never lose each other. The vault watcher ignores dot files, so the
//! own-write record is not told.

use std::io::{self, Read as _};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use memry_core::markdown::frontmatter::{
    Eol, YamlMap, YamlValue, gray_matter_data, gray_matter_parts, stringify_frontmatter_block,
    yaml_to_json,
};
use serde_json::Value;

use super::fs_atomic::{self, RETRY_DELAYS_MS};
use super::note_file::{NoteFileError, still_contained, target};
use crate::shell::file_open::{LinkPolicy, OpenError, is_plain_relative, open_under_root_with};

const SCOPE: &str = "folder_file";

pub const FOLDER_FILE: &str = ".folder.md";
/// A real file is a few hundred bytes, a folder with many saved views a few kilobytes. Past
/// this it is not read, and a write refuses it.
pub const MAX_FOLDER_FILE_BYTES: u64 = 256 * 1024;
/// The deepest value a file may hold; the YAML dumper refuses deeper ones too.
const MAX_DEPTH: usize = 256;

const ICON: &str = "icon";
const TEMPLATE: &str = "template";
const INHERIT: &str = "inherit";
const VIEWS: &str = "views";
/// The keys holding an object, in the order Electron writes them, after `views`.
const OBJECTS: [&str; 3] = ["formulas", "properties", "summaries"];

#[derive(Debug, thiserror::Error)]
pub enum FolderFileError {
    /// The file is there and cannot be read; a write would replace it, so it refuses. The
    /// message holds no file content.
    #[error("the folder's settings file {path} cannot be read: {message}")]
    Unreadable { path: String, message: String },
    #[error("the folder's settings file {path} cannot be written: {message}")]
    Write { path: String, message: String },
}

/// A folder's settings as the renderer reads them (`FolderConfig` of `@memry/rpc/notes`).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderConfigView {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub template: Option<String>,
    pub inherit: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub views: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub formulas: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub properties: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub summaries: Option<Value>,
}

/// A `.folder.md` as read: its frontmatter keys in the file's order, and the text after them.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FolderFile {
    data: YamlMap,
    body: String,
}

impl FolderFile {
    fn text(&self, key: &str) -> Option<&str> {
        match self.data.get(key) {
            Some(YamlValue::String(text)) => Some(text),
            _ => None,
        }
    }

    pub fn icon(&self) -> Option<&str> {
        self.text(ICON)
    }

    pub fn template(&self) -> Option<&str> {
        self.text(TEMPLATE)
    }

    /// `data.inherit !== false`.
    pub fn inherit(&self) -> bool {
        self.data.get(INHERIT) != Some(&YamlValue::Bool(false))
    }

    /// `data.views` when it is a list.
    fn views(&self) -> Option<&YamlValue> {
        self.data
            .get(VIEWS)
            .filter(|v| matches!(v, YamlValue::Seq(_)))
    }

    /// `data[key]` when it is a truthy object: a map, a list, a date or bytes.
    fn object(&self, key: &str) -> Option<&YamlValue> {
        self.data.get(key).filter(|v| {
            matches!(
                v,
                YamlValue::Map(_) | YamlValue::Seq(_) | YamlValue::Date(_) | YamlValue::Binary(_)
            )
        })
    }

    /// What `parseFolderConfig` returns. A date or bytes, which JavaScript hands on as objects
    /// and JSON cannot hold, reads as absent.
    pub fn config(&self) -> FolderConfigView {
        let json = |value: Option<&YamlValue>| value.and_then(yaml_to_json);
        FolderConfigView {
            icon: self.icon().map(str::to_owned),
            template: self.template().map(str::to_owned),
            inherit: self.inherit(),
            views: json(self.views()),
            formulas: json(self.object(OBJECTS[0])),
            properties: json(self.object(OBJECTS[1])),
            summaries: json(self.object(OBJECTS[2])),
        }
    }

    /// `notes:set-folder-config`: the icon, the template and `inherit` as given; the views,
    /// formulas, properties and summaries stay as the file holds them.
    pub fn set(&mut self, icon: Option<&str>, template: Option<&str>, inherit: bool) {
        let mut put = |key: &str, value: Option<YamlValue>| match value {
            Some(value) => self.data.insert(key.to_owned(), value),
            None => {
                self.data.remove(key);
            }
        };
        put(ICON, icon.map(|icon| YamlValue::String(icon.to_owned())));
        put(TEMPLATE, template.map(|t| YamlValue::String(t.to_owned())));
        put(INHERIT, (!inherit).then_some(YamlValue::Bool(false)));
    }

    /// The bytes `writeFolderConfig` writes for this config, or `None` when it would remove the
    /// file. Keys no build models follow the modelled ones; text after the frontmatter stays.
    pub fn serialize(&self) -> Result<Option<String>, String> {
        let mut out = YamlMap::new();
        let non_empty = |v: &YamlValue| match v {
            YamlValue::Map(map) => !map.is_empty(),
            YamlValue::Seq(items) => !items.is_empty(),
            YamlValue::Binary(bytes) => !bytes.is_empty(),
            _ => false,
        };
        let modelled = [
            (
                ICON,
                self.data
                    .get(ICON)
                    .filter(|_| !self.icon().unwrap_or("").is_empty()),
            ),
            (
                TEMPLATE,
                self.data
                    .get(TEMPLATE)
                    .filter(|_| !self.template().unwrap_or("").is_empty()),
            ),
            (INHERIT, self.data.get(INHERIT).filter(|_| !self.inherit())),
            (VIEWS, self.views().filter(|v| non_empty(v))),
            (OBJECTS[0], self.object(OBJECTS[0]).filter(|v| non_empty(v))),
            (OBJECTS[1], self.object(OBJECTS[1]).filter(|v| non_empty(v))),
            (OBJECTS[2], self.object(OBJECTS[2]).filter(|v| non_empty(v))),
        ];
        for (key, value) in modelled {
            if let Some(value) = value {
                out.insert(key.to_owned(), value.clone());
            }
        }
        for (key, value) in self.data.iter() {
            if ![ICON, TEMPLATE, INHERIT, VIEWS].contains(&key) && !OBJECTS.contains(&key) {
                out.insert(key.to_owned(), value.clone());
            }
        }
        if out.is_empty() && self.body.trim().is_empty() {
            return Ok(None);
        }
        let block = stringify_frontmatter_block(&out, Eol::Lf).map_err(|e| e.to_string())?;
        // gray-matter's `newline(body)`: an empty body is one line break.
        let end = if self.body.ends_with('\n') { "" } else { "\n" };
        Ok(Some(block + &self.body + end))
    }
}

/// Values a file may hold, counted with every alias expanded: eight per byte and 64, the
/// bound of every reader of vault files (`memry-test-kit`'s `output_bound`).
pub fn node_budget(len: usize) -> usize {
    len.saturating_mul(8).saturating_add(64)
}

/// `raw` as a `.folder.md`, or why it cannot be read.
pub fn parse(raw: &str) -> Result<FolderFile, String> {
    let text = raw.strip_prefix('\u{FEFF}').unwrap_or(raw);
    let Some((_, body)) = gray_matter_parts(text) else {
        return Ok(FolderFile {
            data: YamlMap::new(),
            body: text.to_owned(),
        });
    };
    let data =
        gray_matter_data(text).map_err(|e| format!("its frontmatter does not parse: {e}"))?;
    let YamlValue::Map(data) = data else {
        return Err("its frontmatter is not a map".to_owned());
    };
    check_size(&data, node_budget(raw.len()))?;
    Ok(FolderFile {
        data: (*data).clone(),
        body: body.to_owned(),
    })
}

/// Walks every value, aliases expanded, on a stack of its own: refuses more than `budget`
/// values or a value deeper than [`MAX_DEPTH`], so reading it as JSON or writing it back stays
/// bounded by the file's size.
fn check_size(data: &YamlMap, budget: usize) -> Result<(), String> {
    let mut stack: Vec<(&YamlValue, usize)> = data.iter().map(|(_, v)| (v, 1)).collect();
    let mut visited = 0usize;
    while let Some((value, depth)) = stack.pop() {
        visited += 1;
        STEPS.with(|steps| steps.set(steps.get() + 1));
        if visited > budget {
            return Err("its aliases expand past the file's own size".to_owned());
        }
        if depth > MAX_DEPTH {
            return Err(format!("it nests deeper than {MAX_DEPTH} levels"));
        }
        match value {
            YamlValue::Seq(items) => stack.extend(items.iter().map(|v| (v, depth + 1))),
            YamlValue::Map(map) => stack.extend(map.iter().map(|(_, v)| (v, depth + 1))),
            _ => {}
        }
    }
    Ok(())
}

thread_local! {
    static STEPS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Values [`parse`] visited on this thread, for tests that bound it.
#[doc(hidden)]
pub fn steps() -> usize {
    STEPS.with(std::cell::Cell::get)
}

/// The vault-relative path of `folder`'s file (`""` is the vault root).
fn rel_of(folder: &str) -> Result<String, NoteFileError> {
    if folder.is_empty() {
        return Ok(FOLDER_FILE.to_owned());
    }
    if !is_plain_relative(folder) {
        return Err(OpenError::Outside.into());
    }
    Ok(format!("{folder}/{FOLDER_FILE}"))
}

fn delays() -> [Duration; 3] {
    RETRY_DELAYS_MS.map(Duration::from_millis)
}

fn unreadable(rel: &str, message: impl Into<String>) -> FolderFileError {
    FolderFileError::Unreadable {
        path: rel.to_owned(),
        message: message.into(),
    }
}

fn write_failed(rel: &str, message: impl Into<String>) -> FolderFileError {
    FolderFileError::Write {
        path: rel.to_owned(),
        message: message.into(),
    }
}

/// The file's bytes, `None` when there is none.
fn load_bytes(vault: &Path, rel: &str) -> io::Result<Option<Vec<u8>>> {
    let file = match open_under_root_with(vault, rel, LinkPolicy::Allow) {
        Ok(Some(file)) => file,
        Ok(None) => return Ok(None),
        Err(OpenError::Io(error)) => return Err(error),
        Err(error) => return Err(io::Error::other(error.to_string())),
    };
    let mut bytes = Vec::new();
    file.take(MAX_FOLDER_FILE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FOLDER_FILE_BYTES {
        return Err(io::Error::other(format!(
            "larger than {MAX_FOLDER_FILE_BYTES} bytes"
        )));
    }
    Ok(Some(bytes))
}

fn load(vault: &Path, rel: &str) -> Result<Option<String>, FolderFileError> {
    let bytes = fs_atomic::with_transient_retry(&delays(), || load_bytes(vault, rel))
        .map_err(|error| unreadable(rel, error.to_string()))?;
    bytes
        .map(String::from_utf8)
        .transpose()
        .map_err(|_| unreadable(rel, "not valid UTF-8"))
}

/// `folder`'s file (`""`: the vault root's), `None` when there is none. Blocks: call it on a
/// blocking thread.
pub fn read(vault: &Path, folder: &str) -> Result<Option<FolderFile>, FolderFileError> {
    let rel = rel_of(folder).map_err(|error| unreadable(folder, error.to_string()))?;
    match load(vault, &rel)? {
        None => Ok(None),
        Some(raw) => parse(&raw)
            .map(Some)
            .map_err(|message| unreadable(&rel, message)),
    }
}

static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Reads `folder`'s file, lets `change` edit it and writes it back, creating the folder as
/// `writeFolderConfig` does. A file that cannot be read stays as it is and is an error; a
/// missing one starts empty. Answers the file as written.
///
/// Holds a process-wide lock across file IO: call it on a blocking thread. `change` must not
/// call [`update`] (the lock is not reentrant) nor wait on another lock.
pub fn update(
    vault: &Path,
    folder: &str,
    change: impl FnOnce(&mut FolderFile),
) -> Result<FolderFile, FolderFileError> {
    let rel = rel_of(folder).map_err(|error| write_failed(folder, error.to_string()))?;
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let raw = load(vault, &rel)?;
    let mut file = match &raw {
        None => FolderFile::default(),
        Some(raw) => parse(raw).map_err(|message| unreadable(&rel, message))?,
    };
    change(&mut file);
    let bytes = file
        .serialize()
        .map_err(|message| write_failed(&rel, message))?;
    if bytes.as_deref() == raw.as_deref() {
        return Ok(file);
    }
    let (path, aimed_at) = target(vault, &rel).map_err(|e| write_failed(&rel, e.to_string()))?;
    let Some(bytes) = bytes else {
        if raw.is_some() {
            fs_atomic::with_transient_retry(&delays(), || match std::fs::remove_file(&path) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                other => other,
            })
            .map_err(|error| write_failed(&rel, error.to_string()))?;
        }
        return Ok(file);
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|error| write_failed(&rel, error.to_string()))?;
    }
    let mut between = || {};
    let mut contained = still_contained(vault, &rel, &path, aimed_at, &mut between);
    let mut unchanged = || {
        contained()?;
        let now = load_bytes(vault, &rel)?;
        if now.as_deref() == raw.as_deref().map(str::as_bytes) {
            Ok(())
        } else {
            Err(io::Error::other(
                "another writer changed the file since it was read",
            ))
        }
    };
    let written = match raw {
        Some(_) => {
            fs_atomic::atomic_replace_checked(&path, bytes.as_bytes(), &delays(), &mut unchanged)
        }
        None => {
            fs_atomic::atomic_create_checked(&path, bytes.as_bytes(), &delays(), &mut unchanged)
        }
    };
    written.map_err(|error| write_failed(&rel, error.source.to_string()))?;
    Ok(file)
}

/// `getFolderTemplate`: the template `folder` gives a new note, from its own file or the
/// nearest folder above it, up to the vault root's, that names one; none past a file with
/// `inherit: false`. A file that cannot be read names none and is passed, as Electron's
/// `readFolderConfig` reads it as no file; the failure is logged.
pub fn template_of(vault: &Path, folder: &str) -> Option<String> {
    let mut current = match folder {
        "." => "",
        folder => folder,
    };
    loop {
        match read(vault, current) {
            Ok(Some(file)) => {
                if let Some(template) = file.template() {
                    return Some(template.to_owned());
                }
                if !file.inherit() {
                    return None;
                }
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(scope = SCOPE, "a folder's template is unread: {error}"),
        }
        if current.is_empty() {
            return None;
        }
        current = current.rsplit_once('/').map_or("", |(up, _)| up);
    }
}
