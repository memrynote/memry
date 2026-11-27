//! A fresh `data.db` holds exactly the seven calendar tables, with the columns
//! Step 36's Electron import maps onto (#3546 Design, "Core owner and
//! schema"). A column added, dropped or retyped here changes that mapping.

use memry_core::api::vault::Vault;
use rusqlite::Connection;

/// Each column as `name TYPE [NOT NULL] [DEFAULT x] [PK n]`, in order.
fn columns(conn: &Connection, table: &str) -> Vec<String> {
    let mut statement = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .expect("prepare");
    statement
        .query_map([], |row| {
            let mut line = format!("{} {}", row.get::<_, String>(1)?, row.get::<_, String>(2)?);
            if row.get::<_, i64>(3)? != 0 {
                line.push_str(" NOT NULL");
            }
            if let Some(default) = row.get::<_, Option<String>>(4)? {
                line.push_str(&format!(" DEFAULT {default}"));
            }
            let key = row.get::<_, i64>(5)?;
            if key != 0 {
                line.push_str(&format!(" PK {key}"));
            }
            Ok(line)
        })
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

fn spec(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}

const SOURCES: &str = "
    id TEXT PK 1
    provider TEXT NOT NULL DEFAULT 'google'
    kind TEXT NOT NULL DEFAULT 'calendar'
    account_id TEXT
    remote_id TEXT NOT NULL
    title TEXT NOT NULL DEFAULT 'Untitled calendar'
    timezone TEXT
    color TEXT
    is_primary INTEGER NOT NULL DEFAULT 0
    is_selected INTEGER NOT NULL DEFAULT 0
    is_memry_managed INTEGER NOT NULL DEFAULT 0
    sync_cursor TEXT
    sync_status TEXT NOT NULL DEFAULT 'idle'
    last_synced_at TEXT
    last_error TEXT
    metadata TEXT
    archived_at TEXT
    created_at INTEGER
    modified_at INTEGER
    clock TEXT
    synced_at INTEGER
    deleted_at INTEGER";

const EVENTS: &str = "
    id TEXT PK 1
    title TEXT NOT NULL DEFAULT 'Untitled event'
    description TEXT
    location TEXT
    start_at TEXT NOT NULL
    end_at TEXT
    timezone TEXT NOT NULL DEFAULT 'UTC'
    is_all_day INTEGER NOT NULL DEFAULT 0
    recurrence_rule TEXT
    recurrence_exceptions TEXT
    attendees TEXT
    reminders TEXT
    visibility TEXT
    color_id TEXT
    conference_data TEXT
    parent_event_id TEXT
    original_start_time TEXT
    target_calendar_id TEXT
    archived_at TEXT
    created_at INTEGER
    modified_at INTEGER
    clock TEXT
    field_clocks TEXT
    synced_at INTEGER
    deleted_at INTEGER";

const EXTERNAL_EVENTS: &str = "
    id TEXT PK 1
    source_id TEXT NOT NULL
    remote_event_id TEXT NOT NULL
    remote_etag TEXT
    remote_updated_at TEXT
    title TEXT NOT NULL DEFAULT 'Untitled imported event'
    description TEXT
    location TEXT
    start_at TEXT NOT NULL
    end_at TEXT
    timezone TEXT
    is_all_day INTEGER NOT NULL DEFAULT 0
    status TEXT NOT NULL DEFAULT 'confirmed'
    recurrence_rule TEXT
    attendees TEXT
    reminders TEXT
    visibility TEXT
    color_id TEXT
    conference_data TEXT
    raw_payload TEXT
    archived_at TEXT
    created_at INTEGER
    modified_at INTEGER
    clock TEXT
    synced_at INTEGER
    deleted_at INTEGER";

const BINDINGS: &str = "
    id TEXT PK 1
    source_type TEXT NOT NULL DEFAULT 'event'
    source_id TEXT NOT NULL
    provider TEXT NOT NULL DEFAULT 'google'
    remote_calendar_id TEXT NOT NULL DEFAULT 'primary'
    remote_event_id TEXT NOT NULL
    ownership_mode TEXT NOT NULL DEFAULT 'memry_managed'
    writeback_mode TEXT NOT NULL DEFAULT 'broad'
    remote_version TEXT
    last_local_snapshot TEXT
    archived_at TEXT
    created_at_raw TEXT
    created_at INTEGER
    modified_at INTEGER
    clock TEXT
    synced_at INTEGER
    deleted_at INTEGER";

const LOCAL_EVENTS: &str = "
    id TEXT PK 1
    source_id TEXT NOT NULL
    remote_event_id TEXT NOT NULL
    title TEXT NOT NULL
    description TEXT
    location TEXT
    start_at TEXT NOT NULL
    end_at TEXT
    timezone TEXT
    is_all_day INTEGER NOT NULL DEFAULT 0
    status TEXT NOT NULL DEFAULT 'confirmed'
    recurrence_rule TEXT
    attendees TEXT
    reminders TEXT
    conference_data TEXT
    raw_payload TEXT
    modified_at INTEGER";

const SOURCE_STATES: &str = "
    source_id TEXT PK 1
    sync_status TEXT NOT NULL DEFAULT 'idle'
    last_synced_at TEXT
    last_error TEXT
    etag TEXT
    last_modified TEXT
    refresh_ms INTEGER
    next_refresh_ms INTEGER";

const PUSH_QUEUE: &str = "
    source_type TEXT NOT NULL PK 1
    source_id TEXT NOT NULL PK 2
    queued_at INTEGER NOT NULL
    attempts INTEGER NOT NULL DEFAULT 0
    last_error TEXT";

#[test]
fn a_fresh_data_db_holds_exactly_the_seven_calendar_tables() {
    let dir = tempfile::Builder::new()
        .prefix("memry-calendar-schema-")
        .tempdir()
        .expect("the scratch directory");
    drop(Vault::open("v".to_owned(), dir.path().display().to_string()).expect("open"));
    let conn = Connection::open(dir.path().join("data.db")).expect("a reader");

    let mut statement = conn
        .prepare(
            "SELECT name FROM sqlite_master
              WHERE type = 'table' AND name LIKE 'calendar%' ORDER BY name",
        )
        .expect("prepare");
    let tables: Vec<String> = statement
        .query_map([], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows");
    let expected = [
        ("calendar_bindings", BINDINGS),
        ("calendar_events", EVENTS),
        ("calendar_external_events", EXTERNAL_EVENTS),
        ("calendar_local_events", LOCAL_EVENTS),
        ("calendar_push_queue", PUSH_QUEUE),
        ("calendar_source_states", SOURCE_STATES),
        ("calendar_sources", SOURCES),
    ];
    assert_eq!(
        tables,
        expected.iter().map(|(name, _)| *name).collect::<Vec<_>>()
    );
    for (table, columns_spec) in expected {
        assert_eq!(columns(&conn, table), spec(columns_spec), "{table}");
    }
}
