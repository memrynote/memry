//! What Electron's note and journal push reads from the vault file: `readNoteFileFields`
//! (`sync/note-file-fields.ts:20-39`, over `parseNote`, `vault/frontmatter.ts:117-160`) and the
//! journal handler's read (`journal-handler.ts:265-279`, over `parseJournalEntry` and
//! `extractJournalProperties`, `vault/journal.ts:128-140,219-240`). The frontmatter is read
//! through the native ports of the same functions (`notes::frontmatter`, `journal`).

use std::io::Read;
use std::path::Path;

use memry_core::domain::note_stats::header_tags;
use memry_core::domain::notes::names::normalize_aliases;
use memry_core::markdown::frontmatter::{
    YamlMap, YamlValue, gray_matter_data, gray_matter_parts, js_trim, split_frontmatter_block,
};
use memry_core::markdown::shared::cover_image::cover_sync;
use serde_json::{Map, Value};

use crate::notes::frontmatter::{aliases, cover_fields, file_fields, to_json};
use crate::vault::paths::open_vault_file;

/// The longest file this import reads. V8 cannot hold a longer string (`String::kMaxLength`,
/// 2^29 - 24 UTF-16 units), so Electron's read of such a file throws and its push takes the
/// unread path, as this import does.
pub const MAX_FILE_BYTES: u64 = (1 << 29) - 24;

/// A note file as `readNoteFileFields` returns it; `None` when the file could not be read.
pub struct NoteFields {
    /// The body, for a `create` payload only.
    pub content: Option<String>,
    pub tags: Value,
    pub aliases: Vec<String>,
    /// `noteCoverFromFrontmatter` of the frontmatter.
    pub cover: Option<Map<String, Value>>,
}

/// A day file as the journal handler reads it; `None` when it could not be read or its
/// frontmatter does not parse (`parseJournalEntry` throws).
pub struct JournalFields {
    pub content: Option<String>,
    pub tags: Value,
    pub properties: Value,
    pub aliases: Vec<String>,
}

/// `readVaultFileSync` (`lib/paths.ts:299`): the file under the vault, links refused, read as
/// UTF-8 with replacement. A missing, refused or unreadable file is `None`, which Electron's
/// push catches and logs.
fn read_text(vault: &Path, rel: &str) -> Option<String> {
    let file = match open_vault_file(vault, rel) {
        Ok(Some(file)) => file,
        Ok(None) => return None,
        Err(error) => {
            tracing::warn!(?error, "electron import: a note file could not be opened");
            return None;
        }
    };
    // Checked before the read allocates; the bounded read covers a file that grows meanwhile.
    if file
        .metadata()
        .is_ok_and(|meta| meta.len() > MAX_FILE_BYTES)
    {
        tracing::warn!("electron import: a note file is longer than Electron can read");
        return None;
    }
    let mut bytes = Vec::new();
    if let Err(error) = file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes) {
        tracing::warn!(%error, "electron import: a note file could not be read");
        return None;
    }
    if bytes.len() as u64 > MAX_FILE_BYTES {
        tracing::warn!("electron import: a note file is longer than Electron can read");
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// `tags ?? []` as the payload carries it. The core reads `tags` as an array of strings, so a
/// list the YAML gave another value (`tags: [2024, x]`, `tags: false`) takes the index's
/// reading of the header tags instead (a departure: Electron sends the value as parsed).
fn payload_tags(tags: Option<&Value>, map: Option<&YamlMap>) -> Value {
    match tags {
        None | Some(Value::Null) => Value::Array(Vec::new()),
        Some(Value::Array(items)) if items.iter().all(Value::is_string) => {
            Value::Array(items.clone())
        }
        Some(_) => Value::from(map.map(header_tags).unwrap_or_default()),
    }
}

fn as_map(value: &YamlValue) -> Option<&YamlMap> {
    match value {
        YamlValue::Map(map) => Some(map),
        _ => None,
    }
}

/// `readNoteFileFields(note, operation)` for a markdown note at `rel`.
pub fn note_fields(vault: &Path, rel: &str, title: &str, create: bool) -> Option<NoteFields> {
    let raw = read_text(vault, rel)?;
    let split = split_frontmatter_block(&raw);
    // A block that does not parse reads as no frontmatter, and the body stays (`parseNote`).
    let data = match split.block.map(gray_matter_data).transpose() {
        Ok(Some(data)) => data,
        Ok(None) => YamlValue::map(YamlMap::new()),
        Err(error) => {
            tracing::warn!(%error, "electron import: a note's frontmatter does not parse");
            YamlValue::map(YamlMap::new())
        }
    };
    let map = as_map(&data);
    // `parseNote`'s frontmatter: a lone `tags` value as a one-item list.
    let frontmatter = file_fields(&data).frontmatter;
    Some(NoteFields {
        content: create.then(|| split.body.to_owned()),
        tags: payload_tags(frontmatter.get("tags"), map),
        aliases: normalize_aliases(title, &map.map(aliases).unwrap_or_default()),
        cover: map.and_then(|map| cover_sync(&cover_fields(map))),
    })
}

/// The journal handler's read of the day file at `rel` for `date`.
pub fn journal_fields(vault: &Path, rel: &str, date: &str, create: bool) -> Option<JournalFields> {
    let raw = read_text(vault, rel)?;
    // `matter(rawContent)` over the whole file, which throws on a block that does not parse.
    let data = match gray_matter_data(&raw) {
        Ok(data) => data,
        Err(error) => {
            tracing::warn!(%error, "electron import: a day file's frontmatter does not parse");
            return None;
        }
    };
    let map = as_map(&data);
    let mut frontmatter = match to_json(&data) {
        Value::Object(frontmatter) => frontmatter,
        _ => Map::new(),
    };
    // `data.tags = [String(data.tags)]` for a lone truthy value; `aliases` stays as written.
    if let Some(tags) = frontmatter.get_mut("tags")
        && truthy(tags)
        && !tags.is_array()
    {
        *tags = Value::Array(vec![Value::String(js_string(tags))]);
    }
    let properties = crate::journal::properties_of(&frontmatter);
    let body = gray_matter_parts(&raw).map_or(raw.as_str(), |(_, body)| body);
    Some(JournalFields {
        content: create.then(|| js_trim(body).to_owned()),
        tags: payload_tags(frontmatter.get("tags"), map),
        properties: match properties.is_empty() {
            true => Value::Null,
            false => Value::Object(properties),
        },
        // `extractAliases` reads only a list here: `parseJournalEntry` does not make one.
        aliases: match map.and_then(|map| map.get("aliases")) {
            Some(YamlValue::Seq(_)) => {
                normalize_aliases(date, &map.map(aliases).unwrap_or_default())
            }
            _ => Vec::new(),
        },
    })
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// `String(value)` of a JSON value that is no array.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Object(_) => "[object Object]".to_owned(),
        other => other.to_string(),
    }
}
