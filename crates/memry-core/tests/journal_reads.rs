//! Journal reads (spec 005-journal JP023).
//!
//! | Test                                                   | Rule                               |
//! | ------------------------------------------------------ | ---------------------------------- |
//! | a day reads tags, properties without date, counts      | D5 reserved `date`, D6 counts      |
//! | a day with no entry or a tombstone reads none          | D2, tombstones never count         |
//! | a body not pulled is not an empty day                  | `NotPulled` vs `Empty`             |
//! | a fresh `note_bodies` row is read, a stale one never   | `source_seq` freshness token       |
//! | a month lists every day newest first                   | desktop `JournalMonthView`         |
//! | a year totals its cards                                | desktop Year view totals           |
//! | the streak counts from the caller's today              | D3                                 |
//! | days with entries honours the range and tombstones     | live entries only                  |
//! | a month or year out of range is refused                | `StorageError::Invalid`            |

use std::sync::{Arc, Mutex};

use memry_core::api::errors::StorageError;
use memry_core::crdt::errors::CrdtError;
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::{DocumentRegistry, update_log};
use memry_core::domain::journal;
use memry_core::domain::journal_ops::reads::{self, JournalBodyState};
use memry_core::domain::search;
use memry_core::storage::migrations::{self, DATA_MIGRATIONS, INDEX_MIGRATIONS};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use rusqlite::Connection;
use serde_json::{Value, json};
use yrs::{ReadTxn as _, XmlElementPrelim, XmlFragment as _, XmlTextPrelim};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";

fn data() -> Connection {
    let mut data = Connection::open_in_memory().expect("data.db");
    migrations::run(&mut data, DATA_MIGRATIONS).expect("data migrations");
    data
}

/// A remote journal record, as a pull applies it.
fn remote_day(conn: &Connection, id: &str, payload: Value) {
    let record = InboundRecord {
        item_type: "journal".to_owned(),
        item_id: id.to_owned(),
        payload_json: payload.to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: NOW,
        deleted_at: None,
    };
    sync_items::apply_remote(conn, &record, NOW).expect("apply the record");
}

fn tombstone(conn: &Connection, id: &str) {
    let record = InboundRecord {
        item_type: "journal".to_owned(),
        item_id: id.to_owned(),
        payload_json: "{}".to_owned(),
        server_cursor: Some(2),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: NOW + 1,
        deleted_at: Some(NOW + 1),
    };
    sync_items::apply_remote(conn, &record, NOW + 1).expect("apply the tombstone");
}

/// A real lib0 v1 update adding one paragraph holding `text`, authored by
/// `device`.
fn paragraph_update(device: &str, doc_id: &str, text: &str) -> Vec<u8> {
    let captured: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
    let sink: UpdateSink = {
        let captured = Arc::clone(&captured);
        Arc::new(move |_, bytes: &[u8]| captured.lock().expect("lock").push(bytes.to_vec()))
    };
    let document = DocumentRegistry::new(device, sink)
        .get_or_open(doc_id)
        .expect("open");
    document
        .write(|txn| {
            let fragment = txn
                .get_xml_fragment("prosemirror")
                .expect("the root is typed at open");
            let group = fragment.push_back(txn, XmlElementPrelim::empty("blockGroup"));
            let container = group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
            let paragraph = container.push_back(txn, XmlElementPrelim::empty("paragraph"));
            paragraph.push_back(txn, XmlTextPrelim::new(text));
        })
        .expect("a write transaction");
    let updates = captured.lock().expect("lock").clone();
    updates.into_iter().next().expect("one update")
}

/// A body update pulled from the server.
fn pulled_body(conn: &Connection, doc_id: &str, seq: i64, text: &str) {
    let update = paragraph_update("device-b", doc_id, text);
    update_log::append_server_update(conn, doc_id, seq, &update, NOW).expect("append");
}

/// A body update written on this device.
fn local_body(conn: &mut Connection, doc_id: &str, device: &str, text: &str) {
    let update = paragraph_update(device, doc_id, text);
    update_log::append_local_update(conn, doc_id, &update, NOW).expect("append");
}

#[test]
fn a_day_reads_tags_properties_without_date_and_counts_from_the_text() {
    let conn = data();
    remote_day(
        &conn,
        "legacy-id",
        json!({
            "date": "2099-06-15",
            "content": "",
            "tags": ["travel", "Café"],
            "properties": {"date": "2099-06-15", "mood": "good", "energy": 3},
            "clock": {"device-b": 1},
            "createdAt": "2099-06-15T08:00:00.000Z",
            "modifiedAt": "2099-06-15T09:00:00.000Z",
        }),
    );
    // "héllo wörld 👋" is 14 UTF-16 units and 3 words.
    pulled_body(&conn, "legacy-id", 1, "héllo wörld 👋");

    let day = reads::day(&conn, "2099-06-15")
        .expect("read")
        .expect("a live day");
    assert_eq!(day.id, "legacy-id");
    assert_eq!(day.date, "2099-06-15");
    assert_eq!(day.tags, ["travel", "Café"]);
    let names: Vec<&str> = day.properties.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, ["energy", "mood"], "sorted, `date` left out");
    assert_eq!(day.properties[1].value_json, "\"good\"");
    assert_eq!(day.created_at, Some(4_085_193_600_000));
    assert_eq!(day.modified_at, Some(4_085_197_200_000));
    assert_eq!(day.word_count, 3);
    assert_eq!(day.character_count, 14);
    assert_eq!(day.body_state, JournalBodyState::Present);
}

#[test]
fn a_day_with_no_entry_or_a_tombstone_reads_none() {
    let conn = data();
    assert_eq!(reads::day(&conn, "2099-06-15").expect("read"), None);

    remote_day(&conn, "j2099-06-15", json!({"date": "2099-06-15"}));
    pulled_body(&conn, "j2099-06-15", 1, "gone soon");
    tombstone(&conn, "j2099-06-15");
    assert_eq!(reads::day(&conn, "2099-06-15").expect("read"), None);

    assert!(matches!(
        reads::day(&conn, "2099-02-30"),
        Err(CrdtError::Storage { .. })
    ));
}

#[test]
fn a_body_not_pulled_is_not_an_empty_day() {
    let mut conn = data();
    // Created here with no edit: the log holds nothing yet.
    journal::open_day(&conn, "2099-06-10", DEVICE, NOW).expect("open");
    // Created elsewhere, body still on the server.
    remote_day(&conn, "j2099-06-11", json!({"date": "2099-06-11"}));
    // A body that exists and holds no text.
    remote_day(&conn, "j2099-06-12", json!({"date": "2099-06-12"}));
    local_body(&mut conn, "j2099-06-12", DEVICE, "");

    for date in ["2099-06-10", "2099-06-11"] {
        let day = reads::day(&conn, date).expect("read").expect("live");
        assert_eq!(day.body_state, JournalBodyState::NotPulled, "{date}");
        assert_eq!((day.character_count, day.word_count), (0, 0));
    }
    let empty = reads::day(&conn, "2099-06-12")
        .expect("read")
        .expect("live");
    assert_eq!(empty.body_state, JournalBodyState::Empty);

    let june = reads::month(&conn, 2099, 6, "2099-06-20").expect("month");
    let unpulled = june
        .days
        .iter()
        .find(|day| day.date == "2099-06-11")
        .expect("the day");
    assert!(unpulled.has_entry);
    assert_eq!(unpulled.level, 0);
    assert_eq!(unpulled.preview, "");
    assert_eq!(unpulled.body_state, Some(JournalBodyState::NotPulled));
    assert_eq!(june.entry_count, 3, "every live entry, pulled or not");

    let year = reads::year(&conn, 2099, "2099-06-20").expect("year");
    assert_eq!(year.days_with_entries, 0, "no day holds characters");
    assert_eq!(year.total_characters, 0);
}

#[test]
fn a_fresh_note_bodies_row_is_read_and_a_stale_one_never() {
    let mut conn = data();
    let mut index = Connection::open_in_memory().expect("index.db");
    migrations::run(&mut index, INDEX_MIGRATIONS).expect("index migrations");

    remote_day(&conn, "j2099-06-15", json!({"date": "2099-06-15"}));
    pulled_body(&conn, "j2099-06-15", 1, "first");
    search::reindex(&conn, &index, NOW).expect("reindex");
    let cached: String = conn
        .query_row(
            "SELECT text FROM note_bodies WHERE note_id = 'j2099-06-15'",
            [],
            |row| row.get(0),
        )
        .expect("materialised");
    assert_eq!(cached, "first");
    assert_eq!(
        reads::day(&conn, "2099-06-15")
            .expect("read")
            .expect("live")
            .character_count,
        5
    );
    // A fresh row is the read's source: no log replay.
    conn.execute(
        "UPDATE note_bodies SET text = 'from the cache' WHERE note_id = 'j2099-06-15'",
        [],
    )
    .expect("mark the cached row");
    assert_eq!(
        reads::day(&conn, "2099-06-15")
            .expect("read")
            .expect("live")
            .character_count,
        14
    );

    // A local edit moves the log past the cached row; the read must see it.
    local_body(&mut conn, "j2099-06-15", DEVICE, "second");
    let day = reads::day(&conn, "2099-06-15")
        .expect("read")
        .expect("live");
    assert_eq!(day.character_count, 12, "\"first\\nsecond\" in some order");
    assert_eq!(day.word_count, 2);
}

#[test]
fn a_month_lists_every_day_newest_first_with_today_and_future_flags() {
    let mut conn = data();
    remote_day(&conn, "j2099-02-01", json!({"date": "2099-02-01"}));
    pulled_body(&conn, "j2099-02-01", 1, &"a".repeat(150));
    journal::open_day(&conn, "2099-02-14", DEVICE, NOW).expect("open");
    local_body(&mut conn, "j2099-02-14", DEVICE, "# Heading\nValentine");
    remote_day(&conn, "j2099-02-20", json!({"date": "2099-02-20"}));
    pulled_body(&conn, "j2099-02-20", 1, "deleted");
    tombstone(&conn, "j2099-02-20");

    let month = reads::month(&conn, 2099, 2, "2099-02-14").expect("month");
    assert_eq!((month.year, month.month), (2099, 2));
    assert_eq!(month.days.len(), 28);
    assert_eq!(month.days[0].date, "2099-02-28");
    assert_eq!(month.days[27].date, "2099-02-01");
    assert_eq!(month.entry_count, 2, "the tombstoned day does not count");

    let at = |date: &str| {
        month
            .days
            .iter()
            .find(|day| day.date == date)
            .expect("the day")
    };
    let today = at("2099-02-14");
    assert!(today.is_today && !today.is_future && today.has_entry);
    assert_eq!(today.body_state, Some(JournalBodyState::Present));
    assert_eq!(today.preview, "Heading Valentine");
    assert_eq!(today.level, 1);

    let first = at("2099-02-01");
    assert!(!first.is_today && !first.is_future);
    assert_eq!((first.character_count, first.level), (150, 2));

    let gone = at("2099-02-20");
    assert!(gone.is_future && !gone.has_entry);
    assert_eq!((gone.level, gone.body_state), (0, None));
    assert_eq!(gone.preview, "");

    assert_eq!(month.streak.current_streak, 1);
    assert_eq!(month.streak.last_entry_date.as_deref(), Some("2099-02-14"));
}

#[test]
fn a_year_totals_its_cards() {
    let mut conn = data();
    remote_day(&conn, "j2099-01-03", json!({"date": "2099-01-03"}));
    pulled_body(&conn, "j2099-01-03", 1, &"x".repeat(600));
    remote_day(&conn, "j2099-01-04", json!({"date": "2099-01-04"}));
    pulled_body(&conn, "j2099-01-04", 1, "short");
    journal::open_day(&conn, "2099-03-31", DEVICE, NOW).expect("open");
    local_body(&mut conn, "j2099-03-31", DEVICE, &"y".repeat(1200));
    // Not pulled: counted for the streak, not for characters.
    remote_day(&conn, "j2099-04-01", json!({"date": "2099-04-01"}));
    // Another year never leaks in.
    remote_day(&conn, "j2098-12-31", json!({"date": "2098-12-31"}));
    pulled_body(&conn, "j2098-12-31", 1, "last year");

    let year = reads::year(&conn, 2099, "2099-04-01").expect("year");
    assert_eq!(year.months.len(), 12);
    assert_eq!(year.months[0].entry_count, 2);
    assert_eq!(year.months[0].total_chars, 605);
    assert_eq!(year.months[0].activity_dots, [3, 0, 0, 0, 0]);
    assert_eq!(year.months[2].activity_dots, [0, 0, 0, 0, 4]);
    assert_eq!(year.months[3].entry_count, 0);
    assert_eq!(year.days_with_entries, 3);
    assert_eq!(year.total_characters, 1805);
    assert_eq!(year.streak.current_streak, 2, "03-31 and 04-01");

    let heatmap = reads::heatmap(&conn, 2099).expect("heatmap");
    let rows: Vec<(&str, u64, u8)> = heatmap
        .iter()
        .map(|day| (day.date.as_str(), day.character_count, day.level))
        .collect();
    assert_eq!(
        rows,
        [
            ("2099-01-03", 600, 3),
            ("2099-01-04", 5, 1),
            ("2099-03-31", 1200, 4),
            ("2099-04-01", 0, 0),
        ]
    );
}

#[test]
fn the_streak_counts_from_the_caller_s_today() {
    let conn = data();
    for date in ["2099-06-10", "2099-06-11", "2099-06-12", "2099-06-14"] {
        remote_day(&conn, &format!("j{date}"), json!({"date": date}));
    }
    remote_day(&conn, "j2099-06-13", json!({"date": "2099-06-13"}));
    tombstone(&conn, "j2099-06-13");

    let on_the_day = reads::streak(&conn, "2099-06-14").expect("streak");
    assert_eq!(on_the_day.current_streak, 1, "the tombstone breaks the run");
    assert_eq!(on_the_day.longest_streak, 3);
    assert_eq!(on_the_day.last_entry_date.as_deref(), Some("2099-06-14"));

    let next_day = reads::streak(&conn, "2099-06-15").expect("streak");
    assert_eq!(next_day.current_streak, 1, "yesterday still counts");
    let later = reads::streak(&conn, "2099-06-16").expect("streak");
    assert_eq!(later.current_streak, 0);
    assert_eq!(later.longest_streak, 3);
}

#[test]
fn days_with_entries_honours_the_range_and_tombstones() {
    let conn = data();
    for date in [
        "2099-05-31",
        "2099-06-01",
        "2099-06-15",
        "2099-06-30",
        "2099-07-01",
    ] {
        remote_day(&conn, &format!("j{date}"), json!({"date": date}));
    }
    tombstone(&conn, "j2099-06-15");

    let days = reads::days_with_entries(&conn, "2099-06-01", "2099-06-30").expect("days");
    assert_eq!(days, ["2099-06-01", "2099-06-30"]);
    assert!(reads::days_with_entries(&conn, "2099-06-01", "junk").is_err());
}

#[test]
fn a_month_or_year_out_of_range_is_refused() {
    let conn = data();
    assert!(matches!(
        reads::month(&conn, 2099, 13, "2099-06-01"),
        Err(CrdtError::Storage {
            source: StorageError::Invalid { .. }
        })
    ));
    assert!(matches!(
        reads::heatmap(&conn, 99),
        Err(CrdtError::Storage {
            source: StorageError::Invalid { .. }
        })
    ));
    assert!(reads::year(&conn, 2099, "not-a-date").is_err());
}
