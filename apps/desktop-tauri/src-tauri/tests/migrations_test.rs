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

#[test]
fn rebuild_migrations_preserve_rows_when_fk_enforcement_is_on() {
    // Regression test for a bug where Db::open enabled FK enforcement before
    // running apply_pending. Drizzle's big rebuild migration (0018) uses the
    // CREATE __new_X / INSERT / DROP X / RENAME pattern; SQLite silently
    // no-ops the in-SQL `PRAGMA foreign_keys = OFF` inside a transaction, so
    // DROP TABLE cascades through ON DELETE CASCADE relationships and wipes
    // child rows before the migration copies them. apply_pending must toggle
    // FK off at connection scope around the replay.
    //
    // Simulates the upgrade path: a developer at schema version 0017 with
    // populated rows, then apply_pending runs 0018-0028.
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();

    migrations::bootstrap(&mut conn).unwrap();
    let upgrade_boundary = migrations::EMBEDDED
        .iter()
        .position(|(name, _)| name.starts_with("0018_"))
        .expect("EMBEDDED must contain 0018_*");
    for (name, sql) in migrations::EMBEDDED.iter().take(upgrade_boundary) {
        let tx = conn.transaction().unwrap();
        tx.execute_batch(sql).unwrap();
        tx.execute(
            "INSERT INTO schema_migrations (name) VALUES (?1)",
            rusqlite::params![name],
        )
        .unwrap();
        tx.commit().unwrap();
    }

    conn.execute(
        "INSERT INTO projects (id, name, color, position) VALUES ('p1', 'Inbox', '#000', 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO statuses (id, project_id, name, color, position, is_default, is_done) \
         VALUES ('s1', 'p1', 'Todo', '#abc', 0, 1, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO tasks (id, project_id, status_id, title, priority, position) \
         VALUES ('t1', 'p1', 's1', 'first', 0, 0)",
        [],
    )
    .unwrap();

    migrations::apply_pending(&mut conn).unwrap();

    let project_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
        .unwrap();
    let status_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM statuses", [], |row| row.get(0))
        .unwrap();
    let task_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
        .unwrap();

    assert_eq!(project_count, 1, "projects row lost during rebuild replay");
    assert_eq!(status_count, 1, "statuses row lost during rebuild replay");
    assert_eq!(task_count, 1, "tasks row lost during rebuild replay");

    // FK enforcement must be back on after apply_pending returns so the
    // application sees referential integrity for subsequent writes.
    let fk_state: i64 = conn
        .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
        .unwrap();
    assert_eq!(fk_state, 1, "apply_pending must restore FK enforcement");
}

#[test]
fn projects_and_tasks_roundtrip() {
    let db = memry_desktop_tauri_lib::db::Db::open_memory().unwrap();
    let conn = db.conn().unwrap();

    conn.execute(
        "INSERT INTO projects (id, name, color, position) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params!["p1", "Inbox", "#000", 0],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO statuses (id, project_id, name, color, position, is_default, is_done) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params!["s1", "p1", "Todo", "#abc", 0, 1, 0],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO tasks (id, project_id, status_id, title, priority, position) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params!["t1", "p1", "s1", "first", 0, 0],
    )
    .unwrap();

    let project = conn
        .query_row(
            "SELECT * FROM projects WHERE id = 'p1'",
            [],
            memry_desktop_tauri_lib::db::projects::Project::from_row,
        )
        .unwrap();
    assert_eq!(project.id, "p1");
    assert_eq!(project.name, "Inbox");
    assert!(!project.is_inbox);

    let status = conn
        .query_row(
            "SELECT * FROM statuses WHERE id = 's1'",
            [],
            memry_desktop_tauri_lib::db::statuses::Status::from_row,
        )
        .unwrap();
    assert_eq!(status.project_id, "p1");
    assert!(status.is_default);
    assert!(!status.is_done);

    let task = conn
        .query_row(
            "SELECT * FROM tasks WHERE id = 't1'",
            [],
            memry_desktop_tauri_lib::db::tasks::Task::from_row,
        )
        .unwrap();
    assert_eq!(task.project_id, "p1");
    assert_eq!(task.status_id.as_deref(), Some("s1"));
    assert_eq!(task.title, "first");
    assert!(task.clock.is_none());
    assert!(task.field_clocks.is_none());
}

#[test]
fn note_positions_roundtrip() {
    let db = memry_desktop_tauri_lib::db::Db::open_memory().unwrap();
    let conn = db.conn().unwrap();

    conn.execute(
        "INSERT INTO note_positions (path, folder_path, position) VALUES (?1, ?2, ?3)",
        rusqlite::params!["notes/foo.md", "notes", 3],
    )
    .unwrap();

    let pos = conn
        .query_row(
            "SELECT * FROM note_positions WHERE path = 'notes/foo.md'",
            [],
            memry_desktop_tauri_lib::db::note_positions::NotePosition::from_row,
        )
        .unwrap();
    assert_eq!(pos.path, "notes/foo.md");
    assert_eq!(pos.folder_path, "notes");
    assert_eq!(pos.position, 3);
}

#[test]
fn note_metadata_roundtrip() {
    let db = memry_desktop_tauri_lib::db::Db::open_memory().unwrap();
    let conn = db.conn().unwrap();

    conn.execute(
        "INSERT INTO note_metadata \
         (id, path, title, file_type, local_only, sync_policy, created_at, modified_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            "n1",
            "notes/hello.md",
            "Hello",
            "markdown",
            1,
            "sync",
            "2026-04-25T00:00:00.000Z",
            "2026-04-25T00:00:00.000Z",
        ],
    )
    .unwrap();

    let meta = conn
        .query_row(
            "SELECT * FROM note_metadata WHERE id = 'n1'",
            [],
            memry_desktop_tauri_lib::db::note_metadata::NoteMetadata::from_row,
        )
        .unwrap();
    assert_eq!(meta.path, "notes/hello.md");
    assert_eq!(meta.title, "Hello");
    assert_eq!(meta.file_type, "markdown");
    assert!(meta.local_only);
    assert_eq!(meta.sync_policy, "sync");
    assert!(meta.emoji.is_none());
    assert!(meta.clock.is_none());
    assert!(!meta.stored_at.is_empty());
}

#[test]
fn property_definitions_roundtrip() {
    let db = memry_desktop_tauri_lib::db::Db::open_memory().unwrap();
    let conn = db.conn().unwrap();

    conn.execute(
        "INSERT INTO property_definitions (name, type) VALUES (?1, ?2)",
        rusqlite::params!["status", "select"],
    )
    .unwrap();

    let prop = conn
        .query_row(
            "SELECT * FROM property_definitions WHERE name = 'status'",
            [],
            memry_desktop_tauri_lib::db::notes_cache::PropertyDefinition::from_row,
        )
        .unwrap();
    assert_eq!(prop.name, "status");
    assert_eq!(prop.r#type, "select");
    assert!(prop.options.is_none());
    assert!(prop.color.is_none());
    assert!(!prop.created_at.is_empty());
}

#[test]
fn calendar_event_roundtrip() {
    // Turkish-character roundtrip is embedded here (Phase D gotcha #3).
    // If SQLite or rusqlite mangles UTF-8, the title compare will fail.
    let db = memry_desktop_tauri_lib::db::Db::open_memory().unwrap();
    let conn = db.conn().unwrap();

    let title = "Toplantı: çay & kahve — ÖĞRENME günü";
    conn.execute(
        "INSERT INTO calendar_events (id, title, start_at) VALUES (?1, ?2, ?3)",
        rusqlite::params!["e1", title, "2026-04-25T10:00:00.000Z"],
    )
    .unwrap();

    let ev = conn
        .query_row(
            "SELECT * FROM calendar_events WHERE id = 'e1'",
            [],
            memry_desktop_tauri_lib::db::calendar_events::CalendarEvent::from_row,
        )
        .unwrap();
    assert_eq!(ev.id, "e1");
    assert_eq!(ev.title, title, "Turkish UTF-8 must roundtrip byte-identical");
    assert_eq!(ev.start_at, "2026-04-25T10:00:00.000Z");
    assert_eq!(ev.timezone, "UTC");
    assert!(!ev.is_all_day);
    assert!(ev.field_clocks.is_none());
    assert!(ev.target_calendar_id.is_none());
    assert!(ev.attendees.is_none());
}

#[test]
fn calendar_source_roundtrip() {
    let db = memry_desktop_tauri_lib::db::Db::open_memory().unwrap();
    let conn = db.conn().unwrap();

    conn.execute(
        "INSERT INTO calendar_sources (id, provider, kind, remote_id, title) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params!["src1", "google", "calendar", "primary@example.com", "Primary"],
    )
    .unwrap();

    let src = conn
        .query_row(
            "SELECT * FROM calendar_sources WHERE id = 'src1'",
            [],
            memry_desktop_tauri_lib::db::calendar_sources::CalendarSource::from_row,
        )
        .unwrap();
    assert_eq!(src.id, "src1");
    assert_eq!(src.provider, "google");
    assert_eq!(src.kind, "calendar");
    assert_eq!(src.remote_id, "primary@example.com");
    assert_eq!(src.title, "Primary");
    assert!(!src.is_primary);
    assert!(!src.is_selected);
    assert!(!src.is_memry_managed);
    assert_eq!(src.sync_status, "idle");
    assert!(src.last_error.is_none());
}

#[test]
fn calendar_external_event_roundtrip() {
    let db = memry_desktop_tauri_lib::db::Db::open_memory().unwrap();
    let conn = db.conn().unwrap();

    conn.execute(
        "INSERT INTO calendar_sources (id, provider, kind, remote_id, title) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params!["src1", "google", "calendar", "primary@example.com", "Primary"],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO calendar_external_events \
         (id, source_id, remote_event_id, title, start_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params!["xev1", "src1", "remote-abc", "Standup", "2026-04-25T09:00:00.000Z"],
    )
    .unwrap();

    let xev = conn
        .query_row(
            "SELECT * FROM calendar_external_events WHERE id = 'xev1'",
            [],
            memry_desktop_tauri_lib::db::calendar_external_events::CalendarExternalEvent::from_row,
        )
        .unwrap();
    assert_eq!(xev.id, "xev1");
    assert_eq!(xev.source_id, "src1");
    assert_eq!(xev.remote_event_id, "remote-abc");
    assert_eq!(xev.title, "Standup");
    assert_eq!(xev.status, "confirmed");
    assert!(!xev.is_all_day);
    assert!(xev.attendees.is_none());
}

#[test]
fn calendar_binding_roundtrip() {
    let db = memry_desktop_tauri_lib::db::Db::open_memory().unwrap();
    let conn = db.conn().unwrap();

    conn.execute(
        "INSERT INTO calendar_bindings \
         (id, source_type, source_id, provider, remote_calendar_id, remote_event_id, \
          ownership_mode, writeback_mode) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            "b1",
            "task",
            "t1",
            "google",
            "primary@example.com",
            "remote-event-1",
            "memry-owned",
            "two-way",
        ],
    )
    .unwrap();

    let b = conn
        .query_row(
            "SELECT * FROM calendar_bindings WHERE id = 'b1'",
            [],
            memry_desktop_tauri_lib::db::calendar_bindings::CalendarBinding::from_row,
        )
        .unwrap();
    assert_eq!(b.id, "b1");
    assert_eq!(b.source_type, "task");
    assert_eq!(b.source_id, "t1");
    assert_eq!(b.provider, "google");
    assert_eq!(b.remote_calendar_id, "primary@example.com");
    assert_eq!(b.remote_event_id, "remote-event-1");
    assert_eq!(b.ownership_mode, "memry-owned");
    assert_eq!(b.writeback_mode, "two-way");
    assert!(b.remote_version.is_none());
}
