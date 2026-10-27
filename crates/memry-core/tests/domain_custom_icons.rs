//! Custom icons on real SQLite (desktop Step 13): a record with no projection
//! table, listed from the stored payloads (chapter 13 §13.7.11).
//!
//! | Test                                                      | Rule                                         |
//! | --------------------------------------------------------- | -------------------------------------------- |
//! | a create is listed at once and queued                      | no second copy to keep in step               |
//! | what is accepted is what desktop stores                    | png or svg, 60 units, base64 under a cap     |
//! | a rename keeps the bytes and an unknown key                | §13.2, FR-033                                |
//! | a delete leaves the list and queues a tombstone            | chapter 07 §7.15                             |
//! | an icon another device pushed is listed with no table      | self-healing from the row                    |
//! | a row that cannot be read is reported, not dropped         | no silent skip                               |
//! | there is no `custom_icons` table                           | decided with Kaan, protocol 13.7.11          |

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use memry_core::api::errors::StorageError;
use memry_core::domain::custom_icons::{self, CustomIcons};
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";
const PNG: &str = "iVBORw0KGgo=";

fn open(label: &str) -> Db {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-custom-icons-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn run<T: Send + 'static>(
    db: &Db,
    f: impl FnOnce(&mut Connection) -> Result<T, StorageError> + Send + 'static,
) -> T {
    db.call_blocking(f).expect("a database call")
}

fn list(db: &Db) -> CustomIcons {
    run(db, |conn| custom_icons::list(conn))
}

fn add(db: &Db, name: &'static str, ext: &'static str, data: &'static str, at: i64) -> String {
    run(db, move |conn| {
        custom_icons::create(conn, name, ext, data, DEVICE, at)
    })
}

fn outbox(db: &Db) -> Vec<(String, String)> {
    run(db, |conn| {
        let mut statement = conn
            .prepare("SELECT item_id, op FROM outbox ORDER BY id")
            .expect("prepare");
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query");
        Ok(rows.map(|row| row.expect("a row")).collect())
    })
}

fn payload(db: &Db, id: String) -> Value {
    run(db, move |conn| {
        Ok(serde_json::from_str(
            &sync_items::push_payload(conn, "custom_icon", &id)?.expect("a payload"),
        )
        .expect("json"))
    })
}

fn refused(db: &Db, name: &'static str, ext: &'static str, data: String) -> StorageError {
    db.call_blocking(move |conn| custom_icons::create(conn, name, ext, &data, DEVICE, NOW))
        .expect_err("refused")
}

#[test]
fn a_create_is_listed_at_once_and_queued() {
    let db = open("create");
    let id = add(&db, "  rocket ", "png", PNG, NOW);

    let found = list(&db);
    assert_eq!(found.skipped, Vec::<String>::new());
    assert_eq!(found.icons.len(), 1);
    let icon = &found.icons[0];
    assert_eq!(
        (
            icon.id.as_str(),
            icon.name.as_str(),
            icon.ext.as_str(),
            icon.data.as_str()
        ),
        (id.as_str(), "rocket", "png", PNG)
    );
    assert!(icon.created_at.is_some());
    assert_eq!(outbox(&db), [(id.clone(), "upsert".to_owned())]);

    let stored = payload(&db, id);
    let mut keys: Vec<&str> = stored
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["clock", "createdAt", "data", "ext", "name", "updatedAt"]
    );
    assert_eq!(stored["clock"], json!({"device-a": 1}));
}

#[test]
fn what_is_accepted_is_what_desktop_stores() {
    let db = open("validate");
    assert!(matches!(
        refused(&db, "x", "jpg", PNG.to_owned()),
        StorageError::Invalid { .. }
    ));
    assert!(matches!(
        refused(&db, "x", "gif", PNG.to_owned()),
        StorageError::Invalid { .. }
    ));
    assert!(matches!(
        refused(&db, "  ", "png", PNG.to_owned()),
        StorageError::Invalid { .. }
    ));
    assert!(matches!(
        refused(&db, "x", "png", String::new()),
        StorageError::Invalid { .. }
    ));
    assert!(matches!(
        refused(&db, "x", "png", "not base64!!".to_owned()),
        StorageError::Invalid { .. }
    ));
    // 61 UTF-16 units; an emoji is two, so 31 of them is 62.
    assert!(matches!(
        db.call_blocking(|conn| custom_icons::create(
            conn,
            &"é".repeat(61),
            "png",
            PNG,
            DEVICE,
            NOW
        ))
        .expect_err("too long"),
        StorageError::Invalid { .. }
    ));
    assert!(matches!(
        db.call_blocking(|conn| custom_icons::create(
            conn,
            &"😀".repeat(31),
            "png",
            PNG,
            DEVICE,
            NOW
        ))
        .expect_err("too long in UTF-16 units"),
        StorageError::Invalid { .. }
    ));
    let big = STANDARD.encode(vec![0u8; 2 * 1024 * 1024 + 4]);
    assert!(matches!(
        refused(&db, "x", "png", big),
        StorageError::Invalid { .. }
    ));
    assert!(
        list(&db).icons.is_empty() && outbox(&db).is_empty(),
        "nothing was written"
    );

    // The edge that is accepted.
    db.call_blocking(|conn| custom_icons::create(conn, &"é".repeat(60), "svg", PNG, DEVICE, NOW))
        .expect("60 units, svg");
}

#[test]
fn a_rename_keeps_the_bytes_and_an_unknown_key() {
    let db = open("rename");
    let id = add(&db, "rocket", "png", PNG, NOW);
    let target = id.clone();
    run(&db, move |conn| {
        sync_items::apply_local_edit(
            conn,
            "custom_icon",
            &target,
            &[(
                "sourceUrl",
                memry_core::storage::repositories::Change::set("https://example.invalid/r.png"),
            )],
            NOW,
        )
        .map(drop)
    });

    let target = id.clone();
    run(&db, move |conn| {
        custom_icons::rename(conn, &target, "ship", DEVICE, NOW + 1)
    });

    let stored = payload(&db, id.clone());
    assert_eq!(
        (stored["name"].as_str(), stored["data"].as_str()),
        (Some("ship"), Some(PNG))
    );
    assert_eq!(stored["sourceUrl"], "https://example.invalid/r.png");
    assert_eq!(list(&db).icons[0].name, "ship");
    let missing = db
        .call_blocking(|conn| custom_icons::rename(conn, "nope", "x", DEVICE, NOW))
        .expect_err("unknown");
    assert!(matches!(missing, StorageError::NotFound { .. }));
}

#[test]
fn a_delete_leaves_the_list_and_queues_a_tombstone() {
    let db = open("delete");
    let id = add(&db, "rocket", "png", PNG, NOW);
    let keep = add(&db, "star", "svg", PNG, NOW + 1);

    let target = id.clone();
    run(&db, move |conn| {
        custom_icons::delete(conn, &target, DEVICE, NOW + 2)
    });

    assert_eq!(
        list(&db)
            .icons
            .iter()
            .map(|i| i.id.clone())
            .collect::<Vec<_>>(),
        [keep]
    );
    assert!(outbox(&db).contains(&(id.clone(), "delete".to_owned())));
    let again = db
        .call_blocking(move |conn| custom_icons::delete(conn, &id, DEVICE, NOW + 3))
        .expect_err("already deleted");
    assert!(matches!(again, StorageError::NotFound { .. }));
}

#[test]
fn an_icon_another_device_pushed_is_listed_and_unreadable_rows_are_reported() {
    let db = open("remote");
    run(&db, |conn| {
        for (id, payload) in [
            (
                "remote-1",
                json!({"name": "peer", "ext": "svg", "data": PNG, "clock": {"device-b": 4},
                       "createdAt": "2026-04-16T00:00:00.000Z", "updatedAt": "2026-04-16T00:00:00.000Z",
                       "sourceUrl": "https://example.invalid/p.svg"}),
            ),
            // A newer build's icon with a format this build does not store.
            (
                "remote-2",
                json!({"name": "future", "ext": "webp", "data": PNG, "clock": {"device-b": 1},
                       "createdAt": "2026-04-17T00:00:00.000Z"}),
            ),
            // No bytes: nothing to show.
            (
                "remote-3",
                json!({"name": "empty", "clock": {"device-b": 1}}),
            ),
        ] {
            conn.execute(
                "INSERT INTO sync_items (item_type, item_id, payload, payload_state, clock, updated_at)
                 VALUES ('custom_icon', ?1, ?2, 'full', '{}', 1)",
                rusqlite::params![id, payload.to_string()],
            )
            .map_err(|error| StorageError::Failed { what: error.to_string() })?;
        }
        Ok(())
    });

    let found = list(&db);

    assert_eq!(
        found
            .icons
            .iter()
            .map(|i| (i.id.as_str(), i.ext.as_str()))
            .collect::<Vec<_>>(),
        [("remote-1", "svg"), ("remote-2", "webp")],
        "listed as stored, oldest first; the shell decides what to render"
    );
    assert_eq!(found.skipped, ["remote-3"]);
}

#[test]
fn there_is_no_custom_icons_table() {
    let db = open("no-table");
    let tables: i64 = run(&db, |conn| {
        Ok(conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'custom_icons'",
                [],
                |row| row.get(0),
            )
            .expect("count"))
    });
    assert_eq!(tables, 0, "the record is the only copy (§13.7.11)");
}
