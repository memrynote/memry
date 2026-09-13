//! Synced settings (T130, Q13.1, FR-033, FR-063).
//!
//! One sync item, id `synced_settings` (chapter 13 §13.6), payload
//! `{ settings, fieldClocks }` (§13.7.13), merged by **dotted path at arbitrary
//! depth** (chapter 06 §6.9).
//!
//! ## Why this module parses raw JSON and not a schema
//!
//! `SyncedSettingsSchema` is a closed object, so a parse **strips a group this
//! build does not model** — `experimental` among them — exactly as §13.2.1
//! describes for every other type. §13.10's answer to Q13.1 is that there is
//! no settings-specific preservation mechanism and none is needed: the verbatim
//! `sync_items.payload` is the copy.
//!
//! That answer only holds if the **write** path never re-serialises the read
//! view. So every function here walks the raw parsed object out of
//! [`StoredPayload::object`] and hands the changed object back through
//! [`StoredPayload::merge`] (§13.2 rule 3). A sibling group is carried by
//! **clone and mutate**, never by rebuild, so `experimental` survives a write
//! to `general.theme` byte for byte, and FR-063's "a preference with no
//! equivalent" comes back to desktop unchanged.
//!
//! The ten modelled groups
//! ([`MODELLED_GROUPS`](crate::storage::repositories::projectors::settings::MODELLED_GROUPS))
//! stay where they are — in the **projector**, which is the closed read view
//! the vectors pin. This module deliberately has no group list: a dotted-path
//! write is not a claim to model the group it writes into, and adding a filter
//! here would strip on write what §13.2 exists to preserve.
//!
//! ## The dotted path is a nested [`Change`]
//!
//! [`Change::Set`] with a `null` is §13.4's explicit clear; [`Change::Remove`]
//! drops the key so a receiver keeps its own value. This module applies exactly
//! that distinction one or more levels down, rather than inventing a second
//! vocabulary for it.
//!
//! **A change always ticks the path's field clock, including a removal.** A
//! removal that did not tick would lose to the peer that still holds the old
//! value, and the setting would resurrect on the next pull.

use rusqlite::{Connection, params};
use serde_json::{Map, Value};

use crate::api::errors::StorageError;
use crate::storage::repositories::projectors::settings::SETTINGS_ITEM_ID;
use crate::storage::repositories::{Change, StoredPayload, sync_items};
use crate::sync::clock::{self, VectorClock};
use crate::sync::outbox;

/// The item type half of the `(type, id)` key (§13.6).
pub const SETTINGS_ITEM_TYPE: &str = "settings";

/// The payload a vault with no settings item yet starts from.
///
/// Both keys are present because the reader marks both required (§13.7.13),
/// and it matches the committed `settings: boundary` vector exactly.
const EMPTY_PAYLOAD: &str = r#"{"settings":{},"fieldClocks":{}}"#;

/// Every synced setting, as the payload spells it — **including groups this
/// build does not model**.
///
/// This is the source of record, not the `settings` projection table. The
/// projection is the closed ten-group read view (§13.10.1); this is the raw
/// object, and reading a path out of it is not the same as modelling it.
///
/// A vault with no settings item has no settings, which is what an empty map
/// means here. A payload that will not parse is a **hard error**, never an
/// empty map: a silent empty would make the next [`set`] push a payload that
/// deleted every preference on every device.
pub fn all(conn: &Connection) -> Result<Map<String, Value>, StorageError> {
    let Some(payload) = stored(conn)? else {
        return Ok(Map::new());
    };
    settings_of(payload.object())
}

/// One setting by dotted path, for example `general.theme` or
/// `journal.weekdayTemplates.3`.
pub fn read(conn: &Connection, path: &str) -> Result<Option<Value>, StorageError> {
    let segments = segments(path)?;
    Ok(value_at(&all(conn)?, &segments).cloned())
}

/// The vector clock recorded against one dotted path (§6.9), or `None` for a
/// path no device has ticked.
pub fn field_clock(conn: &Connection, path: &str) -> Result<Option<VectorClock>, StorageError> {
    let Some(payload) = stored(conn)? else {
        return Ok(None);
    };
    let clocks = field_clocks_of(payload.object())?;
    clocks
        .get(path)
        .map(|value| read_clock(value, path))
        .transpose()
}

/// Writes one setting.
pub fn set(
    conn: &Connection,
    path: &str,
    value: Value,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    apply(conn, path, Change::Set(value), device_id, now_ms)
}

/// Clears one setting, leaving the key present and `null` (§13.4).
pub fn clear(
    conn: &Connection,
    path: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    apply(conn, path, Change::Set(Value::Null), device_id, now_ms)
}

/// Drops one setting, so a receiver keeps its own value for it (§13.4).
pub fn remove(
    conn: &Connection,
    path: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    apply(conn, path, Change::Remove, device_id, now_ms)
}

/// The one write, and the only place the payload is rebuilt.
///
/// The merged payload and the outbox row that publishes it commit together
/// (FR-030, data-model §A.2). A change that changes nothing rolls the
/// transaction back and pushes nothing.
///
/// The path should be the **leaf** the user edited. Chapter 06 §6.9's examples
/// are all leaves and the chapter says nothing about what becomes of the field
/// clocks under a path that replaces a whole subtree, so nothing here prunes
/// them: dropping a clock is not a reversible guess.
pub fn apply(
    conn: &Connection,
    path: &str,
    change: Change,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    let segments = segments(path)?;
    let tx = conn.unchecked_transaction().map_err(failed)?;
    ensure_item(&tx, now_ms)?;

    let payload = stored(&tx)?.ok_or_else(|| StorageError::Failed {
        what: format!("{SETTINGS_ITEM_TYPE}/{SETTINGS_ITEM_ID} has no payload to merge into"),
    })?;
    let mut settings = settings_of(payload.object())?;
    if !apply_at(&mut settings, &segments, &change, path)? {
        // Nothing changed, so nothing is written — not even the seed row.
        return Ok(payload.raw().to_owned());
    }

    let mut field_clocks = field_clocks_of(payload.object())?;
    let ticked = match field_clocks.get(path) {
        Some(value) => clock::increment(&read_clock(value, path)?, device_id),
        None => clock::increment(&VectorClock::new(), device_id),
    };
    field_clocks.insert(path.to_owned(), clock_value(&ticked));

    let changes = [
        ("settings", Change::Set(Value::Object(settings))),
        ("fieldClocks", Change::Set(Value::Object(field_clocks))),
    ];
    let merged = sync_items::apply_local_edit_in(
        &tx,
        SETTINGS_ITEM_TYPE,
        SETTINGS_ITEM_ID,
        &changes,
        now_ms,
    )?;
    outbox::enqueue(
        &tx,
        &outbox::Change::upsert(SETTINGS_ITEM_TYPE, SETTINGS_ITEM_ID),
        now_ms,
    )?;
    tx.commit().map_err(failed)?;
    Ok(merged)
}

/// Seeds the one settings item when the vault has never synced one.
///
/// `DO NOTHING` rather than an upsert: a row already there — including one
/// still `metadata-only`, whose body has not been pulled yet — is left exactly
/// as it is. Clobbering a body this device has not downloaded would lose every
/// preference the account already holds.
fn ensure_item(tx: &Connection, now_ms: i64) -> Result<(), StorageError> {
    tx.execute(
        "INSERT INTO sync_items (item_type, item_id, payload, payload_state, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(item_type, item_id) DO NOTHING",
        params![
            SETTINGS_ITEM_TYPE,
            SETTINGS_ITEM_ID,
            EMPTY_PAYLOAD,
            sync_items::PAYLOAD_STATE_FULL,
            now_ms
        ],
    )
    .map_err(failed)?;
    Ok(())
}

/// Applies one [`Change`] at a dotted path, reporting whether it changed
/// anything. Missing intermediate objects are created; a non-object in the way
/// is refused rather than overwritten, because overwriting it would delete
/// every sibling under it.
fn apply_at(
    node: &mut Map<String, Value>,
    segments: &[&str],
    change: &Change,
    path: &str,
) -> Result<bool, StorageError> {
    let (head, rest) = segments
        .split_first()
        .expect("`segments` rejects an empty path");

    if rest.is_empty() {
        return Ok(match change {
            Change::Set(value) => {
                let unchanged = node.get(*head) == Some(value);
                if !unchanged {
                    node.insert((*head).to_owned(), value.clone());
                }
                !unchanged
            }
            Change::Remove => node.remove(*head).is_some(),
        });
    }

    if !matches!(node.get(*head), Some(Value::Object(_))) {
        match node.get(*head) {
            None | Some(Value::Null) => {}
            Some(_) => {
                return Err(StorageError::Failed {
                    what: format!("settings `{path}`: `{head}` is not an object"),
                });
            }
        }
        if matches!(change, Change::Remove) {
            return Ok(false);
        }
        node.insert((*head).to_owned(), Value::Object(Map::new()));
    }

    let Some(Value::Object(child)) = node.get_mut(*head) else {
        unreachable!("an object was just ensured at `{head}`");
    };
    apply_at(child, rest, change, path)
}

/// The value at a dotted path, or `None` when any segment is missing.
fn value_at<'a>(node: &'a Map<String, Value>, segments: &[&str]) -> Option<&'a Value> {
    let (head, rest) = segments.split_first()?;
    let value = node.get(*head)?;
    if rest.is_empty() {
        return Some(value);
    }
    value_at(value.as_object()?, rest)
}

/// Splits a dotted path. An empty path, or one with an empty segment, is
/// refused: `general.` would write a `""` key that no peer could address.
fn segments(path: &str) -> Result<Vec<&str>, StorageError> {
    let parts: Vec<&str> = path.split('.').collect();
    if parts.iter().any(|part| part.is_empty()) {
        return Err(StorageError::Failed {
            what: format!("`{path}` is not a settings path"),
        });
    }
    Ok(parts)
}

/// The stored payload, or `None` when the vault has no settings item yet.
fn stored(conn: &Connection) -> Result<Option<StoredPayload>, StorageError> {
    let Some(row) = sync_items::load(conn, SETTINGS_ITEM_TYPE, SETTINGS_ITEM_ID)? else {
        return Ok(None);
    };
    let Some(stored) = row.payload else {
        return Ok(None);
    };
    StoredPayload::parse(&stored)
        .map(Some)
        .map_err(|error| StorageError::Failed {
            what: format!(
                "{SETTINGS_ITEM_TYPE}/{SETTINGS_ITEM_ID} payload will not parse: {error}"
            ),
        })
}

fn settings_of(object: &Map<String, Value>) -> Result<Map<String, Value>, StorageError> {
    object_at(object, "settings")
}

fn field_clocks_of(object: &Map<String, Value>) -> Result<Map<String, Value>, StorageError> {
    object_at(object, "fieldClocks")
}

/// One of the payload's two top-level objects. Absent and `null` are both
/// empty; anything else is an error rather than a substituted empty map.
fn object_at(object: &Map<String, Value>, key: &str) -> Result<Map<String, Value>, StorageError> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(Map::new()),
        Some(Value::Object(values)) => Ok(values.clone()),
        Some(_) => Err(StorageError::Failed {
            what: format!("settings payload: `{key}` is not an object"),
        }),
    }
}

/// A field clock as ticks. A clock that will not read is a hard error rather
/// than an empty clock: an empty one lowers `clockTotal` and changes who wins
/// the next merge (chapter 06 §6.10).
fn read_clock(value: &Value, path: &str) -> Result<VectorClock, StorageError> {
    let refuse = || StorageError::Failed {
        what: format!("settings `{path}`: field clock is not a vector clock"),
    };
    value
        .as_object()
        .ok_or_else(refuse)?
        .iter()
        .map(|(device, tick)| Ok((device.clone(), tick.as_u64().ok_or_else(refuse)?)))
        .collect()
}

fn clock_value(clock: &VectorClock) -> Value {
    Value::Object(
        clock
            .iter()
            .map(|(device, tick)| (device.clone(), Value::from(*tick)))
            .collect(),
    )
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::repositories::InboundRecord;
    use crate::storage::{Db, open_data, test_support::temp_dir};
    use serde_json::json;

    const NOW: i64 = 1_760_000_000_000;
    const DEVICE: &str = "device-b";

    /// The committed `settings: an unknown field a newer client wrote` vector,
    /// byte for byte: one modelled group, one the ten-group read view strips.
    const SYNCED: &str = concat!(
        r#"{"settings":{"general":{"theme":"dark"},"experimental":{"agentSidebar":true}},"#,
        r#""fieldClocks":{"general.theme":{"device-a":1},"experimental.agentSidebar":{"device-a":1}}}"#
    );

    fn open(
        label: &str,
        payload_json: Option<&str>,
    ) -> (Db, crate::storage::test_support::TempDir) {
        let dir = temp_dir(label);
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        if let Some(payload_json) = payload_json {
            db.call_blocking(|conn| {
                let record = InboundRecord {
                    item_type: SETTINGS_ITEM_TYPE.to_owned(),
                    item_id: SETTINGS_ITEM_ID.to_owned(),
                    payload_json: payload_json.to_owned(),
                    server_cursor: Some(7),
                    signer_device_id: Some("device-a".to_owned()),
                    updated_at: NOW,
                    deleted_at: None,
                };
                sync_items::apply_remote(conn, &record, NOW)?;
                Ok(())
            })
            .expect("seed");
        }
        (db, dir)
    }

    #[test]
    fn a_write_to_a_modelled_group_leaves_an_unmodelled_one_verbatim() {
        let (db, _dir) = open("settings-unmodelled", Some(SYNCED));
        db.call_blocking(|conn| {
            let merged = set(conn, "general.theme", json!("light"), DEVICE, NOW + 1)?;
            let parsed: Value = serde_json::from_str(&merged).expect("valid JSON");

            assert_eq!(parsed["settings"]["general"]["theme"], json!("light"));
            assert_eq!(
                parsed["settings"]["experimental"],
                json!({"agentSidebar": true}),
                "FR-063: a group this core does not model must survive the write"
            );
            assert_eq!(
                parsed["fieldClocks"]["experimental.agentSidebar"],
                json!({"device-a": 1}),
                "a clock for a path this build cannot model survives too (§6.9)"
            );
            assert_eq!(
                parsed["fieldClocks"]["general.theme"],
                json!({"device-a": 1, "device-b": 1})
            );

            // And the projection stays the closed ten-group read view.
            let indexed: Vec<String> = {
                let mut statement = conn
                    .prepare("SELECT \"group\" FROM settings ORDER BY \"group\"")
                    .expect("prepare");
                let mapped = statement
                    .query_map([], |row| row.get::<_, String>(0))
                    .expect("query");
                mapped.map(|row| row.expect("row")).collect()
            };
            assert_eq!(indexed, vec!["general".to_owned()]);
            Ok(())
        })
        .expect("unmodelled");
    }

    #[test]
    fn a_deep_path_creates_its_intermediates_and_clocks_the_leaf() {
        let (db, _dir) = open("settings-deep", Some(SYNCED));
        db.call_blocking(|conn| {
            set(
                conn,
                "journal.weekdayTemplates.3",
                json!("tpl-wed"),
                DEVICE,
                NOW + 1,
            )?;
            assert_eq!(
                read(conn, "journal.weekdayTemplates.3")?,
                Some(json!("tpl-wed"))
            );
            assert_eq!(
                field_clock(conn, "journal.weekdayTemplates.3")?,
                Some(clock::clock_of([(DEVICE, 1)]))
            );
            // Ancestors are plain objects with no clock of their own.
            assert_eq!(field_clock(conn, "journal")?, None);
            Ok(())
        })
        .expect("deep");
    }

    #[test]
    fn a_vault_with_no_settings_item_yet_gets_one_on_the_first_write() {
        let (db, _dir) = open("settings-seed", None);
        db.call_blocking(|conn| {
            assert!(all(conn)?.is_empty());
            set(conn, "general.theme", json!("dark"), DEVICE, NOW)?;

            assert_eq!(read(conn, "general.theme")?, Some(json!("dark")));
            let queued: i64 = conn
                .query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))
                .expect("outbox");
            assert_eq!(queued, 1);
            Ok(())
        })
        .expect("seed");
    }

    #[test]
    fn a_write_that_changes_nothing_seeds_nothing_and_pushes_nothing() {
        let (db, _dir) = open("settings-noop", None);
        db.call_blocking(|conn| {
            // A removal on a vault with no settings item at all.
            remove(conn, "general.theme", DEVICE, NOW)?;
            assert!(sync_items::load(conn, SETTINGS_ITEM_TYPE, SETTINGS_ITEM_ID)?.is_none());

            set(conn, "general.theme", json!("dark"), DEVICE, NOW)?;
            let again = set(conn, "general.theme", json!("dark"), DEVICE, NOW + 1)?;
            assert_eq!(
                serde_json::from_str::<Value>(&again).expect("json")["fieldClocks"]
                    ["general.theme"],
                json!({"device-b": 1}),
                "re-writing the same value must not tick the clock"
            );
            let queued: i64 = conn
                .query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))
                .expect("outbox");
            assert_eq!(queued, 1);
            Ok(())
        })
        .expect("noop");
    }

    #[test]
    fn a_clear_is_a_null_and_a_removal_drops_the_key_and_both_tick() {
        let (db, _dir) = open("settings-clear", Some(SYNCED));
        db.call_blocking(|conn| {
            clear(conn, "general.theme", DEVICE, NOW + 1)?;
            assert_eq!(read(conn, "general.theme")?, Some(Value::Null));

            remove(conn, "experimental.agentSidebar", DEVICE, NOW + 2)?;
            assert_eq!(read(conn, "experimental.agentSidebar")?, None);
            assert_eq!(
                field_clock(conn, "experimental.agentSidebar")?,
                Some(clock::clock_of([("device-a", 1), (DEVICE, 1)])),
                "a removal that did not tick would lose to the peer holding the old value"
            );
            Ok(())
        })
        .expect("clear");
    }

    #[test]
    fn a_non_object_in_the_path_is_refused_rather_than_overwritten() {
        let (db, _dir) = open("settings-blocked", Some(SYNCED));
        db.call_blocking(|conn| {
            let refused = set(conn, "general.theme.tint", json!("warm"), DEVICE, NOW + 1);
            assert!(matches!(refused, Err(StorageError::Failed { .. })));
            assert_eq!(read(conn, "general.theme")?, Some(json!("dark")));

            assert!(set(conn, "", json!(1), DEVICE, NOW + 1).is_err());
            assert!(set(conn, "general.", json!(1), DEVICE, NOW + 1).is_err());
            Ok(())
        })
        .expect("blocked");
    }

    #[test]
    fn a_payload_that_will_not_read_is_an_error_and_never_an_empty_map() {
        let (db, _dir) = open(
            "settings-unreadable",
            Some(r#"{"settings":[],"fieldClocks":{}}"#),
        );
        db.call_blocking(|conn| {
            assert!(all(conn).is_err());
            assert!(set(conn, "general.theme", json!("dark"), DEVICE, NOW + 1).is_err());
            Ok(())
        })
        .expect("unreadable");
    }
}
