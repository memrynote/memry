//! Task settings (spec 004 TP023), against real SQLite.
//!
//! Every fixture is seeded through the real apply path, so the settings item
//! these reads parse is the one a pull would have written.
//!
//! | Test                                                   | Rule                              |
//! | ------------------------------------------------------ | --------------------------------- |
//! | a vault with no settings reads desktop's defaults      | `TASK_SETTINGS_DEFAULTS`          |
//! | invalid synced values read as their defaults           | schema coercion                   |
//! | a whole-number float reads as an integer               | `staleInboxDays` is a JSON number |
//! | a synced write ticks its dotted path and keeps others  | §6.9, §13.10                      |
//! | clearing the default project writes an explicit null   | §13.4                             |
//! | an invalid write is refused and writes nothing         | never publish a rejected value    |
//! | re-writing the same value pushes nothing               | no-op writes                      |
//! | the default view is local and never on the wire        | `defaultView` is local-only       |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::domain::task_settings::{self, TaskSettings};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-b";

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-domain-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn seed_settings(conn: &Connection, payload: Value) {
    let outcome = sync_items::apply_remote(
        conn,
        &InboundRecord {
            item_type: "settings".to_owned(),
            item_id: "synced_settings".to_owned(),
            payload_json: serde_json::to_string(&payload).expect("serialise"),
            server_cursor: Some(7),
            signer_device_id: Some("device-a".to_owned()),
            updated_at: NOW,
            deleted_at: None,
        },
        NOW,
    )
    .expect("apply");
    assert_eq!(outcome, sync_items::ApplyOutcome::Applied);
}

/// A desktop-written payload with a `tasks` key this build does not model and
/// a whole group it does not model, each with its field clock.
fn seeded() -> Value {
    json!({
        "settings": {
            "tasks": {"defaultProjectId": "proj-1", "staleInboxDays": 14, "showCompleted": true},
            "experimental": {"agentSidebar": true}
        },
        "fieldClocks": {
            "tasks.defaultProjectId": {"device-a": 2},
            "tasks.staleInboxDays": {"device-a": 1},
            "tasks.showCompleted": {"device-a": 1},
            "experimental.agentSidebar": {"device-a": 1}
        }
    })
}

fn payload(conn: &Connection) -> Option<Value> {
    sync_items::load(conn, "settings", "synced_settings")
        .expect("load")
        .and_then(|row| row.payload)
        .map(|raw| serde_json::from_str(&raw).expect("payload JSON"))
}

fn outbox_rows(conn: &Connection) -> Vec<(String, String, String)> {
    let mut statement = conn
        .prepare("SELECT item_type, item_id, op FROM outbox ORDER BY id")
        .expect("prepare");
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("query");
    rows.map(|row| row.expect("row")).collect()
}

#[test]
fn a_vault_with_no_settings_reads_desktops_defaults() {
    let db = open("task-settings-defaults");
    db.call_blocking(|conn| {
        let read = task_settings::read(conn)?;
        assert_eq!(read, TaskSettings::default());
        assert_eq!(
            read,
            TaskSettings {
                default_project_id: None,
                default_sort_order: "manual".to_owned(),
                default_view: "all".to_owned(),
                stale_inbox_days: 7,
            }
        );
        assert!(payload(conn).is_none(), "a read never seeds the item");
        assert!(outbox_rows(conn).is_empty());
        Ok(())
    })
    .expect("defaults");
}

#[test]
fn invalid_synced_values_read_as_their_defaults() {
    for (tasks, label) in [
        (
            json!({"defaultProjectId": 42, "defaultSortOrder": "bogus", "staleInboxDays": 0}),
            "wrong types, unknown enum, below range",
        ),
        (
            json!({"defaultProjectId": null, "defaultSortOrder": 3, "staleInboxDays": 91}),
            "null project, non-string enum, above range",
        ),
        (json!({"staleInboxDays": 7.5}), "fractional days"),
        (json!({"staleInboxDays": "10"}), "days as a string"),
        (json!("not an object"), "group is not an object"),
    ] {
        let db = open("task-settings-coerce");
        db.call_blocking(|conn| {
            seed_settings(
                conn,
                json!({"settings": {"tasks": tasks}, "fieldClocks": {}}),
            );
            assert_eq!(
                task_settings::read(conn)?,
                TaskSettings::default(),
                "{label}"
            );
            Ok(())
        })
        .expect("coerce");
    }
}

#[test]
fn valid_synced_values_read_through_including_a_whole_number_float() {
    let db = open("task-settings-valid");
    db.call_blocking(|conn| {
        seed_settings(
            conn,
            json!({
                "settings": {"tasks": {
                    "defaultProjectId": "proj-1",
                    "defaultSortOrder": "priority",
                    "staleInboxDays": 30.0
                }},
                "fieldClocks": {}
            }),
        );
        let read = task_settings::read(conn)?;
        assert_eq!(read.default_project_id.as_deref(), Some("proj-1"));
        assert_eq!(read.default_sort_order, "priority");
        assert_eq!(read.stale_inbox_days, 30);
        assert_eq!(read.default_view, "all");
        Ok(())
    })
    .expect("valid");
}

#[test]
fn a_synced_write_ticks_its_dotted_path_and_keeps_every_other_key() {
    let db = open("task-settings-write");
    db.call_blocking(|conn| {
        seed_settings(conn, seeded());

        let after = task_settings::set_default_project(conn, Some("proj-2"), DEVICE, NOW + 1)?;
        assert_eq!(after.default_project_id.as_deref(), Some("proj-2"));
        let after = task_settings::set_default_sort_order(conn, "dueDate", DEVICE, NOW + 2)?;
        assert_eq!(after.default_sort_order, "dueDate");
        let after = task_settings::set_stale_inbox_days(conn, 90, DEVICE, NOW + 3)?;
        assert_eq!(after.stale_inbox_days, 90);

        let stored = payload(conn).expect("payload");
        assert_eq!(
            stored["settings"],
            json!({
                "tasks": {
                    "defaultProjectId": "proj-2",
                    "defaultSortOrder": "dueDate",
                    "staleInboxDays": 90,
                    "showCompleted": true
                },
                "experimental": {"agentSidebar": true}
            })
        );
        assert_eq!(
            stored["fieldClocks"],
            json!({
                "tasks.defaultProjectId": {"device-a": 2, "device-b": 1},
                "tasks.defaultSortOrder": {"device-b": 1},
                "tasks.staleInboxDays": {"device-a": 1, "device-b": 1},
                "tasks.showCompleted": {"device-a": 1},
                "experimental.agentSidebar": {"device-a": 1}
            })
        );
        assert!(
            stored.get("defaultView").is_none()
                && stored["settings"]["tasks"].get("defaultView").is_none(),
            "defaultView is never on the wire"
        );

        // Each write enqueued; a record enqueue supersedes the older row, so
        // one row remains, stamped by the last write.
        assert_eq!(
            outbox_rows(conn),
            vec![(
                "settings".to_owned(),
                "synced_settings".to_owned(),
                "upsert".to_owned()
            )]
        );
        let enqueued_at: i64 = conn
            .query_row("SELECT enqueued_at FROM outbox", [], |row| row.get(0))
            .expect("enqueued_at");
        assert_eq!(enqueued_at, NOW + 3);
        Ok(())
    })
    .expect("write");
}

#[test]
fn clearing_the_default_project_writes_an_explicit_null_and_ticks() {
    let db = open("task-settings-clear");
    db.call_blocking(|conn| {
        seed_settings(conn, seeded());
        let after = task_settings::set_default_project(conn, None, DEVICE, NOW + 1)?;
        assert_eq!(after.default_project_id, None);

        let stored = payload(conn).expect("payload");
        assert_eq!(stored["settings"]["tasks"]["defaultProjectId"], Value::Null);
        assert!(
            stored["settings"]["tasks"]
                .as_object()
                .expect("tasks group")
                .contains_key("defaultProjectId"),
            "a clear is a present null, not an absent key"
        );
        assert_eq!(
            stored["fieldClocks"]["tasks.defaultProjectId"],
            json!({"device-a": 2, "device-b": 1})
        );
        assert_eq!(outbox_rows(conn).len(), 1);
        Ok(())
    })
    .expect("clear");
}

#[test]
fn a_write_to_a_vault_with_no_settings_item_seeds_it() {
    let db = open("task-settings-seed");
    db.call_blocking(|conn| {
        task_settings::set_stale_inbox_days(conn, 1, DEVICE, NOW)?;
        let stored = payload(conn).expect("payload");
        assert_eq!(stored["settings"], json!({"tasks": {"staleInboxDays": 1}}));
        assert_eq!(
            stored["fieldClocks"],
            json!({"tasks.staleInboxDays": {"device-b": 1}})
        );
        assert_eq!(outbox_rows(conn).len(), 1);
        Ok(())
    })
    .expect("seed");
}

#[test]
fn an_invalid_write_is_refused_and_writes_nothing() {
    let db = open("task-settings-refuse");
    db.call_blocking(|conn| {
        seed_settings(conn, seeded());
        let before = payload(conn);

        assert!(task_settings::set_default_sort_order(conn, "title", DEVICE, NOW + 1).is_err());
        assert!(task_settings::set_default_sort_order(conn, "Manual", DEVICE, NOW + 1).is_err());
        assert!(task_settings::set_stale_inbox_days(conn, 0, DEVICE, NOW + 1).is_err());
        assert!(task_settings::set_stale_inbox_days(conn, 91, DEVICE, NOW + 1).is_err());
        assert!(task_settings::set_default_view(conn, "archived").is_err());

        assert_eq!(payload(conn), before);
        assert!(outbox_rows(conn).is_empty());
        assert_eq!(task_settings::read(conn)?.default_view, "all");
        Ok(())
    })
    .expect("refuse");
}

#[test]
fn re_writing_the_same_value_pushes_nothing() {
    let db = open("task-settings-noop");
    db.call_blocking(|conn| {
        seed_settings(conn, seeded());
        task_settings::set_default_project(conn, Some("proj-1"), DEVICE, NOW + 1)?;
        task_settings::set_stale_inbox_days(conn, 14, DEVICE, NOW + 2)?;

        let stored = payload(conn).expect("payload");
        assert_eq!(stored, seeded(), "an unchanged value ticks no clock");
        assert!(outbox_rows(conn).is_empty());
        Ok(())
    })
    .expect("noop");
}

#[test]
fn the_default_view_is_local_and_never_on_the_wire() {
    let db = open("task-settings-view");
    db.call_blocking(|conn| {
        seed_settings(conn, seeded());
        let before = payload(conn);

        for view in ["today", "tomorrow", "next7", "all"] {
            assert_eq!(
                task_settings::set_default_view(conn, view)?.default_view,
                view
            );
        }
        task_settings::set_default_view(conn, "next7")?;
        assert_eq!(task_settings::read(conn)?.default_view, "next7");

        assert_eq!(payload(conn), before, "the synced payload is untouched");
        assert!(
            outbox_rows(conn).is_empty(),
            "a local setting pushes nothing"
        );

        // A value an older or newer build left in meta reads as `all`.
        conn.execute(
            "UPDATE meta SET value = 'someday' WHERE key = ?1",
            [task_settings::DEFAULT_VIEW_META_KEY],
        )
        .expect("update meta");
        assert_eq!(task_settings::read(conn)?.default_view, "all");
        Ok(())
    })
    .expect("view");
}
