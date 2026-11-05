//! `index.db`'s `note_properties`: each markdown note's property values as the index last read
//! them from its file, as Electron's `setNoteProperties` (`property-queries.ts`) keeps them: a
//! row per property, its `serializeValue` text and its type. The rows are derived. They are
//! written with the note's `note_stats` row ([`super::note_stats::write`]) and dropped with it,
//! so the two always name the same reading of the file.
//!
//! A row's type depends on the definitions as they were when the file was read. The index
//! records them ([`TYPED_WITH`]), and the desktop indexer reads again the notes holding a name
//! whose definition changed since (`retypeIndexedProperties`).

use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;
use crate::domain::notes::failed;
use crate::domain::property_values::IndexedProperty;

/// `index_meta` key: each defined property's type, by name, as the rows were typed with.
pub const TYPED_WITH: &str = "note_properties.typed_with";

/// One stored row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredProperty {
    pub name: String,
    pub text: Option<String>,
    pub type_name: String,
}

/// Each note's rows become its properties: one delete for them all, so a note with none costs
/// no statement of its own.
pub(crate) fn replace(
    index: &Connection,
    notes: &[(&str, &[IndexedProperty])],
) -> Result<(), StorageError> {
    let ids: Vec<&str> = notes.iter().map(|(note_id, _)| *note_id).collect();
    let ids = serde_json::to_string(&ids).map_err(|error| StorageError::Failed {
        what: error.to_string(),
    })?;
    index
        .execute(
            "DELETE FROM note_properties WHERE note_id IN (SELECT value FROM json_each(?1))",
            params![ids],
        )
        .map_err(failed)?;
    let mut insert = index
        .prepare_cached(
            "INSERT INTO note_properties (note_id, name, value, type) VALUES (?1, ?2, ?3, ?4)",
        )
        .map_err(failed)?;
    for (note_id, properties) in notes {
        for property in *properties {
            insert
                .execute(params![
                    note_id,
                    property.name,
                    property.text,
                    property.type_name
                ])
                .map_err(failed)?;
        }
    }
    Ok(())
}

pub(crate) fn forget(index: &Connection, note_id: &str) -> Result<(), StorageError> {
    index
        .execute(
            "DELETE FROM note_properties WHERE note_id = ?1",
            params![note_id],
        )
        .map_err(failed)?;
    Ok(())
}

/// The note's rows, in the order they were written.
pub fn read(index: &Connection, note_id: &str) -> Result<Vec<StoredProperty>, StorageError> {
    let mut statement = index
        .prepare("SELECT name, value, type FROM note_properties WHERE note_id = ?1 ORDER BY rowid")
        .map_err(failed)?;
    statement
        .query_map(params![note_id], |row| {
            Ok(StoredProperty {
                name: row.get(0)?,
                text: row.get(1)?,
                type_name: row.get(2)?,
            })
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)
}

/// The notes with a row of any of `names`.
pub fn holding(index: &Connection, names: &[String]) -> Result<Vec<String>, StorageError> {
    let mut statement = index
        .prepare("SELECT DISTINCT note_id FROM note_properties WHERE name = ?1")
        .map_err(failed)?;
    let mut notes = Vec::new();
    for name in names {
        let held = statement
            .query_map(params![name], |row| row.get::<_, String>(0))
            .map_err(failed)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(failed)?;
        notes.extend(held);
    }
    notes.sort();
    notes.dedup();
    Ok(notes)
}

/// The definitions' types the rows were typed with; `None` when the index has not recorded
/// them (an index from before the rows were filled) or the record does not read, so every
/// note is read again.
pub fn typed_with(index: &Connection) -> Result<Option<BTreeMap<String, String>>, StorageError> {
    let text: Option<String> = index
        .query_row(
            "SELECT value FROM index_meta WHERE key = ?1",
            [TYPED_WITH],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    Ok(text.and_then(|text| match serde_json::from_str(&text) {
        Ok(types) => Some(types),
        Err(error) => {
            eprintln!(
                "memry-core: the `{TYPED_WITH}` row does not read ({error}); reading every note"
            );
            None
        }
    }))
}

pub fn set_typed_with(
    index: &Connection,
    types: &BTreeMap<String, String>,
) -> Result<(), StorageError> {
    let text = serde_json::to_string(types).map_err(|error| StorageError::Failed {
        what: error.to_string(),
    })?;
    index
        .execute(
            "INSERT INTO index_meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![TYPED_WITH, text],
        )
        .map_err(failed)?;
    Ok(())
}

/// The names whose type differs between `before` and `now`, one missing from either included.
pub fn retyped(before: &BTreeMap<String, String>, now: &BTreeMap<String, String>) -> Vec<String> {
    let mut names: Vec<String> = before
        .iter()
        .filter(|(name, type_name)| now.get(*name) != Some(type_name))
        .map(|(name, _)| name.clone())
        .chain(
            now.keys()
                .filter(|name| !before.contains_key(*name))
                .cloned(),
        )
        .collect();
    names.sort();
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    fn types(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(name, type_name)| ((*name).to_owned(), (*type_name).to_owned()))
            .collect()
    }

    #[test]
    fn a_name_defined_undefined_or_retyped_counts_as_retyped() {
        let before = types(&[("kept", "text"), ("gone", "date"), ("moved", "number")]);
        let now = types(&[("kept", "text"), ("moved", "text"), ("new", "select")]);
        assert_eq!(retyped(&before, &now), ["gone", "moved", "new"]);
        assert!(retyped(&now, &now).is_empty());
    }

    #[test]
    fn an_unreadable_record_of_the_types_reads_as_none() -> Result<(), StorageError> {
        let index = Connection::open_in_memory().map_err(failed)?;
        index
            .execute_batch("CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT)")
            .map_err(failed)?;
        assert_eq!(typed_with(&index)?, None);
        let recorded = types(&[("stage", "select")]);
        set_typed_with(&index, &recorded)?;
        assert_eq!(typed_with(&index)?, Some(recorded));
        index
            .execute(
                "UPDATE index_meta SET value = 'not json' WHERE key = ?1",
                [TYPED_WITH],
            )
            .map_err(failed)?;
        assert_eq!(typed_with(&index)?, None);
        Ok(())
    }
}
