//! The same day in other years (On this day). The rule cases mirror
//! `packages/domain-notes/src/journal/same-day.test.ts` one for one; the
//! query cases mirror desktop's `getJournalSameDayEntries` test in
//! `apps/desktop/src/main/database/queries/notes/notes.test.ts`.
//!
//! | Test                                                          | Rule                           |
//! | ------------------------------------------------------------- | ------------------------------ |
//! | matches the same month and day in another year only           | same-day.ts                    |
//! | shows a leap day on Feb 28 of a non-leap year                 | same-day.ts                    |
//! | keeps a leap year Feb 28 to its own day                       | same-day.ts                    |
//! | shows non-leap Feb 28s on a leap day, not leap-year Feb 28s   | same-day.ts                    |
//! | the query lists other years newest first, leap days on Feb 28 | `getJournalSameDayEntries`     |
//! | the query has no year bound and skips tombstones              | years 0000-9999, live only     |
//! | the query carries previews, levels and today flags            | the rail's row                 |
//! | the query drops empty and whitespace-only bodies              | `content.trim() === ''`        |
//! | the query keeps text-free blocks and an NEL paragraph         | desktop's markdown is not `''` |

use std::sync::{Arc, Mutex};

use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::{DocumentRegistry, update_log};
use memry_core::domain::journal_ops::reads::{self, JournalBodyState};
use memry_core::domain::journal_rules::{is_same_day_in_other_year, same_day_month_days};
use memry_core::domain::search;
use memry_core::storage::migrations::{self, DATA_MIGRATIONS, INDEX_MIGRATIONS};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use rusqlite::Connection;
use serde_json::json;
use yrs::{
    ReadTxn as _, TransactionMut, Xml as _, XmlElementPrelim, XmlElementRef, XmlFragment as _,
    XmlTextPrelim,
};

const NOW: i64 = 1_760_000_000_000;

fn data() -> Connection {
    let mut data = Connection::open_in_memory().expect("data.db");
    migrations::run(&mut data, DATA_MIGRATIONS).expect("data migrations");
    data
}

fn record(conn: &Connection, date: &str, deleted_at: Option<i64>) {
    let record = InboundRecord {
        item_type: "journal".to_owned(),
        item_id: format!("j{date}"),
        payload_json: json!({ "date": date }).to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: NOW,
        deleted_at,
    };
    sync_items::apply_remote(conn, &record, NOW).expect("apply the record");
}

/// A live day pulled from the server, with a body holding `text`.
fn day(conn: &Connection, date: &str, text: &str) {
    pulled_day(conn, date, &[text], None);
}

/// A live day pulled from the server: one paragraph per entry of
/// `paragraphs`, then `bare` as a text node outside any block. Extraction
/// trims a block's line but not a bare node, so only a bare node can extract
/// to whitespace-only text.
fn pulled_day(conn: &Connection, date: &str, paragraphs: &[&str], bare: Option<&str>) {
    pulled_blocks(conn, date, |txn, group| {
        for text in paragraphs {
            let container = group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
            let paragraph = container.push_back(txn, XmlElementPrelim::empty("paragraph"));
            paragraph.push_back(txn, XmlTextPrelim::new(*text));
        }
        if let Some(text) = bare {
            group.push_back(txn, XmlTextPrelim::new(text));
        }
    });
}

/// A live day pulled from the server whose body's top `blockGroup` is filled
/// by `build`.
fn pulled_blocks(
    conn: &Connection,
    date: &str,
    build: impl FnOnce(&mut TransactionMut, &XmlElementRef),
) {
    record(conn, date, None);
    let doc_id = format!("j{date}");
    let captured: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
    let sink: UpdateSink = {
        let captured = Arc::clone(&captured);
        Arc::new(move |_, bytes: &[u8]| captured.lock().expect("lock").push(bytes.to_vec()))
    };
    let document = DocumentRegistry::new("device-b", sink)
        .get_or_open(&doc_id)
        .expect("open");
    document
        .write(|txn| {
            let fragment = txn
                .get_xml_fragment("prosemirror")
                .expect("the root is typed at open");
            let group = fragment.push_back(txn, XmlElementPrelim::empty("blockGroup"));
            build(txn, &group);
        })
        .expect("a write transaction");
    let update = captured.lock().expect("lock")[0].clone();
    update_log::append_server_update(conn, &doc_id, 1, &update, NOW).expect("append");
}

fn dates(conn: &Connection, date: &str, today: &str) -> Vec<String> {
    reads::same_day_entries(conn, date, today)
        .expect("read")
        .into_iter()
        .map(|day| day.date)
        .collect()
}

#[test]
fn matches_the_same_month_and_day_in_another_year_only() {
    assert_eq!(same_day_month_days("2026-11-10"), ["11-10"]);
    assert!(is_same_day_in_other_year("2026-11-10", "2025-11-10"));
    assert!(!is_same_day_in_other_year("2026-11-10", "2026-11-10"));
    assert!(!is_same_day_in_other_year("2026-11-10", "2025-11-11"));
}

#[test]
fn shows_a_leap_day_on_feb_28_of_a_non_leap_year() {
    assert_eq!(same_day_month_days("2027-02-28"), ["02-28", "02-29"]);
    assert!(is_same_day_in_other_year("2027-02-28", "2024-02-29"));
    assert!(is_same_day_in_other_year("2027-02-28", "2024-02-28"));
}

#[test]
fn keeps_a_leap_year_feb_28_to_its_own_day() {
    assert_eq!(same_day_month_days("2028-02-28"), ["02-28"]);
    assert!(!is_same_day_in_other_year("2028-02-28", "2024-02-29"));
}

#[test]
fn shows_non_leap_feb_28s_on_a_leap_day_but_not_leap_year_feb_28s() {
    assert_eq!(same_day_month_days("2028-02-29"), ["02-29", "02-28"]);
    assert!(is_same_day_in_other_year("2028-02-29", "2024-02-29"));
    assert!(is_same_day_in_other_year("2028-02-29", "2027-02-28"));
    assert!(!is_same_day_in_other_year("2028-02-29", "2024-02-28"));
}

#[test]
fn the_query_lists_other_years_newest_first_with_leap_days_on_feb_28() {
    let conn = data();
    for date in [
        "2024-02-28",
        "2024-02-29",
        "2025-02-28",
        "2026-02-27",
        "2027-02-28",
    ] {
        day(&conn, date, "entry");
    }

    assert_eq!(
        dates(&conn, "2027-02-28", "2027-03-01"),
        ["2025-02-28", "2024-02-29", "2024-02-28"]
    );
    assert_eq!(
        dates(&conn, "2028-02-29", "2028-03-01"),
        ["2027-02-28", "2025-02-28", "2024-02-29"]
    );
    assert_eq!(
        dates(&conn, "2028-02-28", "2028-03-01"),
        ["2027-02-28", "2025-02-28", "2024-02-28"],
        "a leap year's Feb 28 keeps to Feb 28"
    );
}

#[test]
fn the_query_has_no_year_bound_and_skips_tombstones() {
    let conn = data();
    for date in ["0000-06-15", "0999-06-15", "1000-06-15", "9999-06-15"] {
        day(&conn, date, "entry");
    }
    record(&conn, "2050-06-15", Some(NOW));

    assert_eq!(
        dates(&conn, "2097-06-15", "2097-06-15"),
        ["9999-06-15", "1000-06-15", "0999-06-15", "0000-06-15"]
    );
    assert!(dates(&conn, "2097-06-16", "2097-06-15").is_empty());
    assert!(reads::same_day_entries(&conn, "2097-02-30", "2097-06-15").is_err());
    assert!(reads::same_day_entries(&conn, "2097-06-15", "junk").is_err());
}

#[test]
fn the_query_carries_previews_levels_and_today_flags() {
    let conn = data();
    day(&conn, "2099-06-15", &"a".repeat(150));
    day(&conn, "2095-06-15", "Lake swim.");
    record(&conn, "2094-06-15", None);

    let days = reads::same_day_entries(&conn, "2097-06-15", "2099-06-15").expect("read");
    let rows: Vec<_> = days
        .iter()
        .map(|day| {
            (
                day.date.as_str(),
                day.is_today,
                day.is_future,
                day.level,
                day.preview.as_str(),
                day.body_state,
            )
        })
        .collect();
    let long = format!("{}...", "a".repeat(100));
    assert_eq!(
        rows,
        [
            (
                "2099-06-15",
                true,
                false,
                2,
                long.as_str(),
                Some(JournalBodyState::Present)
            ),
            (
                "2095-06-15",
                false,
                false,
                1,
                "Lake swim.",
                Some(JournalBodyState::Present)
            ),
            (
                "2094-06-15",
                false,
                false,
                0,
                "",
                Some(JournalBodyState::NotPulled)
            ),
        ]
    );
    assert!(days.iter().all(|day| day.has_entry));
}

#[test]
fn the_query_drops_empty_and_whitespace_only_bodies_but_keeps_not_pulled_ones() {
    let conn = data();
    day(&conn, "2096-06-15", "Lake swim.");
    day(&conn, "2095-06-15", "");
    pulled_day(
        &conn,
        "2094-06-15",
        &["", " \u{00A0}"],
        Some(" \n\u{FEFF}\t"),
    );
    record(&conn, "2093-06-15", None);

    let state = |date| {
        reads::day(&conn, date)
            .expect("read")
            .map(|day| day.body_state)
    };
    assert_eq!(state("2095-06-15"), Some(JournalBodyState::Empty));
    assert_eq!(
        state("2094-06-15"),
        Some(JournalBodyState::Present),
        "the bare node keeps whitespace-only text past extraction"
    );
    assert_decoded_and_cached(
        &conn,
        &[
            ("2096-06-15", JournalBodyState::Present),
            ("2093-06-15", JournalBodyState::NotPulled),
        ],
    );
}

#[test]
fn the_query_keeps_text_free_blocks_and_an_nel_paragraph() {
    let conn = data();
    let block = |date, kind: &'static str| {
        pulled_blocks(&conn, date, |txn, group| {
            let container = group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
            let block = container.push_back(txn, XmlElementPrelim::empty(kind));
            if kind == "table" {
                let row = block.push_back(txn, XmlElementPrelim::empty("tableRow"));
                let cell = row.push_back(txn, XmlElementPrelim::empty("tableCell"));
                cell.push_back(txn, XmlElementPrelim::empty("tableParagraph"));
            } else {
                block.insert_attribute(txn, "url", "p.png");
            }
        });
    };
    block("2096-06-15", "image");
    block("2095-06-15", "divider");
    block("2094-06-15", "table");
    day(&conn, "2093-06-15", "\u{0085}");
    day(&conn, "2092-06-15", " ");

    assert_decoded_and_cached(
        &conn,
        &[
            ("2096-06-15", JournalBodyState::Empty),
            ("2095-06-15", JournalBodyState::Empty),
            ("2094-06-15", JournalBodyState::Empty),
            ("2093-06-15", JournalBodyState::Empty),
        ],
    );
}

/// The same-day rows for 2097-06-15 equal `expected`, read once from the
/// decoded log and once from fresh `note_bodies` rows.
fn assert_decoded_and_cached(conn: &Connection, expected: &[(&str, JournalBodyState)]) {
    let rows = || -> Vec<(String, Option<JournalBodyState>)> {
        reads::same_day_entries(conn, "2097-06-15", "2097-06-15")
            .expect("read")
            .into_iter()
            .map(|day| (day.date, day.body_state))
            .collect()
    };
    let expected: Vec<_> = expected
        .iter()
        .map(|(date, state)| ((*date).to_owned(), Some(*state)))
        .collect();
    assert_eq!(rows(), expected, "decoded from the log");

    let mut index = Connection::open_in_memory().expect("index.db");
    migrations::run(&mut index, INDEX_MIGRATIONS).expect("index migrations");
    search::reindex(conn, &index, NOW).expect("reindex");
    let fresh: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM note_bodies WHERE source_seq IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert!(fresh > 0, "reindex materialised the cache rows");
    assert_eq!(rows(), expected, "read from the cache");
}
