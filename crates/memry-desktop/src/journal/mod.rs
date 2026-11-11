//! The journal service of the desktop app (Step 13m, #3530): a day's entry as the journal page
//! reads it, made on its first write, edited and deleted (`journal:getEntry`,
//! `journal:createEntry`, `journal:updateEntry`, `journal:deleteEntry` of
//! `ipc/journal-handlers.ts`).
//!
//! A day is a core journal record (its id, tags, instants and body) and a vault file at the
//! path its date makes (`JournalDays::path_of`). Where the two meet:
//! - a read takes the file of the day's row, and the config's path only for a day no row
//!   names; the text, aliases and properties come from the file, as Electron reads them
//!   (`readJournalEntry`), the id, tags and instants from the record (`findStoredJournalEntry`);
//!   journal tags live on the record, never written back to the file (#3530, decided);
//! - a create ([`write`]) writes the file Electron's `createJournalEntry` writes, in the order
//!   13f's note create uses;
//! - an update ([`update`]) edits the file through the app-edit seam and the record's tags and
//!   properties after it;
//! - the write-back keeps the file's body in step with the document after that (13m-1);
//! - the calendar ([`calendar`]) lists the live records, measured by the note index's row of
//!   each day's file, the charts ([`property_rows`]) the records' property values, and the day
//!   panel ([`day_context`]) the tasks due on a day.
//!
//! Not here yet: the journal folder following a move of the folder (13m-7); until then a day
//! the folder carries is held ([`folder_follow`]).

pub mod calendar;
pub mod day_context;
pub mod folder_follow;
pub mod property_rows;
pub mod update;
pub mod write;

use std::io::Read as _;
use std::path::Path;

use memry_core::api::journal::Journal;
use memry_core::domain::journal::valid_date;
use memry_core::domain::journal_ops::reads::DayStamp;
use memry_core::domain::journal_rules::{count_words, utf16_len};
use memry_core::domain::notes::names::normalize_aliases;
use memry_core::domain::properties::RESERVED_DAY_KEYS;
use memry_core::markdown::frontmatter::{gray_matter_data, split_frontmatter_block};
use memry_core::markdown::shared::markdown_class::MarkdownClassThresholds;
use memry_core::storage::repositories::instants::to_iso8601;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::notes::error::NotesError;
use crate::notes::frontmatter::{FileFields, file_fields};
use crate::session::OpenVault;
use crate::vault::config::read_vault_config;
use crate::vault::journal_format::JournalDays;
use crate::vault::paths::open_vault_file;

const SCOPE: &str = "journal";

/// A frontmatter key that is not a day's property (`RESERVED_JOURNAL_KEYS`, `vault/journal.ts`):
/// the core's [`RESERVED_DAY_KEYS`], and `tags` and `properties`, which no file's property is.
pub(crate) fn is_reserved_day_key(name: &str) -> bool {
    RESERVED_DAY_KEYS.contains(&name) || matches!(name, "tags" | "properties")
}

/// `JournalEntry` (`packages/contracts/src/journal-api.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntryView {
    pub id: String,
    /// `YYYY-MM-DD`
    pub date: String,
    /// The markdown below the frontmatter, trimmed.
    pub content: String,
    pub word_count: u32,
    /// UTF-16 code units of `content`.
    pub character_count: u32,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    /// `None` when the file carries none, as Electron leaves the key out.
    pub properties: Option<Map<String, Value>>,
    /// ISO 8601.
    pub created_at: String,
    pub modified_at: String,
}

/// The day's entry, `None` when it has no file. A day the core has no record of reads from the
/// file at its path, under the id of the row that names that file (a note's, as Electron's
/// `findStoredJournalEntry` answers the cache row at the path), else the id it will get
/// (`j<date>`). An empty file is an empty entry (Electron reads none and seeds the template
/// over it; a create here never writes over a file).
pub fn entry(
    open: &OpenVault,
    journal: &Journal,
    date: &str,
) -> Result<Option<JournalEntryView>, NotesError> {
    let date = valid_date(date)?;
    let stamp = journal.stamp(date)?;
    let path = match stamp.as_ref().and_then(|stamp| stamp.path.clone()) {
        Some(path) => path,
        None => day_path(&open.path, date)?,
    };
    let Some(raw) = read_day_file(&open.path, &path)? else {
        return Ok(None);
    };
    let mut view = view_of(date, &raw, stamp.as_ref());
    if stamp.is_none()
        && let Some(row) = open.vault.note_files().by_path(&path)?
    {
        view.id = row.note_id;
    }
    Ok(Some(view))
}

/// The day the vault file at `path` is under the vault's config (`extractJournalDate`), `None`
/// for a note's path.
pub fn day_of_file(root: &Path, path: &str) -> Option<String> {
    let config = read_vault_config(root);
    JournalDays::new(&config.journal_folder, &config.journal_date_format).day_of(path)
}

/// Where the file of `date` goes under the vault's config (`getJournalRelativePath`).
pub(crate) fn day_path(root: &Path, date: &str) -> Result<String, NotesError> {
    let config = read_vault_config(root);
    JournalDays::new(&config.journal_folder, &config.journal_date_format)
        .path_of(date)
        .ok_or_else(|| NotesError::NotFound(date.to_owned()))
}

/// The text of the day file at `rel`, read as a note's is: under the vault, refusing links;
/// `None` when it is not there. A file past the large-file ceiling fails the read: the page
/// shows a day whole or not at all.
fn read_day_file(root: &Path, rel: &str) -> Result<Option<String>, NotesError> {
    let Some(file) = open_vault_file(root, rel)? else {
        return Ok(None);
    };
    let ceiling = MarkdownClassThresholds::default().max_file_bytes;
    let mut bytes = Vec::new();
    // One byte past the ceiling tells a file at it from one past it.
    file.take(ceiling as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > ceiling {
        return Err(NotesError::TooLarge(ceiling));
    }
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

/// The entry the file text `raw` is, with the record's fields when there is one
/// (`toJournalEntry` plus the handler's stored id and instants).
pub(crate) fn view_of(date: &str, raw: &str, stamp: Option<&DayStamp>) -> JournalEntryView {
    let split = split_frontmatter_block(raw);
    let fields = match split.block.map(gray_matter_data).transpose() {
        Ok(Some(data)) => file_fields(&data),
        Ok(None) => FileFields::default(),
        Err(error) => {
            tracing::warn!(
                scope = SCOPE,
                date,
                "a day file's frontmatter does not parse: {error}"
            );
            FileFields::default()
        }
    };
    // `String.prototype.trim` also strips the byte order mark.
    let content = split
        .body
        .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
        .to_owned();
    let instant = |ms: Option<i64>| ms.and_then(to_iso8601).unwrap_or_else(now_iso);
    let properties = properties_of(&fields.frontmatter);
    JournalEntryView {
        id: stamp.map_or_else(|| format!("j{date}"), |stamp| stamp.id.clone()),
        date: date.to_owned(),
        word_count: u32::try_from(count_words(&content)).unwrap_or(u32::MAX),
        character_count: u32::try_from(utf16_len(&content)).unwrap_or(u32::MAX),
        tags: stamp.map_or(fields.header_tags, |stamp| stamp.tags.clone()),
        aliases: normalize_aliases(date, &fields.aliases),
        properties: (!properties.is_empty()).then_some(properties),
        created_at: instant(stamp.and_then(|stamp| stamp.created_at)),
        modified_at: instant(stamp.and_then(|stamp| stamp.modified_at)),
        content,
    }
}

/// `extractJournalProperties`: the legacy nested envelope first, then the top level, which wins.
fn properties_of(frontmatter: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(Value::Object(nested)) = frontmatter.get("properties") {
        for (name, value) in nested {
            if name != "properties" {
                out.insert(name.clone(), value.clone());
            }
        }
    }
    for (name, value) in frontmatter {
        if !is_reserved_day_key(name) {
            out.insert(name.clone(), value.clone());
        }
    }
    out
}

fn now_iso() -> String {
    to_iso8601(crate::vault::consumer::rows::now_ms()).unwrap_or_default()
}
