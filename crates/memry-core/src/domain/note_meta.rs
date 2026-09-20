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
use serde_json::Value;

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

    let mut properties: Vec<NoteProperty> = values
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
    // A stable order the shell does not have to invent. `serde_json::Map` is
    // insertion-ordered by payload, and a payload rewritten by another device
    // can reorder it — a property table that reshuffles between syncs is a
    // table the reader has to re-scan every time.
    properties.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(Some(NoteMetadata {
        tags,
        properties,
        aliases: aliases(conn, id)?,
    }))
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

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
