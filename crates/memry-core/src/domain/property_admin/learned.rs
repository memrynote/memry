//! The types this device learned for properties that have no definition (#3530 13k-4c-2;
//! Electron's `learnCanonicalPropertyType`): the type a name was first read with, which types
//! every later read of it here.
//!
//! Electron keeps such a type as a `property_definitions` row with no clock: no sync item, and
//! not in `properties.md`. This keeps it in `meta` (`property_definitions.learned`, a JSON
//! object of name to type; an older build ignores the key, so no migration), apart from the
//! records, so it reaches no other device, no file and no definitions list.
//!
//! A name with a record, live or deleted, has a definition or had one: it is not learned, and a
//! type learned before the record came is not read. So a definition the user or another device
//! deleted stays deleted here.

use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension, params};

use super::{DEFINITION_TYPES, ITEM_TYPE};
use crate::api::errors::StorageError;
use crate::domain::notes::failed;

/// The `meta` key of the learned types.
const LEARNED: &str = "property_definitions.learned";

/// Each learned type by name, but for a name with a record.
pub fn learned(conn: &Connection) -> Result<BTreeMap<String, String>, StorageError> {
    let mut types = stored(conn)?;
    let recorded = recorded(conn)?;
    types.retain(|name, _| !recorded.contains_key(name));
    Ok(types)
}

/// Learns each of `wanted` (name to type) that has no record, no learned type and a type a
/// definition holds (no `relation`, which none holds, and no `project`, which its name decides),
/// in one write. `true` when it learned one.
pub fn learn(conn: &Connection, wanted: &BTreeMap<String, String>) -> Result<bool, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let mut types = stored(&tx)?;
    let recorded = recorded(&tx)?;
    let mut learned = false;
    for (name, type_name) in wanted {
        let learnable = DEFINITION_TYPES.contains(&type_name.as_str())
            && !matches!(type_name.as_str(), "relation" | "project");
        if learnable && !recorded.contains_key(name) && !types.contains_key(name) {
            types.insert(name.clone(), type_name.clone());
            learned = true;
        }
    }
    if learned {
        let value = serde_json::to_string(&types).map_err(|error| StorageError::Failed {
            what: format!("the learned property types will not serialise: {error}"),
        })?;
        tx.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![LEARNED, value],
        )
        .map_err(failed)?;
    }
    tx.commit().map_err(failed)?;
    Ok(learned)
}

fn stored(conn: &Connection) -> Result<BTreeMap<String, String>, StorageError> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [LEARNED], |row| {
            row.get(0)
        })
        .optional()
        .map_err(failed)?;
    // A value that does not read learned nothing: each name is learned again at its next read.
    Ok(raw
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default())
}

/// Every name with a record, a deleted one included.
fn recorded(conn: &Connection) -> Result<BTreeMap<String, ()>, StorageError> {
    let mut statement = conn
        .prepare_cached("SELECT item_id FROM sync_items WHERE item_type = ?1")
        .map_err(failed)?;
    let names = statement
        .query_map([ITEM_TYPE], |row| row.get::<_, String>(0))
        .map_err(failed)?;
    names
        .map(|name| name.map(|name| (name, ())))
        .collect::<Result<_, _>>()
        .map_err(failed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::property_admin::records::{DefinitionRecord, put, remove};
    use crate::storage::{open_data, test_support::temp_dir};

    const NOW: i64 = 1_760_000_000_000;

    fn types(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(name, type_name)| ((*name).to_owned(), (*type_name).to_owned()))
            .collect()
    }

    fn record(name: &str) -> DefinitionRecord {
        DefinitionRecord {
            name: name.into(),
            type_name: "select".into(),
            options: None,
            default_value: None,
            color: None,
        }
    }

    #[test]
    fn a_name_is_learned_once_and_never_over_a_record_live_or_deleted() {
        let dir = temp_dir("props-learned");
        let db = open_data(&dir.path().join("data.db")).expect("open");
        db.call_blocking(|c| {
            put(c, &record("stage"), "p", NOW)?;
            put(c, &record("gone"), "p", NOW)?;
            remove(c, "gone", "p", NOW + 1)?;
            let wanted = types(&[
                ("rating", "number"),
                ("stage", "text"),
                ("gone", "text"),
                ("links", "relation"),
                ("project", "project"),
                ("odd", "formula"),
            ]);
            assert!(learn(c, &wanted)?);
            assert_eq!(learned(c)?, types(&[("rating", "number")]));
            // The first type stays.
            assert!(!learn(c, &types(&[("rating", "text")]))?);
            assert_eq!(learned(c)?, types(&[("rating", "number")]));

            // A record that comes later is the name's definition; deleted, it stays one.
            put(c, &record("rating"), "p", NOW + 2)?;
            assert!(learned(c)?.is_empty());
            remove(c, "rating", "p", NOW + 3)?;
            assert!(learned(c)?.is_empty());
            assert!(!learn(c, &types(&[("rating", "number")]))?);
            Ok(())
        })
        .expect("learned");
    }
}
