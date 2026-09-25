//! Property **definition** edits (spec 006 ST17), after desktop
//! `vault/property-definitions.ts`: add, rename, recolour, remove and reorder
//! an option, and delete a definition.
//!
//! The synced `property_definition` item (id = the property name) carries
//! `options` as opaque JSON **text** (§13.7.9). Desktop writes two shapes into
//! it: an array of `{value, color, …}` for select / multiselect, and
//! `{"categories": {<key>: {…, "options": [...]}}}` for status. Every edit here
//! parses that text, changes only the option entries it names (other keys on
//! an option and on a category ride along), and writes the text back.
//!
//! Desktop's option rename and definition delete do **not** rewrite note
//! values, so neither does this (spec 006 §6).

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::domain::notes::{self, edit, failed, tombstone_local};
use crate::storage::repositories::{Change, sync_items};
use crate::sync::outbox;

pub const ITEM_TYPE: &str = "property_definition";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropertyOption {
    pub value: String,
    pub color: Option<String>,
    /// The status category key (`todo`, `in_progress`, `done`), or `None`.
    pub category: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropertySummary {
    pub name: String,
    pub type_name: String,
    pub options: Vec<PropertyOption>,
    /// Live notes and journal entries that carry a value for it.
    pub used_in: i64,
}

fn refuse(what: String) -> StorageError {
    StorageError::Invalid { what }
}

/// The options as `(category, entries)` groups, in stored order.
fn groups(options: &Value) -> Vec<(Option<String>, Vec<Value>)> {
    if let Some(array) = options.as_array() {
        return vec![(None, array.clone())];
    }
    options
        .get("categories")
        .and_then(Value::as_object)
        .map(|categories| {
            categories
                .iter()
                .map(|(key, category)| {
                    (
                        Some(key.clone()),
                        category
                            .get("options")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

fn flatten(options: &Value) -> Vec<PropertyOption> {
    groups(options)
        .into_iter()
        .flat_map(|(category, entries)| {
            entries.into_iter().filter_map(move |entry| {
                Some(PropertyOption {
                    value: entry.get("value")?.as_str()?.to_owned(),
                    color: entry
                        .get("color")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    category: category.clone(),
                })
            })
        })
        .collect()
}

/// Applies `change` to every option array in `options`.
fn map_arrays(options: &mut Value, mut change: impl FnMut(Option<&str>, &mut Vec<Value>)) {
    if let Some(array) = options.as_array_mut() {
        change(None, array);
        return;
    }
    if let Some(categories) = options.get_mut("categories").and_then(Value::as_object_mut) {
        for (key, category) in categories.iter_mut() {
            if let Some(array) = category.get_mut("options").and_then(Value::as_array_mut) {
                change(Some(key), array);
            }
        }
    }
}

fn is_value(entry: &Value, value: &str) -> bool {
    entry.get("value").and_then(Value::as_str) == Some(value)
}

/// Every live definition with its options and usage.
pub fn list(conn: &Connection) -> Result<Vec<PropertySummary>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT s.item_id,
                    COALESCE(json_extract(s.payload, '$.type'), ''),
                    json_extract(s.payload, '$.options'),
                    (SELECT count(*) FROM sync_items n
                      WHERE n.item_type IN ('note', 'journal') AND n.deleted_at IS NULL
                        AND json_valid(n.payload)
                        AND json_type(n.payload, '$.properties') = 'object'
                        AND json_type(json_extract(n.payload, '$.properties'),
                                      '$.\"' || replace(s.item_id, '\"', '') || '\"') IS NOT NULL)
               FROM sync_items s
              WHERE s.item_type = ?1 AND s.deleted_at IS NULL
                AND s.payload IS NOT NULL AND json_valid(s.payload)
              ORDER BY s.item_id COLLATE NOCASE",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![ITEM_TYPE], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(failed)?;
    let mut out = Vec::new();
    for row in rows {
        let (name, type_name, options, used_in) = row.map_err(failed)?;
        let parsed = options
            .as_deref()
            .and_then(|text| serde_json::from_str(text).ok())
            .unwrap_or(Value::Null);
        out.push(PropertySummary {
            name,
            type_name,
            options: flatten(&parsed),
            used_in,
        });
    }
    Ok(out)
}

/// Reads, changes and writes back one definition's `options` text.
fn edit_options(
    conn: &Connection,
    name: &str,
    device_id: &str,
    now_ms: i64,
    change: impl FnOnce(&str, &mut Value) -> Result<(), StorageError>,
) -> Result<(), StorageError> {
    let stored = notes::require_payload(conn, ITEM_TYPE, name)?;
    let type_name = stored
        .object()
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let mut options: Value = match stored.object().get("options") {
        Some(Value::String(text)) => serde_json::from_str(text)
            .map_err(|error| refuse(format!("property `{name}` options: {error}")))?,
        _ if type_name == "status" => {
            return Err(refuse(format!(
                "status property `{name}` has no categories"
            )));
        }
        _ => json!([]),
    };
    let before = options.clone();
    change(&type_name, &mut options)?;
    if options == before {
        return Ok(());
    }
    edit(
        conn,
        ITEM_TYPE,
        name,
        vec![("options", Change::set(options.to_string()))],
        device_id,
        now_ms,
    )?
    .acknowledge();
    Ok(())
}

/// Adds an option. `category` is required for a status property (desktop
/// `addStatusOption`) and ignored otherwise. An existing value is a no-op.
pub fn add_option(
    conn: &Connection,
    name: &str,
    value: &str,
    color: &str,
    category: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(refuse("an option needs a name".into()));
    }
    edit_options(conn, name, device_id, now_ms, |type_name, options| {
        if flatten(options).iter().any(|o| o.value == value) {
            return Ok(());
        }
        let entry = json!({ "value": value, "color": color });
        if type_name == "status" {
            let key = category.ok_or_else(|| refuse("a status option needs a category".into()))?;
            let target = options
                .get_mut("categories")
                .and_then(|c| c.get_mut(key))
                .and_then(|c| c.get_mut("options"))
                .and_then(Value::as_array_mut)
                .ok_or_else(|| refuse(format!("unknown status category `{key}`")))?;
            target.push(entry);
        } else if let Some(array) = options.as_array_mut() {
            array.push(entry);
        }
        Ok(())
    })
}

pub fn rename_option(
    conn: &Connection,
    name: &str,
    old: &str,
    new: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let new = new.trim();
    if new.is_empty() {
        return Err(refuse("an option needs a name".into()));
    }
    if new == old {
        return Ok(());
    }
    edit_options(conn, name, device_id, now_ms, |_, options| {
        map_arrays(options, |_, array| {
            for entry in array.iter_mut().filter(|e| is_value(e, old)) {
                entry["value"] = json!(new);
            }
        });
        Ok(())
    })
}

pub fn set_option_color(
    conn: &Connection,
    name: &str,
    value: &str,
    color: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    edit_options(conn, name, device_id, now_ms, |_, options| {
        map_arrays(options, |_, array| {
            for entry in array.iter_mut().filter(|e| is_value(e, value)) {
                entry["color"] = json!(color);
            }
        });
        Ok(())
    })
}

pub fn remove_option(
    conn: &Connection,
    name: &str,
    value: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    edit_options(conn, name, device_id, now_ms, |_, options| {
        map_arrays(options, |_, array| array.retain(|e| !is_value(e, value)));
        Ok(())
    })
}

/// Reorders options to follow `values`. A status property reorders within
/// each category; a value not named keeps its place after the named ones.
pub fn reorder_options(
    conn: &Connection,
    name: &str,
    values: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let rank = |entry: &Value| {
        entry
            .get("value")
            .and_then(Value::as_str)
            .and_then(|v| values.iter().position(|w| w == v))
            .unwrap_or(usize::MAX)
    };
    edit_options(conn, name, device_id, now_ms, |_, options| {
        map_arrays(options, |_, array| array.sort_by_key(rank));
        Ok(())
    })
}

/// Tombstones the definition. Note values are left as they are (desktop).
pub fn delete_definition(
    conn: &Connection,
    name: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let live = sync_items::load(conn, ITEM_TYPE, name)?.is_some_and(|row| row.deleted_at.is_none());
    if !live {
        return Err(refuse(format!("no property `{name}`")));
    }
    outbox::commit(
        conn,
        &outbox::Change::delete(ITEM_TYPE, name),
        now_ms,
        |tx| tombstone_local(tx, ITEM_TYPE, name, device_id, now_ms),
    )?
    .acknowledge();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::repositories::InboundRecord;
    use crate::storage::{Db, open_data, test_support::temp_dir};

    const NOW: i64 = 1_760_000_000_000;

    fn seed(db: &Db, item_type: &str, id: &str, payload: Value) {
        db.call_blocking(|conn| {
            sync_items::apply_remote(
                conn,
                &InboundRecord {
                    item_type: item_type.into(),
                    item_id: id.into(),
                    payload_json: payload.to_string(),
                    server_cursor: Some(1),
                    signer_device_id: None,
                    updated_at: NOW,
                    deleted_at: None,
                },
                NOW,
            )?;
            Ok(())
        })
        .expect("seed");
    }

    fn vault(label: &str) -> (Db, crate::storage::test_support::TempDir) {
        let dir = temp_dir(label);
        let db = open_data(&dir.path().join("data.db")).expect("open");
        let select =
            json!([{"value":"Work","color":"blue","extra":1},{"value":"Home","color":"sage"}]);
        seed(
            &db,
            ITEM_TYPE,
            "area",
            json!({"name":"area","type":"select","options":select.to_string(),"clock":{"d":1}}),
        );
        let status = json!({"categories":{
            "todo":{"label":"To do","options":[{"value":"Not started","color":"stone"}]},
            "done":{"label":"Done","options":[{"value":"Done","color":"sage"}]}}});
        seed(
            &db,
            ITEM_TYPE,
            "status",
            json!({"name":"status","type":"status","options":status.to_string(),"clock":{"d":1}}),
        );
        seed(
            &db,
            "note",
            "n1",
            json!({"title":"a","properties":{"area":"Work"},"clock":{"d":1}}),
        );
        (db, dir)
    }

    fn find(db: &Db, name: &str) -> PropertySummary {
        db.call_blocking(|c| list(c))
            .expect("list")
            .into_iter()
            .find(|p| p.name == name)
            .expect("definition")
    }

    fn raw_options(db: &Db, name: &str) -> Value {
        db.call_blocking(|c| {
            let stored = notes::require_payload(c, ITEM_TYPE, name)?;
            Ok(
                serde_json::from_str(stored.object()["options"].as_str().expect("text"))
                    .expect("json"),
            )
        })
        .expect("options")
    }

    #[test]
    fn list_reads_both_shapes_and_counts_usage() {
        let (db, _d) = vault("props-list");
        let area = find(&db, "area");
        assert_eq!(area.used_in, 1);
        assert_eq!(
            area.options
                .iter()
                .map(|o| o.value.as_str())
                .collect::<Vec<_>>(),
            vec!["Work", "Home"]
        );
        let status = find(&db, "status");
        assert_eq!(status.options[0].category.as_deref(), Some("done"));
    }

    #[test]
    fn option_edits_keep_unknown_keys_and_the_text_shape() {
        let (db, _d) = vault("props-edit");
        db.call_blocking(|c| {
            rename_option(c, "area", "Work", "Job", "p", NOW + 1)?;
            set_option_color(c, "area", "Job", "rose", "p", NOW + 2)?;
            add_option(c, "area", "Gym", "mint", None, "p", NOW + 3)?;
            reorder_options(
                c,
                "area",
                &["Gym".into(), "Home".into(), "Job".into()],
                "p",
                NOW + 4,
            )?;
            remove_option(c, "area", "Home", "p", NOW + 5)?;
            Ok(())
        })
        .expect("edits");
        assert_eq!(
            raw_options(&db, "area"),
            json!([{"value":"Gym","color":"mint"},{"value":"Job","color":"rose","extra":1}])
        );
    }

    #[test]
    fn status_options_stay_inside_their_category() {
        let (db, _d) = vault("props-status");
        db.call_blocking(|c| {
            add_option(c, "status", "Blocked", "coral", Some("todo"), "p", NOW + 1)?;
            assert!(add_option(c, "status", "X", "coral", None, "p", NOW + 2).is_err());
            rename_option(c, "status", "Done", "Shipped", "p", NOW + 3)?;
            Ok(())
        })
        .expect("status");
        let options = raw_options(&db, "status");
        assert_eq!(
            options["categories"]["todo"]["options"][1]["value"],
            json!("Blocked")
        );
        assert_eq!(options["categories"]["todo"]["label"], json!("To do"));
        assert_eq!(
            options["categories"]["done"]["options"][0]["value"],
            json!("Shipped")
        );
    }

    #[test]
    fn deleting_a_definition_tombstones_it_and_leaves_note_values() {
        let (db, _d) = vault("props-delete");
        db.call_blocking(|c| delete_definition(c, "area", "p", NOW + 1))
            .expect("delete");
        assert!(
            db.call_blocking(|c| list(c))
                .expect("list")
                .iter()
                .all(|p| p.name != "area")
        );
        db.call_blocking(|c| {
            let note = notes::require_payload(c, "note", "n1")?;
            assert_eq!(note.object()["properties"]["area"], json!("Work"));
            Ok(())
        })
        .expect("note");
        assert!(
            db.call_blocking(|c| delete_definition(c, "area", "p", NOW + 2))
                .is_err()
        );
    }
}
