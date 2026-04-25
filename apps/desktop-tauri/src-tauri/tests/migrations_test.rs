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
