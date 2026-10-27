//! Tag categories on real SQLite (desktop Step 13, `tags:*-category`).
//!
//! | Test                                                       | Rule                                      |
//! | ---------------------------------------------------------- | ----------------------------------------- |
//! | a create appends, trims and queues the record               | chapter 13 §13.7.8, FR-030                |
//! | an empty name is refused and nothing is written             | desktop `categoryNameRequired`            |
//! | a rename edits the name only and keeps an unknown key       | §13.2, FR-033                             |
//! | a delete releases its tags as synced edits, atomically      | one transaction                           |
//! | a delete is a tombstone that carries `deletedAt`            | a receiver must not read it as an update  |
//! | a drag assigns tags and reorders categories together        | `tags:reorder`                            |
//! | a drag creates the definition of a tag that has none        | stated divergence from desktop            |
//! | a drag that fails halfway writes nothing                    | all or nothing                            |
//! | what the writers emit reads back through the §13.7.8 reader | the shipped payload shape                 |

use memry_core::api::errors::StorageError;
use memry_core::domain::tag_admin;
use memry_core::domain::tag_categories::{self as categories, TagAssignment};
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";

fn open(label: &str) -> Db {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-tag-categories-{label}-"))
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

fn payload(db: &Db, item_type: &'static str, id: String) -> Value {
    run(db, move |conn| {
        Ok(serde_json::from_str(
            &sync_items::push_payload(conn, item_type, &id)?.expect("a payload"),
        )
        .expect("json"))
    })
}

fn queued(db: &Db) -> Vec<(String, String, String)> {
    run(db, |conn| {
        let mut statement = conn
            .prepare("SELECT item_type, item_id, op FROM outbox ORDER BY item_type, item_id, op")
            .expect("prepare");
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .expect("query");
        Ok(rows.map(|row| row.expect("a row")).collect())
    })
}

fn clear_outbox(db: &Db) {
    run(db, |conn| {
        conn.execute("DELETE FROM outbox", [])
            .map(drop)
            .map_err(|error| StorageError::Failed {
                what: error.to_string(),
            })
    });
}

fn create(db: &Db, name: &'static str) -> categories::TagCategory {
    run(db, move |conn| categories::create(conn, name, DEVICE, NOW))
}

fn define(db: &Db, tag: &'static str) {
    run(db, move |conn| {
        tag_admin::set_color(conn, tag, "rose", DEVICE, NOW)
    });
}

fn category_of(db: &Db, tag: &'static str) -> Value {
    payload(db, "tag_definition", tag.to_owned())["categoryId"].clone()
}

#[test]
fn a_create_appends_trims_and_queues_the_record() {
    let db = open("create");
    let first = create(&db, "  Topics  ");
    let second = create(&db, "People");

    assert_eq!((first.name.as_str(), first.sort_order), ("Topics", 0));
    assert_eq!(second.sort_order, 1);
    assert_ne!(first.id, second.id);
    let stored = payload(&db, "tag_category", first.id.clone());
    assert_eq!(stored["name"], "Topics");
    assert_eq!(stored["sortOrder"], 0);
    assert_eq!(stored["clock"], json!({"device-a": 1}));
    assert_eq!(stored["deletedAt"], Value::Null);
    assert_eq!(queued(&db), {
        let mut keys = vec![
            ("tag_category".to_owned(), first.id, "upsert".to_owned()),
            ("tag_category".to_owned(), second.id, "upsert".to_owned()),
        ];
        keys.sort();
        keys
    });
    let listed = run(&db, |conn| categories::list(conn));
    assert_eq!(
        listed.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        ["Topics", "People"]
    );
}

#[test]
fn an_empty_name_is_refused_and_nothing_is_written() {
    let db = open("empty");
    let error = db
        .call_blocking(|conn| categories::create(conn, "   ", DEVICE, NOW))
        .expect_err("refused");
    assert!(matches!(error, StorageError::Invalid { .. }), "{error:?}");
    assert!(queued(&db).is_empty());
}

#[test]
fn a_rename_edits_the_name_only_and_keeps_an_unknown_key() {
    let db = open("rename");
    let topics = create(&db, "Topics");
    // A newer build's key arrives with the record.
    let id = topics.id.clone();
    run(&db, move |conn| {
        sync_items::apply_local_edit(
            conn,
            "tag_category",
            &id,
            &[(
                "icon",
                memry_core::storage::repositories::Change::set("hash"),
            )],
            NOW,
        )
        .map(drop)
    });

    let id = topics.id.clone();
    run(&db, move |conn| {
        categories::rename(conn, &id, " Subjects ", DEVICE, NOW + 1)
    });

    let stored = payload(&db, "tag_category", topics.id.clone());
    assert_eq!(stored["name"], "Subjects");
    assert_eq!(stored["icon"], "hash", "an unmodelled key survives");
    assert_eq!(stored["sortOrder"], 0);
    let missing = db
        .call_blocking(|conn| categories::rename(conn, "nope", "x", DEVICE, NOW))
        .expect_err("unknown");
    assert!(
        matches!(missing, StorageError::NotFound { .. }),
        "{missing:?}"
    );
}

#[test]
fn a_delete_releases_its_tags_as_synced_edits_in_one_transaction() {
    let db = open("delete");
    let topics = create(&db, "Topics");
    let people = create(&db, "People");
    define(&db, "alpha");
    define(&db, "beta");
    define(&db, "gamma");
    let (t, p) = (topics.id.clone(), people.id.clone());
    run(&db, move |conn| {
        categories::arrange(
            conn,
            &[
                TagAssignment {
                    tag: "alpha".into(),
                    category_id: Some(t.clone()),
                    sort_order: 0,
                },
                TagAssignment {
                    tag: "beta".into(),
                    category_id: Some(t),
                    sort_order: 1,
                },
                TagAssignment {
                    tag: "gamma".into(),
                    category_id: Some(p),
                    sort_order: 0,
                },
            ],
            &[],
            DEVICE,
            NOW,
        )
    });
    clear_outbox(&db);

    let id = topics.id.clone();
    let released = run(&db, move |conn| {
        categories::delete(conn, &id, DEVICE, NOW + 1)
    });

    assert_eq!(released, 2);
    assert_eq!(category_of(&db, "alpha"), Value::Null);
    assert_eq!(category_of(&db, "beta"), Value::Null);
    assert_ne!(
        category_of(&db, "gamma"),
        Value::Null,
        "another category's tag stays"
    );
    assert_eq!(
        queued(&db),
        vec![
            (
                "tag_category".to_owned(),
                topics.id.clone(),
                "delete".to_owned()
            ),
            (
                "tag_definition".to_owned(),
                "alpha".to_owned(),
                "upsert".to_owned()
            ),
            (
                "tag_definition".to_owned(),
                "beta".to_owned(),
                "upsert".to_owned()
            ),
        ]
    );
    let listed = run(&db, |conn| categories::list(conn));
    assert_eq!(listed.len(), 1);
    assert_eq!(
        (listed[0].name.as_str(), listed[0].tag_count),
        ("People", 1)
    );
}

#[test]
fn a_delete_is_a_tombstone_that_carries_deleted_at() {
    let db = open("tombstone");
    let topics = create(&db, "Topics");
    let id = topics.id.clone();
    run(&db, move |conn| {
        categories::delete(conn, &id, DEVICE, NOW + 5)
    });

    let stored = payload(&db, "tag_category", topics.id.clone());
    assert!(stored["deletedAt"].is_string(), "{stored}");
    assert_eq!(
        stored["clock"],
        json!({"device-a": 2}),
        "one tick covers the delete"
    );
    let live: i64 = run(&db, |conn| {
        Ok(conn
            .query_row(
                "SELECT COUNT(*) FROM tag_categories WHERE deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("count"))
    });
    assert_eq!(live, 0);
    let again = db
        .call_blocking(move |conn| categories::delete(conn, &topics.id, DEVICE, NOW + 6))
        .expect_err("already deleted");
    assert!(matches!(again, StorageError::NotFound { .. }), "{again:?}");
}

#[test]
fn a_drag_assigns_tags_and_reorders_categories_together() {
    let db = open("drag");
    let topics = create(&db, "Topics");
    let people = create(&db, "People");
    define(&db, "alpha");
    clear_outbox(&db);

    let (t, p) = (topics.id.clone(), people.id.clone());
    run(&db, move |conn| {
        categories::arrange(
            conn,
            &[assign_to("alpha", Some(&t), 4)],
            &[(p.clone(), 0), (t.clone(), 1), ("gone".to_owned(), 9)],
            DEVICE,
            NOW + 1,
        )
    });

    let alpha = payload(&db, "tag_definition", "alpha".to_owned());
    assert_eq!(alpha["categoryId"], json!(topics.id));
    assert_eq!(alpha["sortOrder"], 4);
    assert_eq!(
        payload(&db, "tag_category", people.id.clone())["sortOrder"],
        0
    );
    assert_eq!(
        payload(&db, "tag_category", topics.id.clone())["sortOrder"],
        1
    );
    let listed = run(&db, |conn| categories::list(conn));
    assert_eq!(
        listed.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        ["People", "Topics"]
    );
    assert_eq!(queued(&db).len(), 3, "the unknown category queued nothing");
}

fn assign_to(tag: &str, category: Option<&str>, order: i64) -> TagAssignment {
    TagAssignment {
        tag: tag.to_owned(),
        category_id: category.map(str::to_owned),
        sort_order: order,
    }
}

#[test]
fn a_drag_creates_the_definition_of_a_tag_that_has_none() {
    let db = open("create-definition");
    let topics = create(&db, "Topics");
    let id = topics.id.clone();
    run(&db, move |conn| {
        categories::arrange(conn, &[assign_to("fresh", Some(&id), 0)], &[], DEVICE, NOW)
    });

    let fresh = payload(&db, "tag_definition", "fresh".to_owned());
    assert_eq!(fresh["categoryId"], json!(topics.id));
    assert!(
        fresh["color"].is_string(),
        "a definition always has a colour"
    );
}

#[test]
fn a_drag_that_fails_halfway_writes_nothing() {
    let db = open("atomic");
    let topics = create(&db, "Topics");
    define(&db, "alpha");
    clear_outbox(&db);

    let t = topics.id.clone();
    let error = db
        .call_blocking(move |conn| {
            categories::arrange(
                conn,
                &[
                    assign_to("alpha", Some(&t), 0),
                    assign_to("beta", Some("no-such-category"), 1),
                ],
                &[],
                DEVICE,
                NOW + 1,
            )
        })
        .expect_err("a reference to nothing");

    assert!(matches!(error, StorageError::NotFound { .. }), "{error:?}");
    assert_eq!(
        category_of(&db, "alpha"),
        Value::Null,
        "the first assignment rolled back"
    );
    assert!(queued(&db).is_empty());
}

#[test]
fn what_the_writers_emit_reads_back_through_the_shipped_reader() {
    let db = open("reader");
    let topics = create(&db, "Topics");
    let stored = payload(&db, "tag_category", topics.id);
    let mut keys: Vec<&str> = stored
        .as_object()
        .expect("an object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "clock",
            "createdAt",
            "deletedAt",
            "name",
            "sortOrder",
            "updatedAt"
        ],
        "exactly the §13.7.8 fields"
    );
}
