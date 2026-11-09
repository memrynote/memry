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
//!
//! Once the device syncs, a learned type becomes a definition ([`promote`], Electron's
//! `seedUnclocked`, #4025): the sync pass calls it after its pull reached the feed head, so a
//! definition another device pushed first has landed and wins.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, OptionalExtension, params};

use super::records::{DefinitionRecord, write_record};
use super::{DEFINITION_TYPES, ITEM_TYPE};
use crate::api::errors::StorageError;
use crate::domain::notes::failed;
use crate::sync::outbox;

/// The `meta` key of the learned types.
const LEARNED: &str = "property_definitions.learned";

/// Each learned type by name, but for a name with a record. A stored value this build cannot
/// read (a newer build's shape) holds none it reads.
pub fn learned(conn: &Connection) -> Result<BTreeMap<String, String>, StorageError> {
    let mut types = stored(conn)?.unwrap_or_default();
    let recorded = recorded(conn)?;
    types.retain(|name, _| !recorded.contains_key(name));
    Ok(types)
}

/// Learns each of `wanted` (name to type) that has no record, no learned type and a type a
/// definition holds (no `relation`, which none holds, and no `project`, which its name decides),
/// in one write. `true` when it learned one. Fails, writing nothing, over a stored value this
/// build cannot read, which a write would replace.
pub fn learn(conn: &Connection, wanted: &BTreeMap<String, String>) -> Result<bool, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let mut types = stored(&tx)?.ok_or_else(|| StorageError::Failed {
        what: format!("the learned property types ({LEARNED}) do not read; kept as they are"),
    })?;
    let recorded = recorded(&tx)?;
    let mut learned = false;
    for (name, type_name) in wanted {
        if learnable(type_name) && !recorded.contains_key(name) && !types.contains_key(name) {
            types.insert(name.clone(), type_name.clone());
            learned = true;
        }
    }
    if learned {
        store(&tx, &types)?;
    }
    tx.commit().map_err(failed)?;
    Ok(learned)
}

/// Makes each learned type a definition record, as Electron's `seedUnclocked` pushes its
/// unclocked rows: a record of the name and type with no options, default or color, queued for
/// the push. A name with a record, live or deleted, is not promoted, so a deletion stays deleted;
/// neither is a name in `held` (the names the shell's definitions file holds, an entry it cannot
/// parse included) or a type [`learn`] would not learn. Each promoted name, and each with a
/// record, leaves the learned types, in the same transaction as the records: a retry or the next
/// pass finds a record and promotes nothing twice, and a tombstone purged later cannot bring a
/// deleted name back. A stored value this build cannot read promotes nothing and stays.
/// Returns the promoted names.
pub fn promote(
    conn: &Connection,
    held: &BTreeSet<String>,
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<String>, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let Some(mut types) = stored(&tx)? else {
        return Ok(Vec::new());
    };
    let recorded = recorded(&tx)?;
    let mut promoted = Vec::new();
    let mut changed = false;
    for (name, type_name) in types.clone() {
        if recorded.contains_key(&name) {
            types.remove(&name);
            changed = true;
            continue;
        }
        if held.contains(&name) || !learnable(&type_name) {
            continue;
        }
        let record = DefinitionRecord {
            name: name.clone(),
            type_name,
            options: None,
            default_value: None,
            color: None,
        };
        write_record(&tx, &record, device_id, now_ms)?;
        outbox::enqueue(&tx, &outbox::Change::upsert(ITEM_TYPE, &name), now_ms)?;
        types.remove(&name);
        changed = true;
        promoted.push(name);
    }
    if changed {
        store(&tx, &types)?;
    }
    tx.commit().map_err(failed)?;
    Ok(promoted)
}

/// A type a definition holds: no `relation`, which none holds, and no `project`, which its name
/// decides.
fn learnable(type_name: &str) -> bool {
    DEFINITION_TYPES.contains(&type_name) && !matches!(type_name, "relation" | "project")
}

/// Whether a live note or journal record carries a value for `name`.
pub fn in_use(conn: &Connection, name: &str) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sync_items
                         WHERE item_type IN ('note', 'journal') AND deleted_at IS NULL
                           AND json_valid(payload)
                           AND json_type(payload, '$.properties') = 'object'
                           AND json_type(json_extract(payload, '$.properties'),
                                         '$.\"' || replace(?1, '\"', '') || '\"') IS NOT NULL)",
        [name],
        |row| row.get(0),
    )
    .map_err(failed)
}

fn store(conn: &Connection, types: &BTreeMap<String, String>) -> Result<(), StorageError> {
    let value = serde_json::to_string(types).map_err(|error| StorageError::Failed {
        what: format!("the learned property types will not serialise: {error}"),
    })?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![LEARNED, value],
    )
    .map_err(failed)?;
    Ok(())
}

/// The stored types; `None` when the value does not read.
fn stored(conn: &Connection) -> Result<Option<BTreeMap<String, String>>, StorageError> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [LEARNED], |row| {
            row.get(0)
        })
        .optional()
        .map_err(failed)?;
    Ok(match raw {
        Some(raw) => serde_json::from_str(&raw).ok(),
        None => Some(BTreeMap::new()),
    })
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

    fn outbox(c: &Connection) -> Vec<(String, String)> {
        let mut statement = c
            .prepare("SELECT item_id, op FROM outbox ORDER BY id")
            .expect("prepare");
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("rows")
    }

    fn held(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|name| (*name).to_owned()).collect()
    }

    /// #4025: what the sync pass promotes. A name with a record, live or deleted, never; a name
    /// the shell's file holds, never; the rest once, as the record Electron's `seedUnclocked`
    /// pushes for an unclocked learned row.
    #[test]
    fn a_learned_type_is_promoted_once_and_never_over_a_record_or_a_held_name() {
        let dir = temp_dir("props-learned-promote");
        let db = open_data(&dir.path().join("data.db")).expect("open");
        db.call_blocking(|c| {
            let wanted = types(&[
                ("rating", "number"),
                ("stage", "text"),
                ("gone", "text"),
                ("filed", "url"),
            ]);
            assert!(learn(c, &wanted)?);
            // Records that came after the names were learned: one live, one deleted.
            put(c, &record("stage"), "p", NOW)?;
            put(c, &record("gone"), "p", NOW)?;
            remove(c, "gone", "p", NOW + 1)?;
            let queued = outbox(c).len();

            let promoted = promote(c, &held(&["filed"]), "p", NOW + 2)?;
            assert_eq!(promoted, ["rating"]);
            let row = crate::storage::repositories::sync_items::load(c, ITEM_TYPE, "rating")?
                .expect("the record");
            let payload: serde_json::Value =
                serde_json::from_str(&row.payload.expect("a payload")).expect("json");
            assert_eq!(
                payload,
                serde_json::json!({
                    "name": "rating", "type": "number", "options": null, "defaultValue": null,
                    "color": null, "createdAt": "2025-10-09T08:53:20.002Z", "clock": {"p": 1}
                })
            );
            assert_eq!(&outbox(c)[queued..], [("rating".into(), "upsert".into())]);
            let gone = crate::storage::repositories::sync_items::load(c, ITEM_TYPE, "gone")?
                .expect("the tombstone");
            assert!(gone.deleted_at.is_some(), "the deletion stays");
            // The promoted name and the recorded ones left the learned types; the held one stays.
            assert_eq!(stored(c)?, Some(types(&[("filed", "url")])));

            // A retry promotes nothing and queues nothing.
            assert!(promote(c, &held(&["filed"]), "p", NOW + 3)?.is_empty());
            assert_eq!(outbox(c).len(), queued + 1);
            // Once the file no longer holds it, the held name is promoted.
            assert_eq!(promote(c, &held(&[]), "p", NOW + 4)?, ["filed"]);
            Ok(())
        })
        .expect("promoted");
    }

    /// A stored entry `learn` would not have learned (an older build's `relation` or `project`)
    /// is never promoted: no definition holds `relation`, and `project` is the desktop's own step.
    #[test]
    fn a_stored_relation_or_project_is_not_promoted() {
        let dir = temp_dir("props-learned-promote-relation");
        let db = open_data(&dir.path().join("data.db")).expect("open");
        db.call_blocking(|c| {
            let stored_types = types(&[
                ("links", "relation"),
                ("project", "project"),
                ("rating", "number"),
            ]);
            store(c, &stored_types)?;
            assert_eq!(promote(c, &held(&[]), "p", NOW)?, ["rating"]);
            assert_eq!(outbox(c), [("rating".into(), "upsert".into())]);
            assert!(
                crate::storage::repositories::sync_items::load(c, ITEM_TYPE, "links")?.is_none()
            );
            Ok(())
        })
        .expect("not promoted");
    }

    #[test]
    fn a_stored_value_that_does_not_read_promotes_nothing_and_stays() {
        let dir = temp_dir("props-learned-promote-unread");
        let db = open_data(&dir.path().join("data.db")).expect("open");
        db.call_blocking(|c| {
            let newer = r#"[{"name":"rating","type":"number"}]"#;
            c.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)",
                params![LEARNED, newer],
            )
            .map_err(failed)?;
            assert!(promote(c, &held(&[]), "p", NOW)?.is_empty());
            assert!(outbox(c).is_empty());
            let kept: String = c
                .query_row("SELECT value FROM meta WHERE key = ?1", [LEARNED], |row| {
                    row.get(0)
                })
                .map_err(failed)?;
            assert_eq!(kept, newer);
            Ok(())
        })
        .expect("kept");
    }

    #[test]
    fn a_name_is_in_use_while_a_live_note_or_day_carries_it() {
        let dir = temp_dir("props-learned-in-use");
        let db = open_data(&dir.path().join("data.db")).expect("open");
        db.call_blocking(|c| {
            assert!(!in_use(c, "project")?);
            c.execute(
                "INSERT INTO sync_items (item_type, item_id, payload, payload_state, updated_at)
                 VALUES ('journal', 'j1', ?1, 'plain', 1)",
                [r#"{"properties":{"project":"memry://note/a"}}"#],
            )
            .map_err(failed)?;
            assert!(in_use(c, "project")?);
            assert!(!in_use(c, "rating")?);
            c.execute("UPDATE sync_items SET deleted_at = 2", [])
                .map_err(failed)?;
            assert!(!in_use(c, "project")?);
            Ok(())
        })
        .expect("in use");
    }

    /// A value a newer build wrote in a shape this one cannot read is kept: nothing is learned
    /// over it.
    #[test]
    fn a_stored_value_that_does_not_read_is_not_replaced() {
        let dir = temp_dir("props-learned-unread");
        let db = open_data(&dir.path().join("data.db")).expect("open");
        db.call_blocking(|c| {
            let newer = r#"[{"name":"rating","type":"number"}]"#;
            c.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)",
                params![LEARNED, newer],
            )
            .map_err(failed)?;
            assert!(learned(c)?.is_empty());
            assert!(learn(c, &types(&[("site", "url")])).is_err());
            let held: String = c
                .query_row("SELECT value FROM meta WHERE key = ?1", [LEARNED], |row| {
                    row.get(0)
                })
                .map_err(failed)?;
            assert_eq!(held, newer);
            Ok(())
        })
        .expect("kept");
    }
}
