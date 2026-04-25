use memry_desktop_tauri_lib::db::migrations;
use rusqlite::Connection;

#[test]
fn bootstraps_schema_migrations_table() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrations::bootstrap(&mut conn).unwrap();

    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
            [],
            |row| row.get(0),
        )
        .unwrap();

    assert_eq!(exists, 1);
}

#[test]
fn bootstrap_is_idempotent() {
    let mut conn = Connection::open_in_memory().unwrap();

    migrations::bootstrap(&mut conn).unwrap();
    migrations::bootstrap(&mut conn).unwrap();
}

#[test]
fn applies_embedded_migrations_in_order_and_records_them() {
    let mut conn = Connection::open_in_memory().unwrap();

    migrations::apply_pending(&mut conn).unwrap();

    let applied: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT name FROM schema_migrations ORDER BY applied_at, name")
            .unwrap();
        stmt.query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    let expected: Vec<String> = migrations::EMBEDDED
        .iter()
        .map(|(name, _sql)| (*name).to_string())
        .collect();

    assert_eq!(applied, expected);

    migrations::apply_pending(&mut conn).unwrap();

    let still_applied: i64 = conn
        .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .unwrap();

    assert_eq!(still_applied, expected.len() as i64);
}

#[test]
fn migration_0000_creates_core_tables() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrations::apply_pending(&mut conn).unwrap();

    for table in [
        "projects",
        "statuses",
        "tasks",
        "task_notes",
        "task_tags",
        "inbox_items",
        "saved_filters",
        "settings",
    ] {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(exists, 1, "table {table} missing after migration 0000");
    }
}

#[test]
fn full_migration_produces_expected_table_set() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrations::apply_pending(&mut conn).unwrap();

    let mut stmt = conn
        .prepare(
            "SELECT name FROM sqlite_master \
             WHERE type='table' AND name NOT LIKE 'sqlite_%' \
             ORDER BY name",
        )
        .unwrap();
    let tables: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .filter_map(Result::ok)
        .collect();

    // Required tables traced to the migration that creates them (final state
    // after all 29 ports apply). Any absence indicates a missing or wrongly
    // ordered port. Update this list only if a port faithfully removed the
    // table — never soften the assertion.
    let required: &[&str] = &[
        // bootstrap
        "schema_migrations",
        // 0000
        "projects",
        "statuses",
        "tasks",
        "task_notes",
        "task_tags",
        "inbox_items",
        "saved_filters",
        "settings",
        // 0001
        "bookmarks",
        // 0002
        "filing_history",
        "inbox_item_tags",
        "inbox_stats",
        // 0003
        "suggestion_feedback",
        // 0004
        "reminders",
        // 0006
        "note_positions",
        // 0007
        "tag_definitions",
        // 0008
        "sync_devices",
        "sync_queue",
        "sync_state",
        "sync_history",
        // 0020
        "search_reasons",
        // 0021
        "inbox_jobs",
        // 0022
        "note_metadata",
        "property_definitions",
        // 0023
        "folder_configs",
        // 0024
        "calendar_events",
        "calendar_sources",
        "calendar_external_events",
        "calendar_bindings",
    ];
    for name in required {
        assert!(
            tables.contains(&name.to_string()),
            "required table {name} missing; present tables: {tables:?}"
        );
    }

    // recent_searches was added in 0018 and dropped in 0020 — it MUST NOT
    // remain in the final schema. Guards against accidentally re-adding it.
    assert!(
        !tables.contains(&"recent_searches".to_string()),
        "recent_searches should have been dropped by 0020; present tables: {tables:?}"
    );
}

#[test]
fn tasks_and_projects_have_field_clocks_column() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrations::apply_pending(&mut conn).unwrap();

    for table in ["tasks", "projects"] {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        let cols: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert!(
            cols.contains(&"field_clocks".to_string()),
            "{table} missing field_clocks column; cols: {cols:?}"
        );
    }
}
