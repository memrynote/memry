//! A note's tags and typed properties, read together.
//!
//! The list and read surfaces carry a note's title, folder and instants;
//! everything else §13.7.1 puts in the payload — `tags`, `properties`,
//! `aliases` — has never crossed the FFI, so the note screen could not show a
//! tag row or a property table at all.
//!
//! **One read, not three.** Tags and properties both come out of the same
//! `sync_items` payload, and reading it once is what keeps them consistent: two
//! reads either side of a sync could show a property that the tag list has
//! already been updated past.
//!
//! **A payload that will not parse is an error, never an empty note.** The
//! domain readers below already refuse to answer "no tags" for an unreadable
//! row, and this keeps that: an empty answer here becomes an empty tag row on
//! screen, and the next edit writes it back as the truth.
//!
//! **Property types are not decided here.** A definition names a type as a
//! string (`text`, `date`, `select`, …) and §13.7.9 keeps `options` as opaque
//! JSON text; the core carries both across unread. A shell that meets a type it
//! does not know shows the raw value rather than dropping the property, which
//! is the same rule the block walker follows for unknown blocks.

use rusqlite::Connection;
use serde_json::{Map, Value};

use crate::api::errors::StorageError;
use crate::domain::{notes, properties, tags};

/// One property on a note: its name, its value, and the type the vault
/// declared for it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct NoteProperty {
    pub name: String,
    /// The value as JSON **text**, exactly as the payload carries it.
    ///
    /// Not a typed union: §13.7.1 lets a property hold any JSON, and a core
    /// that mapped it into a closed enum would have to drop or coerce whatever
    /// did not fit. A shell reads it against ``type_name``.
    pub value_json: String,
    /// The declared type, or `None` when the vault has no definition for this
    /// name — a property written before its definition arrived, which is legal
    /// and must still be shown.
    pub type_name: Option<String>,
    /// `property_definition.options`, opaque JSON text (§13.7.9). `None` when
    /// undefined or when the definition carries none.
    pub options_json: Option<String>,
    /// The definition's colour, for the shells that paint one.
    pub color: Option<String>,
}

/// A note's tags and properties.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct NoteMetadata {
    /// Spelled exactly as the payload holds them. Case is preserved because
    /// `Café` and `CAFÉ` are two rows one layer down, and only matching folds.
    pub tags: Vec<String>,
    /// Sorted by name, so two reads of an unchanged note render identically.
    pub properties: Vec<NoteProperty>,
    /// The note's other names, for the wiki-link resolver and for a shell that
    /// wants to show them. Empty when the payload carries none.
    pub aliases: Vec<String>,
    /// The note's icon, which the payload spells `emoji` (§13.7.1).
    ///
    /// Named `icon` here because that is what it is on every surface, and
    /// because the field is not restricted to an emoji — a shell may put a
    /// symbol name in it. `None` covers both an absent key and an explicit
    /// `null`, which mean the same thing for a value nobody has set.
    pub icon: Option<String>,
    /// The note's cover, as JSON text in desktop's shape (§13.7.1.1):
    /// `{"ref": ..., "focus"?: 0-100, "credit"?: ..., "creditUrl"?: ...}`.
    ///
    /// `ref` is desktop's frontmatter `cover` value — a vault path, `wash:<id>`
    /// or an http(s) URL — and deciding which is the shell's job, the same way
    /// desktop parses it once at render. Read from the payload's `cover` field;
    /// when that key is absent or null, the earlier iOS-only `coverImage`
    /// (`{url, offsetY}`, offset 0-1) is read into the same shape, so a cover
    /// written by an older build of this app still shows, marked
    /// `"legacy": true` so the shell accepts its ref whatever its extension.
    /// A `cover: null` that
    /// some older writer sent does not hide it; every removal also writes
    /// `coverImage: null`.
    ///
    /// `None` when neither key holds a readable cover.
    pub cover_json: Option<String>,
}

/// Reads one note's metadata.
///
/// - Returns: `None` when this vault holds no live note by that id — the same
///   answer the body read gives, so a deleted note is not a note with no tags.
pub fn metadata(conn: &Connection, id: &str) -> Result<Option<NoteMetadata>, StorageError> {
    if !super::reads::note_exists(conn, id) {
        return Ok(None);
    }
    let tags = tags::list(conn, notes::ITEM_TYPE, id)?;
    let values = properties::values(conn, notes::ITEM_TYPE, id)?;
    let definitions = properties::definitions(conn)?;

    let properties: Vec<NoteProperty> = values
        .into_iter()
        .map(|(name, value)| {
            let definition = definitions.iter().find(|it| it.name == name);
            NoteProperty {
                value_json: value.to_string(),
                type_name: definition.map(|it| it.type_name.clone()),
                options_json: definition.and_then(|it| it.options.clone()),
                color: definition.and_then(|it| it.color.clone()),
                name,
            }
        })
        .collect();
    // The payload's key order is the property order the user set, on desktop
    // or here (`properties::reorder`), so it is kept rather than sorted.

    let payload = note_payload(conn, id)?;
    Ok(Some(NoteMetadata {
        tags,
        properties,
        aliases: aliases(conn, id)?,
        icon: payload
            .as_ref()
            .and_then(|object| object.get("emoji"))
            .and_then(|value| value.as_str())
            .map(str::to_owned),
        cover_json: payload
            .as_ref()
            .and_then(cover_of)
            .map(|cover| Value::Object(cover).to_string()),
    }))
}

/// A note payload's cover in desktop's shape, or `None` when it has none.
///
/// Only the four keys §13.7.1.1 names come out, plus `legacy: true` when read
/// from `coverImage`; `ref` must be a non-empty
/// string and each optional key must hold its own type, so a malformed value
/// from some other writer reads as no cover rather than as a broken one.
pub(crate) fn cover_of(payload: &Map<String, Value>) -> Option<Map<String, Value>> {
    match payload.get("cover") {
        Some(Value::Object(cover)) => {
            let reference = cover.get("ref")?.as_str().filter(|it| !it.is_empty())?;
            let mut out = Map::new();
            out.insert("ref".to_owned(), Value::from(reference));
            if let Some(focus) = cover.get("focus").and_then(Value::as_f64)
                && (0.0..=100.0).contains(&focus)
            {
                out.insert("focus".to_owned(), Value::from(focus.round() as i64));
            }
            for key in ["credit", "creditUrl"] {
                if let Some(text) = cover.get(key).and_then(Value::as_str) {
                    out.insert(key.to_owned(), Value::from(text));
                }
            }
            Some(out)
        }
        // A value this build cannot read is no cover.
        Some(value) if !value.is_null() => None,
        // Absent or `null`: an older iOS build's `coverImage` still shows. A
        // removal writes `coverImage: null` beside `cover: null`, so a removed
        // cover does not come back through here.
        _ => {
            let legacy = payload.get("coverImage")?.as_object()?;
            let url = legacy.get("url")?.as_str().filter(|it| !it.is_empty())?;
            let offset = legacy
                .get("offsetY")
                .and_then(Value::as_f64)
                .unwrap_or(0.5)
                .clamp(0.0, 1.0);
            let mut out = Map::new();
            out.insert("ref".to_owned(), Value::from(url));
            out.insert(
                "focus".to_owned(),
                Value::from((offset * 100.0).round() as i64),
            );
            // An older iOS build stored any picked picture, HEIC included, so
            // the shell must not hold this ref to desktop's extension list.
            out.insert("legacy".to_owned(), Value::Bool(true));
            Some(out)
        }
    }
}

/// One note's stored payload object, or `None` when it has none yet.
///
/// Read rather than projected because the two values above live in different
/// places: `emoji` is a schema field with its own column, while the cover
/// exists only in the payload. Taking both from the payload keeps them
/// consistent with each other.
pub(crate) fn note_payload(
    conn: &Connection,
    id: &str,
) -> Result<Option<Map<String, Value>>, StorageError> {
    let Some(row) = crate::storage::repositories::sync_items::load(conn, notes::ITEM_TYPE, id)?
    else {
        return Ok(None);
    };
    let Some(raw) = row.payload else {
        return Ok(None);
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Object(object)) => Ok(Some(object)),
        // A payload that will not read is a hard error for the same reason
        // the tag reader gives: a silent empty would be written back as the
        // truth by the next edit.
        Ok(other) => Err(StorageError::Failed {
            what: format!("note `{id}` has a payload that is not an object: {other}"),
        }),
        Err(error) => Err(StorageError::Failed {
            what: format!("note `{id}` has a payload that will not parse: {error}"),
        }),
    }
}

/// A note's `aliases` array, or empty.
///
/// Empty for a note that carries none. A row whose `aliases` is present but is
/// not an array of strings is a **hard error** for the reason the tag reader
/// gives: an empty answer would be written back as the truth by the next edit.
fn aliases(conn: &Connection, id: &str) -> Result<Vec<String>, StorageError> {
    let mut statement = conn
        .prepare("SELECT aliases FROM notes WHERE id = ?1 AND deleted_at IS NULL")
        .map_err(failed)?;
    let raw: Option<String> = statement
        .query_row([id], |row| row.get(0))
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(failed(other)),
        })?;
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Array(items)) => items
            .into_iter()
            .map(|item| match item {
                Value::String(alias) => Ok(alias),
                other => Err(StorageError::Failed {
                    what: format!("note `{id}` has a non-string alias: {other}"),
                }),
            })
            .collect(),
        Ok(Value::Null) => Ok(Vec::new()),
        Ok(other) => Err(StorageError::Failed {
            what: format!("note `{id}` has `aliases` that is not an array: {other}"),
        }),
        Err(error) => Err(StorageError::Failed {
            what: format!("note `{id}` has unreadable `aliases`: {error}"),
        }),
    }
}

/// Resolves what a `[[wiki link]]` points at.
///
/// Chapter 12 §12.3: a wiki link carries a **title**, not an id, so resolving
/// it is a lookup and the answer can be "nothing" — desktop calls that a broken
/// link and offers to create the note. The same three outcomes exist here:
///
///   * a live note whose title matches, case-insensitively;
///   * failing that, a live note that lists the target among its aliases;
///   * otherwise `None`, which is a broken link and **not** an error.
///
/// Ties are broken by id so two runs answer the same note. Nothing is created,
/// because a reader that wrote would turn scrolling past a broken link into an
/// edit.
pub fn resolve_wiki_target(
    conn: &Connection,
    target: &str,
) -> Result<Option<String>, StorageError> {
    let wanted = target.trim();
    if wanted.is_empty() {
        return Ok(None);
    }
    let mut statement = conn
        .prepare(
            "SELECT id FROM notes WHERE deleted_at IS NULL \
             AND title = ?1 COLLATE NOCASE ORDER BY id LIMIT 1",
        )
        .map_err(failed)?;
    let by_title: Option<String> =
        statement
            .query_row([wanted], |row| row.get(0))
            .or_else(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(failed(other)),
            })?;
    if by_title.is_some() {
        return Ok(by_title);
    }

    // The alias pass. `aliases` is JSON text in the projection rather than its
    // own table, so the match is done in Rust against the parsed array — a
    // `LIKE` over the raw JSON would match a note whose alias merely contains
    // the target.
    let mut statement = conn
        .prepare(
            "SELECT id, aliases FROM notes \
             WHERE deleted_at IS NULL AND aliases IS NOT NULL ORDER BY id",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(failed)?;
    for row in rows {
        let (id, raw) = row.map_err(failed)?;
        let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&raw) else {
            // A malformed `aliases` on some other note is not this link's
            // problem: skipping it resolves against the notes that are
            // readable rather than failing the whole lookup.
            continue;
        };
        if items
            .iter()
            .filter_map(Value::as_str)
            .any(|alias| alias.trim().eq_ignore_ascii_case(wanted))
        {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

/// What a `[[wiki link]]` resolved to: a note, or a journal day.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct WikiTargetMatch {
    /// The note id, or the journal record id (also its document id).
    pub id: String,
    /// `note` or `journal`.
    pub kind: String,
    /// The journal's date, `None` for a note.
    pub date: Option<String>,
}

/// [`resolve_wiki_target`], then the journal.
///
/// Desktop titles a journal with its date, so `[[2026-04-16]]` names that day
/// when no note answers first. The `j<YYYY-MM-DD>` id form names the day too,
/// and like desktop's `dateFromJournalId` it opens the day even when it has no
/// entry yet: the id is then the minted `j<date>` and nothing is created (D2).
/// A bare date with no live entry is `None`, a broken link.
pub fn resolve_wiki_target_kind(
    conn: &Connection,
    target: &str,
) -> Result<Option<WikiTargetMatch>, StorageError> {
    if let Some(id) = resolve_wiki_target(conn, target)? {
        return Ok(Some(WikiTargetMatch {
            id,
            kind: "note".to_owned(),
            date: None,
        }));
    }
    let Some((date, id_form)) = journal_date_of(target) else {
        return Ok(None);
    };
    let id = match crate::domain::journal::live_entry(conn, &date)? {
        Some(id) => id,
        None if id_form => crate::domain::journal::document_id_for(&date)?,
        None => return Ok(None),
    };
    Ok(Some(WikiTargetMatch {
        id,
        kind: "journal".to_owned(),
        date: Some(date),
    }))
}

/// The calendar date a link target names, and whether it was spelled as the
/// `j<date>` id form. `None` when it names no real day.
pub fn journal_date_of(target: &str) -> Option<(String, bool)> {
    let wanted = target.trim();
    let valid = |date: &str| crate::domain::journal::valid_date(date).is_ok();
    if valid(wanted) {
        return Some((wanted.to_owned(), false));
    }
    wanted
        .strip_prefix('j')
        .filter(|date| valid(date))
        .map(|date| (date.to_owned(), true))
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
