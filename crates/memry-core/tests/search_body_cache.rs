//! The indexer's body cache against a snapshot that carries the text (#4315).
//!
//! Desktop pushes a new journal day as an update with no text, then the text
//! as a snapshot covering the same sequence. A reindex between the two must
//! not leave the day empty to search once the snapshot lands.
//!
//! Real SQLite, FTS5, update log and `yrs`.

use memry_core::crdt::update_log;
use memry_core::domain::search::{self, NOTES_WATERMARK_KEY, STAMPS_KEY, TASKS_WATERMARK_KEY};
use memry_core::storage::migrations::{self, DATA_MIGRATIONS, INDEX_MIGRATIONS};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use rusqlite::{Connection, params};
use yrs::{
    Doc, ReadTxn as _, StateVector, Transact as _, XmlElementPrelim, XmlFragment as _,
    XmlTextPrelim,
};

const DAY: &str = "j2026-09-21";
const WORD: &str = "zephyrsnaptwo";
const NOW: i64 = 1_794_493_000_000;

fn databases() -> (Connection, Connection) {
    let mut data = Connection::open_in_memory().expect("data.db");
    migrations::run(&mut data, DATA_MIGRATIONS).expect("data migrations");
    let mut index = Connection::open_in_memory().expect("index.db");
    migrations::run(&mut index, INDEX_MIGRATIONS).expect("index migrations");
    (data, index)
}

/// Desktop's two writes for a new day: the empty first update, and the full
/// state with the text as the snapshot that follows it.
fn empty_update_then_snapshot() -> (Vec<u8>, Vec<u8>) {
    let doc = Doc::with_client_id(99);
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let paragraph = {
        let mut txn = doc.transact_mut();
        let container = fragment.insert(&mut txn, 0, XmlElementPrelim::empty("blockContainer"));
        container.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"))
    };
    let first = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    paragraph.insert(
        &mut doc.transact_mut(),
        0,
        XmlTextPrelim::new(format!("Snapshot race {WORD} here.")),
    );
    let snapshot = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    (first, snapshot)
}

fn day_with_empty_first_update(data: &Connection) -> Vec<u8> {
    sync_items::apply_remote(
        data,
        &InboundRecord {
            item_type: "journal".to_owned(),
            item_id: DAY.to_owned(),
            payload_json: r#"{"date":"2026-09-21","content":"Snapshot race","clock":{"d":1}}"#
                .to_owned(),
            server_cursor: Some(1),
            signer_device_id: Some("device-b".to_owned()),
            updated_at: NOW,
            deleted_at: None,
        },
        NOW,
    )
    .expect("the day's record");
    let (first, snapshot) = empty_update_then_snapshot();
    update_log::append_server_update(data, DAY, 1, &first, NOW + 1).expect("the first update");
    snapshot
}

fn hits(data: &Connection, index: &Connection) -> Vec<String> {
    search::search(data, index, WORD, &search::SearchFilter::default(), 20)
        .map(|groups| [groups.notes, groups.journals].concat())
        .expect("search")
        .into_iter()
        .map(|hit| hit.id)
        .collect()
}

#[test]
fn a_snapshot_that_brings_the_text_replaces_the_body_cached_empty() {
    let (data, index) = databases();
    let snapshot = day_with_empty_first_update(&data);
    search::reindex(&data, &index, NOW + 2).expect("reindex before the snapshot");
    assert!(hits(&data, &index).is_empty(), "no text has arrived yet");

    update_log::put_server_snapshot(&data, DAY, &snapshot, 1, Some("rev-1"), NOW + 3)
        .expect("the snapshot");
    search::reindex(&data, &index, NOW + 4).expect("reindex after the snapshot");

    assert_eq!(hits(&data, &index), [DAY]);
}

/// An install whose index already holds the day empty: the body cached empty
/// under the old key, the snapshot's stamp below the watermark, and the index
/// stamped version 1. The next reindex finds the word without user action.
#[test]
fn an_index_built_with_the_stale_body_cache_heals_on_the_next_reindex() {
    let (data, index) = databases();
    let snapshot = day_with_empty_first_update(&data);
    update_log::put_server_snapshot(&data, DAY, &snapshot, 1, Some("rev-1"), NOW + 1)
        .expect("the snapshot");
    data.execute(
        "INSERT INTO note_bodies (note_id, text, text_sha256, source_seq, materialised_at)
         VALUES (?1, '', '', 1, ?2)",
        params![DAY, NOW + 2],
    )
    .expect("the body the old key cached");
    let version: i64 = data
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("the data version");
    index
        .execute(
            "INSERT INTO fts_notes (id, title, content, tags) VALUES (?1, '2026-09-21', '', '')",
            params![DAY],
        )
        .expect("the empty row");
    for (key, value) in [
        ("data.user_version", version.to_string()),
        (STAMPS_KEY, "1".to_owned()),
        (NOTES_WATERMARK_KEY, (NOW + 10).to_string()),
        (TASKS_WATERMARK_KEY, (NOW + 10).to_string()),
    ] {
        index
            .execute(
                "INSERT INTO index_meta (key, value) VALUES (?1, ?2)",
                params![key, value],
            )
            .expect("the old index meta");
    }
    assert!(hits(&data, &index).is_empty(), "the broken install");

    search::reindex(&data, &index, NOW + 20).expect("the next reindex");

    assert_eq!(hits(&data, &index), [DAY]);
}
