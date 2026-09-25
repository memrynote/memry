//! Saved filters (`filter`, spec 004 TP022) against real SQLite.
//!
//! | Test                                                   | Rule                          |
//! | ------------------------------------------------------ | ----------------------------- |
//! | the declaration subscribes to `filter`                 | chapter 13 §13.1              |
//! | an inbound desktop payload projects and stays verbatim | §13.2 rules 1-2, §6.8 row 4   |
//! | a dominating local clock skips a stale remote          | §6.3.1                        |
//! | an inbound tombstone hides the filter                  | §5.12                         |
//! | a create writes desktop's payload shape and queues it  | FR-030, desktop filter-sync   |
//! | an update keeps config keys this build does not model  | §13.2 rule 3, D7              |
//! | star and unstar write `config.starred`                 | desktop `toggleStar`          |
//! | a delete tombstones, ticks the clock, queues a delete  | desktop `enqueueDelete`       |
//! | a reorder rewrites only the filters that moved         | desktop `reorderSavedFilters` |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::domain::saved_filters::{self, NewSavedFilter};
use memry_core::domain::task_filter::{CompletionFilter, SortDirection, SortField};
use memry_core::protocol::types::{ArrivingItemType, Declaration};
use memry_core::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use memry_core::storage::{Db, open_data};
use memry_core::sync::apply::apply_inbound;
use rusqlite::{Connection, params};
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-saved-filters-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn payload_of(conn: &Connection, item_id: &str) -> Value {
    let raw = sync_items::push_payload(conn, "filter", item_id)
        .expect("read the row")
        .expect("a payload");
    serde_json::from_str(&raw).expect("valid JSON")
}

fn outbox(conn: &Connection) -> Vec<(String, String, String)> {
    let mut statement = conn
        .prepare("SELECT item_type, item_id, op FROM outbox ORDER BY id")
        .expect("prepare");
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

/// What desktop pushes: `JSON.stringify` of its `saved_filters` row, `id` and
/// `syncedAt` included, with a config key this build does not model.
fn desktop_payload(clock: Value) -> Value {
    json!({
        "id": "flt_desktop_000000001",
        "name": "Due this week",
        "config": {
            "filters": {
                "search": "",
                "projectIds": ["proj-1"],
                "priorities": ["high"],
                "tags": [],
                "dueDate": { "type": "this-week", "customStart": null, "customEnd": null },
                "statusIds": [],
                "completion": "all",
                "repeatType": "all",
                "hasTime": "all",
            },
            "sort": { "field": "dueDate", "direction": "asc" },
            "starred": true,
            "groupBy": "project",
        },
        "position": 3,
        "createdAt": "2025-10-09T08:53:20.000Z",
        "clock": clock,
        "syncedAt": null,
    })
}

fn inbound(item_id: &str, payload: &Value, deleted_at: Option<i64>) -> InboundRecord {
    InboundRecord {
        item_type: "filter".to_owned(),
        item_id: item_id.to_owned(),
        payload_json: serde_json::to_string(payload).expect("serialise"),
        server_cursor: Some(7),
        signer_device_id: Some("device-desktop".to_owned()),
        updated_at: NOW,
        deleted_at,
    }
}

fn config() -> Value {
    json!({
        "filters": {
            "search": "",
            "projectIds": [],
            "priorities": ["urgent"],
            "tags": [],
            "dueDate": { "type": "any", "customStart": null, "customEnd": null },
            "statusIds": [],
            "completion": "active",
            "repeatType": "all",
            "hasTime": "all",
        },
    })
}

fn create(conn: &Connection, id: &str, name: &str) -> saved_filters::SavedFilter {
    saved_filters::create(
        conn,
        &NewSavedFilter {
            id: Some(id),
            name,
            config: &config(),
        },
        DEVICE,
        NOW,
    )
    .expect("create")
    .acknowledge()
}

#[test]
fn the_declaration_subscribes_to_filter() {
    let declaration = Declaration::subscribed();
    assert_eq!(declaration.classify("filter"), ArrivingItemType::Subscribed);
    assert!(declaration.header_value().contains(",settings,filter"));
}

#[test]
fn an_inbound_desktop_payload_projects_and_stays_verbatim() {
    let db = open("inbound");
    db.call_blocking(|conn| {
        let payload = desktop_payload(json!({ "device-desktop": 2 }));
        let record = inbound("flt_desktop_000000001", &payload, None);
        assert_eq!(apply_inbound(conn, &record, NOW)?, ApplyOutcome::Applied);

        // §13.2 rule 1: the bytes as received, `id`/`syncedAt`/`groupBy` intact.
        assert_eq!(
            sync_items::push_payload(conn, "filter", "flt_desktop_000000001")?,
            Some(record.payload_json.clone())
        );

        let filters = saved_filters::list(conn)?;
        assert_eq!(filters.len(), 1);
        let filter = &filters[0];
        assert_eq!(filter.id, "flt_desktop_000000001");
        assert_eq!(filter.name, "Due this week");
        assert_eq!(filter.position, 3);
        assert_eq!(filter.created_at_ms, Some(NOW));
        assert_eq!(filter.config, payload["config"]);
        assert!(filter.starred());
        let typed = filter.filters();
        assert_eq!(typed.project_ids, ["proj-1"]);
        assert_eq!(typed.priorities, ["high"]);
        assert_eq!(typed.completion, CompletionFilter::All);
        let sort = filter.sort().expect("a sort");
        assert_eq!(sort.field, SortField::DueDate);
        assert_eq!(sort.direction, SortDirection::Asc);
        Ok(())
    })
    .expect("the inbound apply");
}

#[test]
fn a_dominating_local_clock_skips_a_stale_remote() {
    let db = open("stale");
    db.call_blocking(|conn| {
        let newer = desktop_payload(json!({ "device-desktop": 3 }));
        apply_inbound(conn, &inbound("f1", &newer, None), NOW)?;

        let mut stale = desktop_payload(json!({ "device-desktop": 1 }));
        stale["name"] = json!("Old name");
        assert_eq!(
            apply_inbound(conn, &inbound("f1", &stale, None), NOW)?,
            ApplyOutcome::Skipped
        );
        assert_eq!(
            saved_filters::get(conn, "f1")?.expect("live").name,
            "Due this week"
        );
        // §6.5.2 P3: the inbound path never enqueues.
        assert!(outbox(conn).is_empty());
        Ok(())
    })
    .expect("the stale apply");
}

#[test]
fn an_inbound_tombstone_hides_the_filter() {
    let db = open("tombstone");
    db.call_blocking(|conn| {
        let payload = desktop_payload(json!({ "device-desktop": 1 }));
        apply_inbound(conn, &inbound("f1", &payload, None), NOW)?;
        let deleted = desktop_payload(json!({ "device-desktop": 2 }));
        apply_inbound(conn, &inbound("f1", &deleted, Some(NOW + 1)), NOW + 1)?;
        assert!(saved_filters::get(conn, "f1")?.is_none());
        assert!(saved_filters::list(conn)?.is_empty());
        Ok(())
    })
    .expect("the tombstone");
}

#[test]
fn a_create_writes_desktops_payload_shape_and_queues_it() {
    let db = open("create");
    db.call_blocking(|conn| {
        let first = create(conn, "f1", "Urgent");
        assert_eq!(first.position, 0);
        let second = saved_filters::create(
            conn,
            &NewSavedFilter {
                id: None,
                name: "Second",
                config: &config(),
            },
            DEVICE,
            NOW,
        )?
        .acknowledge();
        // `getNextSavedFilterPosition`: max + 1.
        assert_eq!(second.position, 1);
        assert_eq!(second.id.len(), 21, "a nanoid-shaped id");

        let payload = payload_of(conn, "f1");
        assert_eq!(
            payload,
            json!({
                "name": "Urgent",
                "config": config(),
                "position": 0,
                "clock": { "device-a": 1 },
                "createdAt": "2025-10-09T08:53:20.000Z",
            })
        );
        // Document-level only: no field clocks, no modifiedAt.
        assert!(payload.get("fieldClocks").is_none());
        assert!(payload.get("modifiedAt").is_none());

        assert_eq!(
            outbox(conn),
            [
                ("filter".to_owned(), "f1".to_owned(), "upsert".to_owned()),
                ("filter".to_owned(), second.id.clone(), "upsert".to_owned()),
            ]
        );
        let ids: Vec<String> = saved_filters::list(conn)?
            .into_iter()
            .map(|f| f.id)
            .collect();
        assert_eq!(ids, ["f1".to_owned(), second.id]);

        // A duplicate id and an empty name are refused, and queue nothing.
        assert!(
            saved_filters::create(
                conn,
                &NewSavedFilter {
                    id: Some("f1"),
                    name: "Again",
                    config: &config(),
                },
                DEVICE,
                NOW,
            )
            .is_err()
        );
        assert!(
            saved_filters::create(
                conn,
                &NewSavedFilter {
                    id: Some("f9"),
                    name: "",
                    config: &config(),
                },
                DEVICE,
                NOW,
            )
            .is_err()
        );
        assert_eq!(outbox(conn).len(), 2);
        Ok(())
    })
    .expect("the create");
}

#[test]
fn an_update_keeps_config_keys_this_build_does_not_model() {
    let db = open("update");
    db.call_blocking(|conn| {
        let payload = desktop_payload(json!({ "device-desktop": 2 }));
        apply_inbound(conn, &inbound("f1", &payload, None), NOW)?;

        // The shape a shell rebuilds from `TaskFilters::to_json`: every
        // modelled key, none of the unknown ones.
        let edit = json!({
            "filters": {
                "search": "report",
                "projectIds": [],
                "priorities": [],
                "tags": ["work"],
                "dueDate": { "type": "any", "customStart": null, "customEnd": null },
                "statusIds": [],
                "completion": "active",
                "repeatType": "all",
                "hasTime": "all",
            },
            "sort": null,
        });
        let updated = saved_filters::update(conn, "f1", Some("Reports"), Some(&edit), DEVICE, NOW)?
            .acknowledge();
        assert_eq!(updated.name, "Reports");
        assert_eq!(updated.filters().search, "report");
        assert!(updated.sort().is_none());

        let stored = payload_of(conn, "f1");
        assert_eq!(stored["name"], "Reports");
        assert_eq!(stored["config"]["filters"]["tags"], json!(["work"]));
        assert_eq!(
            stored["config"]["sort"],
            Value::Null,
            "§13.4: a clear is null"
        );
        // Unknown keys: in config, and at the payload's top level.
        assert_eq!(stored["config"]["groupBy"], "project");
        assert_eq!(stored["config"]["starred"], true);
        assert_eq!(stored["id"], "flt_desktop_000000001");
        assert!(stored.as_object().expect("object").contains_key("syncedAt"));
        // The document clock ticks for this device; the peer's tick stays.
        assert_eq!(
            stored["clock"],
            json!({ "device-desktop": 2, "device-a": 1 })
        );
        assert!(stored.get("modifiedAt").is_none());
        assert_eq!(
            outbox(conn),
            [("filter".to_owned(), "f1".to_owned(), "upsert".to_owned())]
        );

        // A rename alone leaves config byte-identical.
        let before = payload_of(conn, "f1")["config"].clone();
        saved_filters::update(conn, "f1", Some("Renamed"), None, DEVICE, NOW)?;
        assert_eq!(payload_of(conn, "f1")["config"], before);
        assert!(saved_filters::update(conn, "missing", Some("x"), None, DEVICE, NOW).is_err());
        Ok(())
    })
    .expect("the update");
}

#[test]
fn star_and_unstar_write_config_starred() {
    let db = open("star");
    db.call_blocking(|conn| {
        create(conn, "f1", "Urgent");
        let starred = saved_filters::set_starred(conn, "f1", true, DEVICE, NOW)?.acknowledge();
        assert!(starred.starred());
        assert_eq!(payload_of(conn, "f1")["config"]["starred"], true);

        let unstarred = saved_filters::set_starred(conn, "f1", false, DEVICE, NOW)?.acknowledge();
        assert!(!unstarred.starred());
        let payload = payload_of(conn, "f1");
        // Desktop writes the boolean either way.
        assert_eq!(payload["config"]["starred"], false);
        assert_eq!(payload["config"]["filters"], config()["filters"]);
        assert_eq!(payload["clock"], json!({ "device-a": 3 }));
        Ok(())
    })
    .expect("the star");
}

#[test]
fn a_delete_tombstones_ticks_the_clock_and_queues_a_delete() {
    let db = open("delete");
    db.call_blocking(|conn| {
        create(conn, "f1", "Urgent");
        create(conn, "f2", "Other");
        saved_filters::delete(conn, "f1", DEVICE, NOW + 5)?.acknowledge();

        assert!(saved_filters::get(conn, "f1")?.is_none());
        assert_eq!(saved_filters::list(conn)?.len(), 1);
        let row = sync_items::load(conn, "filter", "f1")?.expect("the row stays");
        assert_eq!(row.deleted_at, Some(NOW + 5));
        let payload = payload_of(conn, "f1");
        assert_eq!(payload["clock"], json!({ "device-a": 2 }));
        assert_eq!(payload["name"], "Urgent");
        let deleted_at: Option<i64> = conn
            .query_row(
                "SELECT deleted_at FROM saved_filters WHERE id = 'f1'",
                [],
                |row| row.get(0),
            )
            .expect("the projection row");
        assert_eq!(deleted_at, Some(NOW + 5));
        assert_eq!(
            outbox(conn).last(),
            Some(&("filter".to_owned(), "f1".to_owned(), "delete".to_owned()))
        );
        // Deleting twice, or editing a deleted filter, is refused.
        assert!(saved_filters::delete(conn, "f1", DEVICE, NOW).is_err());
        assert!(saved_filters::set_starred(conn, "f1", true, DEVICE, NOW).is_err());
        // The next create goes after the live maximum.
        assert_eq!(create(conn, "f3", "Third").position, 2);
        Ok(())
    })
    .expect("the delete");
}

#[test]
fn a_reorder_rewrites_only_the_filters_that_moved() {
    let db = open("reorder");
    db.call_blocking(|conn| {
        create(conn, "f1", "One");
        create(conn, "f2", "Two");
        create(conn, "f3", "Three");
        conn.execute("DELETE FROM outbox", params![])
            .expect("clear the queue");

        let ids = ["f3", "f1", "f2", "gone"].map(str::to_owned);
        let moved = saved_filters::reorder(conn, &ids, &[0, 1, 2, 3], DEVICE, NOW)?;
        assert_eq!(moved, ["f3".to_owned(), "f1".to_owned(), "f2".to_owned()]);
        let order: Vec<String> = saved_filters::list(conn)?
            .into_iter()
            .map(|f| f.id)
            .collect();
        assert_eq!(order, ["f3", "f1", "f2"]);
        assert_eq!(payload_of(conn, "f3")["position"], 0);
        assert_eq!(payload_of(conn, "f3")["clock"], json!({ "device-a": 2 }));
        assert_eq!(outbox(conn).len(), 3);

        // Already in place: nothing written, nothing queued.
        conn.execute("DELETE FROM outbox", params![])
            .expect("clear the queue");
        let moved = saved_filters::reorder(conn, &ids[..3], &[0, 1, 2], DEVICE, NOW)?;
        assert!(moved.is_empty());
        assert!(outbox(conn).is_empty());
        assert_eq!(payload_of(conn, "f3")["clock"], json!({ "device-a": 2 }));

        assert!(saved_filters::reorder(conn, &ids, &[0], DEVICE, NOW).is_err());
        Ok(())
    })
    .expect("the reorder");
}
