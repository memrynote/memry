//! On this day's core read (`reads::same_day_calendar_days`, #4630): one query over every
//! year, the rows and order of desktop's `getJournalSameDayEntries`.

use std::cell::Cell;

use memry_core::domain::journal_ops::reads::{self, DayHeld};
use memry_core::storage::migrations::{self, DATA_MIGRATIONS};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use rusqlite::Connection;
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use serde_json::json;

const NOW: i64 = 1_760_000_000_000;

fn data() -> Connection {
    let mut data = Connection::open_in_memory().expect("data.db");
    migrations::run(&mut data, DATA_MIGRATIONS).expect("data migrations");
    data
}

/// A live day as a pull applies it, its file named in `note_files` as the desktop index does.
fn day_with_file(conn: &Connection, date: &str) {
    let id = format!("j{date}");
    let record = InboundRecord {
        item_type: "journal".to_owned(),
        item_id: id.clone(),
        payload_json: json!({ "date": date }).to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: NOW,
        deleted_at: None,
    };
    sync_items::apply_remote(conn, &record, NOW).expect("apply the record");
    conn.execute(
        "INSERT INTO note_files (note_id, path, indexed_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![id, format!("journal/{date}.md"), NOW],
    )
    .expect("file row");
}

fn dates(conn: &Connection, date: &str) -> Vec<String> {
    reads::same_day_calendar_days(conn, date)
        .expect("same-day read")
        .into_iter()
        .map(|day| day.date)
        .collect()
}

// `notes.test.ts` "finds the same day in other years, newest first, with leap days on Feb 28".
#[test]
fn feb_29_rows_match_desktop() {
    let conn = data();
    for date in [
        "2024-02-28",
        "2024-02-29",
        "2025-02-28",
        "2026-02-27",
        "2027-02-28",
    ] {
        day_with_file(&conn, date);
    }
    assert_eq!(
        dates(&conn, "2027-02-28"),
        ["2025-02-28", "2024-02-29", "2024-02-28"]
    );
    assert_eq!(
        dates(&conn, "2028-02-29"),
        ["2027-02-28", "2025-02-28", "2024-02-29"]
    );
    assert_eq!(
        dates(&conn, "2028-02-28"),
        ["2027-02-28", "2025-02-28", "2024-02-28"]
    );
    let first = reads::same_day_calendar_days(&conn, "2027-02-28").unwrap();
    assert_eq!(first[0].id, "j2025-02-28");
    assert_eq!(first[0].held, DayHeld::File("journal/2025-02-28.md".into()));
    assert!(reads::same_day_calendar_days(&conn, "2027-02-30").is_err());
}

thread_local! {
    static STATEMENTS: Cell<usize> = const { Cell::new(0) };
}

fn count_statement(event: TraceEvent<'_>) {
    if let TraceEvent::Stmt(..) = event {
        STATEMENTS.with(|count| count.set(count.get() + 1));
    }
}

/// Statements SQLite ran for one same-day read of `date`.
fn statements_for(conn: &Connection, date: &str) -> (usize, usize) {
    STATEMENTS.with(|count| count.set(0));
    conn.trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, Some(count_statement));
    let rows = reads::same_day_calendar_days(conn, date).unwrap().len();
    conn.trace_v2(TraceEventCodes::empty(), None);
    (rows, STATEMENTS.with(Cell::get))
}

#[test]
fn the_statement_count_does_not_grow_with_the_years() {
    let few = data();
    let many = data();
    for year in 2020..2023 {
        day_with_file(&few, &format!("{year}-06-15"));
    }
    for year in 1990..2023 {
        day_with_file(&many, &format!("{year}-06-15"));
        day_with_file(&many, &format!("{year}-06-16"));
    }
    let (few_rows, few_statements) = statements_for(&few, "2025-06-15");
    let (many_rows, many_statements) = statements_for(&many, "2025-06-15");
    assert_eq!((few_rows, many_rows), (3, 33));
    assert_eq!(few_statements, many_statements);
    assert_eq!(many_statements, 1, "one query over every year");
}
