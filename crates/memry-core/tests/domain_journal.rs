//! Journal domain writes (T128, FR-054, chapter 07 §7.1).
//!
//! | Test                                        | Rule                           |
//! | ------------------------------------------- | ------------------------------ |
//! | a day is created once and then only read    | FR-054, one row per day        |
//! | an existing record's id wins over `j<date>` | chapter 07 §7.1                |
//! | a deleted day is revived under its own id   | `journal_entries.date` UNIQUE  |
//! | the body is a document keyed by the record  | §7.1, FR-055                   |
//! | a date that is not a calendar day is refused | §A.6, the date travels        |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::domain::journal;
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";
const DAY: &str = "2026-04-16";

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

fn payload_of(conn: &Connection, item_id: &str) -> Value {
    let raw = sync_items::push_payload(conn, "journal", item_id)
        .expect("read the row")
        .expect("a payload");
    serde_json::from_str(&raw).expect("valid JSON")
}

fn queued(conn: &Connection) -> i64 {
    conn.query_row("SELECT count(*) FROM outbox", [], |row| row.get(0))
        .expect("count")
}

fn remote_day(item_id: &str, date: &str) -> sync_items::InboundRecord {
    sync_items::InboundRecord {
        item_type: "journal".to_owned(),
        item_id: item_id.to_owned(),
        payload_json: json!({"date": date, "clock": {"device-b": 4}}).to_string(),
        server_cursor: Some(9),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: NOW,
        deleted_at: None,
    }
}

#[test]
fn opening_a_day_creates_it_once_and_then_writes_nothing() {
    let db = open("journal-open");
    db.call_blocking(|conn| {
        let first = journal::open_day(conn, DAY, DEVICE, NOW)?;
        assert_eq!(first.id, "j2026-04-16");
        assert_eq!(first.date, DAY);
        assert!(first.created);
        assert!(!first.revived);

        let stored = payload_of(conn, &first.id);
        assert_eq!(stored["date"], json!(DAY));
        assert_eq!(stored["content"], json!(""));
        assert_eq!(stored["clock"], json!({"device-a": 1}));
        assert_eq!(stored["createdAt"], json!("2025-10-09T08:53:20.000Z"));

        let (id, date): (String, String) = conn
            .query_row("SELECT id, date FROM journal_entries", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .expect("one row for the day");
        assert_eq!((id.as_str(), date.as_str()), ("j2026-04-16", DAY));
        assert_eq!(queued(conn), 1);

        // The second open is the common case — "open today" — and it must not
        // write, or every launch would push a record.
        let second = journal::open_day(conn, DAY, DEVICE, NOW + 60_000)?;
        assert_eq!(second.id, "j2026-04-16");
        assert!(!second.created);
        assert!(!second.revived);
        assert_eq!(
            payload_of(conn, &second.id)["clock"],
            json!({"device-a": 1})
        );
        assert_eq!(queued(conn), 1);
        Ok(())
    })
    .expect("open");
}

#[test]
fn an_existing_record_s_id_wins_over_the_minted_one() {
    let db = open("journal-canonical");
    db.call_blocking(|conn| {
        // Desktop mints `j<YYYY-MM-DD>`, but §7.1 is explicit: a client MUST
        // NOT derive the document id from the date when a record exists.
        sync_items::apply_remote(conn, &remote_day("legacy-journal-id", DAY), NOW)?;

        let opened = journal::open_day(conn, DAY, DEVICE, NOW + 1)?;
        assert_eq!(opened.id, "legacy-journal-id");
        assert!(!opened.created);
        assert_eq!(journal::document_id_for(DAY)?, "j2026-04-16");
        assert!(
            sync_items::load(conn, "journal", "j2026-04-16")?.is_none(),
            "no second entry for the same day"
        );
        assert_eq!(queued(conn), 0);
        Ok(())
    })
    .expect("canonical");
}

#[test]
fn a_deleted_day_is_revived_under_its_own_id_because_the_date_is_unique() {
    let db = open("journal-revive");
    db.call_blocking(|conn| {
        sync_items::apply_remote(conn, &remote_day("legacy-journal-id", DAY), NOW)?;
        // A remote delete arrives.
        let mut tombstone = remote_day("legacy-journal-id", DAY);
        tombstone.deleted_at = Some(NOW + 1);
        sync_items::apply_remote(conn, &tombstone, NOW + 1)?;

        let entry = journal::entry_for(conn, DAY)?.expect("the row is still there");
        assert_eq!(entry, ("legacy-journal-id".to_owned(), true));

        let opened = journal::open_day(conn, DAY, DEVICE, NOW + 2)?;
        assert_eq!(opened.id, "legacy-journal-id");
        assert!(!opened.created);
        assert!(opened.revived);

        let row = sync_items::load(conn, "journal", "legacy-journal-id")?.expect("the row");
        assert_eq!(row.deleted_at, None);
        assert_eq!(
            payload_of(conn, "legacy-journal-id")["clock"],
            json!({"device-a": 1, "device-b": 4}),
            "the peer's ticks survive the revival"
        );

        let live: i64 = conn
            .query_row(
                "SELECT count(*) FROM journal_entries WHERE deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(live, 1);
        assert_eq!(queued(conn), 1);
        Ok(())
    })
    .expect("revive");
}

#[test]
fn the_day_gets_the_same_body_row_a_note_gets() {
    let db = open("journal-body");
    db.call_blocking(|conn| {
        let opened = journal::open_day(conn, DAY, DEVICE, NOW)?;
        let (text, seed): (String, Option<String>) = conn
            .query_row(
                "SELECT text, seed_markdown FROM note_bodies WHERE note_id = ?1",
                [&opened.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the body row, keyed by the record id (§7.1)");
        assert_eq!(text, "");
        assert_eq!(seed, None);
        Ok(())
    })
    .expect("body");
}

#[test]
fn a_date_that_is_not_a_calendar_day_never_becomes_a_row() {
    let db = open("journal-date");
    db.call_blocking(|conn| {
        for bad in ["2026-02-30", "2026-13-01", "2026-4-16", "today", ""] {
            assert!(
                journal::open_day(conn, bad, DEVICE, NOW).is_err(),
                "`{bad}` is not a calendar date"
            );
            assert!(journal::document_id_for(bad).is_err());
        }
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM journal_entries", [], |row| row.get(0))
            .expect("count");
        assert_eq!(rows, 0);
        assert_eq!(queued(conn), 0);
        Ok(())
    })
    .expect("dates");
}

#[test]
fn a_day_with_a_live_entry_is_reported_without_a_write() {
    let db = open("journal-entry-for");
    db.call_blocking(|conn| {
        assert_eq!(journal::entry_for(conn, DAY)?, None);
        journal::open_day(conn, DAY, DEVICE, NOW)?;
        assert_eq!(
            journal::entry_for(conn, DAY)?,
            Some(("j2026-04-16".to_owned(), false))
        );
        assert!(journal::entry_for(conn, "nonsense").is_err());
        Ok(())
    })
    .expect("entry_for");
}
