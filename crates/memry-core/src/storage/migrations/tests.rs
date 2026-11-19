use super::*;
use crate::storage::Db;

pub(super) fn table_names(db: &Db) -> Vec<String> {
    db.call_blocking(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_schema
                 WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
                 ORDER BY name",
            )
            .map_err(|err| StorageError::Failed {
                what: err.to_string(),
            })?;
        let names = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|err| StorageError::Failed {
                what: err.to_string(),
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| StorageError::Failed {
                what: err.to_string(),
            })?;
        Ok(names)
    })
    .expect("table names")
}

fn migrated(migrations: &'static [Migration]) -> Db {
    let db = Db::open_in_memory().expect("open");
    let version = db
        .call_blocking(|conn| run(conn, migrations))
        .expect("migrate");
    assert_eq!(version, latest_version(migrations));
    db
}

#[test]
fn a_fresh_data_database_reaches_the_latest_version() {
    let db = migrated(DATA_MIGRATIONS);

    let version = db
        .call_blocking(|conn| user_version(conn))
        .expect("user_version");
    assert_eq!(version, 35);

    let names = table_names(&db);
    // Source of record, §A.2.
    for expected in [
        "attachments",
        "local_notifications",
        "meta",
        "note_bodies",
        "note_body_sync",
        "note_body_tags",
        "note_positions",
        "outbox",
        "sync_cursors",
        "sync_history",
        "sync_items",
        "sync_quarantine",
        "sync_refused_items",
        "sync_tombstone_clocks",
        "yjs_doc_epochs",
        "yjs_snapshots",
        "yjs_updates",
    ] {
        assert!(names.iter().any(|n| n == expected), "missing {expected}");
    }
    // Typed projections, §A.4.
    for expected in [
        "calendar_bindings",
        "calendar_events",
        "calendar_external_events",
        "calendar_local_events",
        "calendar_push_queue",
        "calendar_source_states",
        "calendar_sources",
        "folders",
        "inbox_attachment_releases",
        "inbox_attachment_uploads",
        "inbox_jobs",
        "inbox_item_tags",
        "inbox_items",
        "journal_aliases",
        "journal_entries",
        "note_tags",
        "notes",
        "project_links",
        "project_statuses",
        "projects",
        "property_definitions",
        "recently_opened",
        "reminders",
        "saved_filter_expressions",
        "saved_filters",
        "search_recent_icons",
        "search_recents",
        "settings",
        "settings_field_clocks",
        "tag_categories",
        "tag_definitions",
        "task_activity",
        "tasks",
        "templates",
    ] {
        assert!(names.iter().any(|n| n == expected), "missing {expected}");
    }
}

#[test]
fn a_fresh_index_database_reaches_the_latest_version() {
    let db = migrated(INDEX_MIGRATIONS);

    let version = db
        .call_blocking(|conn| user_version(conn))
        .expect("user_version");
    assert_eq!(version, 11);

    let names = table_names(&db);
    for expected in [
        "block_link_refs",
        "extracted_text",
        "file_text_jobs",
        "fts_inbox",
        "fts_notes",
        "fts_tasks",
        "index_meta",
        "note_embedding_hashes",
        "note_fold_chunks",
        "note_links",
        "note_properties",
        "note_stats",
        "portal_refs",
        "property_refs",
    ] {
        assert!(names.iter().any(|n| n == expected), "missing {expected}");
    }
}

#[test]
fn running_again_is_a_no_op() {
    let db = migrated(DATA_MIGRATIONS);
    let before = table_names(&db);

    let version = db
        .call_blocking(|conn| run(conn, DATA_MIGRATIONS))
        .expect("second run");

    assert_eq!(version, latest_version(DATA_MIGRATIONS));
    assert_eq!(table_names(&db), before);
}

#[test]
fn an_older_database_steps_forward_without_losing_rows() {
    let db = Db::open_in_memory().expect("open");

    // A database that only ever saw 0001, with a user's row in it.
    db.call_blocking(|conn| run(conn, &DATA_MIGRATIONS[..1]))
        .expect("first migration");
    db.call_blocking(|conn| {
        conn.execute(
            "INSERT INTO sync_items
               (item_type, item_id, payload, payload_state, updated_at)
             VALUES ('note', 'abc123def456', '{\"unmodelled\":1}', 'full', 1757700000000)",
            [],
        )
        .map_err(|err| StorageError::Failed {
            what: err.to_string(),
        })
    })
    .expect("insert");

    let version = db
        .call_blocking(|conn| run(conn, DATA_MIGRATIONS))
        .expect("step forward");
    assert_eq!(version, latest_version(DATA_MIGRATIONS));

    let (count, payload): (i64, String) = db
        .call_blocking(|conn| {
            conn.query_row(
                "SELECT COUNT(*), payload FROM sync_items WHERE item_id = 'abc123def456'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|err| StorageError::Failed {
                what: err.to_string(),
            })
        })
        .expect("row survives");

    assert_eq!(count, 1);
    // Verbatim, §A.1: a migration is not an excuse to re-serialise a payload.
    assert_eq!(payload, "{\"unmodelled\":1}");
    // The projections 0002 and 0003 added are present and empty, and so is
    // 0004's tombstone-clock table (#2409).
    assert!(table_names(&db).iter().any(|n| n == "notes"));
    assert!(table_names(&db).iter().any(|n| n == "saved_filters"));
    assert!(table_names(&db).iter().any(|n| n == "bookmarks"));
    assert!(
        table_names(&db)
            .iter()
            .any(|n| n == "sync_tombstone_clocks")
    );
}

#[test]
fn a_migration_interrupted_between_commit_and_pragma_recovers() {
    let db = Db::open_in_memory().expect("open");

    db.call_blocking(|conn| run(conn, DATA_MIGRATIONS))
        .expect("migrate");
    // The crash window §A.0's ordering leaves open: the statements committed
    // but the counter never moved.
    db.call_blocking(|conn| set_user_version(conn, 0))
        .expect("rewind");

    let version = db
        .call_blocking(|conn| run(conn, DATA_MIGRATIONS))
        .expect("re-run");

    assert_eq!(version, latest_version(DATA_MIGRATIONS));
}

#[test]
fn a_failing_migration_leaves_the_previous_version_in_place() {
    static BROKEN: &[Migration] = &[
        Migration {
            version: 1,
            name: "ok",
            sql: "CREATE TABLE IF NOT EXISTS kept (id TEXT PRIMARY KEY);",
        },
        Migration {
            version: 2,
            name: "broken",
            sql: "CREATE TABLE IF NOT EXISTS added (id TEXT); SELECT nonexistent_fn();",
        },
    ];

    let db = Db::open_in_memory().expect("open");
    let err = db
        .call_blocking(|conn| run(conn, BROKEN))
        .expect_err("second migration fails");

    assert!(matches!(err, StorageError::Migration { version: 2, .. }));

    let version = db
        .call_blocking(|conn| user_version(conn))
        .expect("user_version");
    assert_eq!(version, 1);
    // The whole failing migration rolled back, so its half is not there.
    let names = table_names(&db);
    assert!(names.iter().any(|n| n == "kept"));
    assert!(!names.iter().any(|n| n == "added"));
}

#[test]
fn run_atomic_leaves_a_failed_migration_and_its_counter_untouched() {
    const FAILING: &[Migration] = &[
        Migration {
            version: 1,
            name: "first",
            sql: "CREATE TABLE a (n INTEGER); INSERT INTO a VALUES (1)",
        },
        Migration {
            version: 2,
            name: "second",
            sql: "CREATE TABLE b (n INTEGER); CREATE TABLE a (n INTEGER)",
        },
    ];
    let db = Db::open_in_memory().expect("open");

    let failure = db
        .call_blocking(|conn| Ok(run_atomic(conn, FAILING)))
        .expect("call")
        .expect_err("the second migration collides with the first");

    assert_eq!((failure.version, failure.name), (2, "second"));
    let (version, rows, has_b) = db
        .call_blocking(|conn| {
            Ok((
                user_version(conn)?,
                conn.query_row("SELECT COUNT(*) FROM a", [], |r| r.get::<_, i64>(0))
                    .unwrap_or(-1),
                conn.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name = 'b'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(-1),
            ))
        })
        .expect("state");
    // Migration 1 committed with its counter; migration 2 rolled back whole.
    assert_eq!((version, rows, has_b), (1, 1, 0));
}
