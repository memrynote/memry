//! Inbox captures in search (#4320), through real SQLite and real FTS5.
//!
//! | Test                                                   | Rule                              |
//! | ------------------------------------------------------ | --------------------------------- |
//! | a capture is found by title, content and transcription | desktop's `fts_inbox` columns     |
//! | the title outranks the content                         | `bm25(fts_inbox, 0, 3, 1, 1, 0.5)` |
//! | archived, filed and snoozed captures are still found   | every state is indexed            |
//! | a tombstone stops matching                             | the live-row check, the index row |
//! | a second pass picks up only the new capture            | `fts_inbox`'s own watermark       |
//! | a missing inbox watermark forces the first fill        | same                              |
//! | an index.db from before fts_inbox is rebuilt and filled | §A.0, migration 0003             |
//! | a typo finds the title                                 | the fuzzy fallback (#4319)        |
//! | an opened capture is a recent until it is deleted      | recents liveness (#4322)          |

use memry_core::domain::search::{
    self, HitKind, INBOX_WATERMARK_KEY, MatchKind, NOTES_WATERMARK_KEY, Reindexed, SearchHit,
    recents,
};
use memry_core::storage::migrations::{self, DATA_MIGRATIONS, INDEX_MIGRATIONS};
use memry_core::storage::open_index;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use rusqlite::{Connection, params};

const NOW: i64 = 1_760_000_000_000;

fn databases() -> (Connection, Connection) {
    let mut data = Connection::open_in_memory().expect("data.db");
    migrations::run(&mut data, DATA_MIGRATIONS).expect("data migrations");
    let mut index = Connection::open_in_memory().expect("index.db");
    migrations::run(&mut index, INDEX_MIGRATIONS).expect("index migrations");
    (data, index)
}

fn apply(data: &Connection, id: &str, payload: &str, deleted_at: Option<i64>, at: i64) {
    let record = InboundRecord {
        item_type: "inbox".to_owned(),
        item_id: id.to_owned(),
        payload_json: payload.to_owned(),
        server_cursor: Some(1),
        signer_device_id: Some("device-a".to_owned()),
        updated_at: at,
        deleted_at,
    };
    sync_items::apply_remote(data, &record, at).expect("apply");
}

fn capture(data: &Connection, id: &str, payload: &str, at: i64) {
    apply(data, id, payload, None, at);
}

fn reindex(data: &Connection, index: &Connection, at: i64) -> Reindexed {
    search::reindex(data, index, at).expect("reindex")
}

fn inbox(data: &Connection, index: &Connection, query: &str) -> Vec<SearchHit> {
    search::search(data, index, query, &search::SearchFilter::default(), 20)
        .map(|groups| groups.inbox)
        .expect("search inbox")
}

fn ids(hits: &[SearchHit]) -> Vec<&str> {
    hits.iter().map(|hit| hit.id.as_str()).collect()
}

fn highlighted(hit: &SearchHit) -> Vec<&str> {
    hit.snippet
        .iter()
        .filter(|segment| segment.highlighted)
        .map(|segment| segment.text.as_str())
        .collect()
}

fn fts_rows(index: &Connection) -> i64 {
    index
        .query_row("SELECT COUNT(*) FROM fts_inbox", [], |row| row.get(0))
        .expect("count")
}

#[test]
fn a_capture_is_found_by_title_content_and_transcription() {
    let (data, index) = databases();
    capture(
        &data,
        "text",
        r#"{"title":"Article about managers","content":"A good read. zephyrcontent","type":"note"}"#,
        NOW,
    );
    capture(
        &data,
        "voice",
        r#"{"title":"Voice memo","type":"voice","transcription":"remember the zephyrspoken idea"}"#,
        NOW,
    );
    capture(
        &data,
        "link",
        r#"{"title":"Saved link","type":"link","sourceTitle":"Zephyrsource weekly"}"#,
        NOW,
    );

    let done = reindex(&data, &index, NOW);
    assert_eq!(done.inbox_indexed, 3);

    let by_title = inbox(&data, &index, "managers");
    assert_eq!(ids(&by_title), ["text"]);
    assert_eq!(by_title[0].kind, HitKind::Inbox);
    assert_eq!(by_title[0].title, "Article about managers");

    let by_content = inbox(&data, &index, "zephyrcontent");
    assert_eq!(ids(&by_content), ["text"]);
    assert_eq!(highlighted(&by_content[0]), ["zephyrcontent"]);

    assert_eq!(ids(&inbox(&data, &index, "zephyrspoken")), ["voice"]);
    assert_eq!(ids(&inbox(&data, &index, "zephyrsource")), ["link"]);
}

#[test]
fn the_title_outranks_the_content() {
    let (data, index) = databases();
    capture(
        &data,
        "in-content",
        r#"{"title":"Something else","content":"lantern"}"#,
        NOW,
    );
    capture(&data, "in-title", r#"{"title":"Lantern"}"#, NOW);
    reindex(&data, &index, NOW);

    assert_eq!(
        ids(&inbox(&data, &index, "lantern")),
        ["in-title", "in-content"]
    );
}

#[test]
fn archived_filed_and_snoozed_captures_are_still_found() {
    let (data, index) = databases();
    capture(
        &data,
        "archived",
        r#"{"title":"Old quokka","archivedAt":"2026-01-02T00:00:00.000Z"}"#,
        NOW,
    );
    capture(
        &data,
        "filed",
        r#"{"title":"Filed quokka","filedAt":"2026-01-02T00:00:00.000Z","filedTo":"n1","filedAction":"note"}"#,
        NOW,
    );
    capture(
        &data,
        "snoozed",
        r#"{"title":"Later quokka","snoozedUntil":"2099-01-02T00:00:00.000Z"}"#,
        NOW,
    );
    reindex(&data, &index, NOW);

    let mut found = ids(&inbox(&data, &index, "quokka"))
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    found.sort();
    assert_eq!(found, ["archived", "filed", "snoozed"]);
}

#[test]
fn a_tombstone_stops_matching() {
    let (data, index) = databases();
    capture(&data, "gone", r#"{"title":"Wombat note"}"#, NOW);
    reindex(&data, &index, NOW);
    assert_eq!(ids(&inbox(&data, &index, "wombat")), ["gone"]);

    apply(&data, "gone", "{}", Some(NOW + 1_000), NOW + 1_000);
    assert!(
        inbox(&data, &index, "wombat").is_empty(),
        "the live check hides it before the next reindex"
    );

    let done = reindex(&data, &index, NOW + 2_000);
    assert_eq!(done.inbox_removed, 1);
    assert_eq!(fts_rows(&index), 0, "the reindex drops its row");
}

#[test]
fn a_second_pass_picks_up_only_the_new_capture() {
    let (data, index) = databases();
    capture(&data, "first", r#"{"title":"Heron one"}"#, NOW);
    capture(&data, "latest", r#"{"title":"Heron two"}"#, NOW + 1_000);
    reindex(&data, &index, NOW + 1_000);

    capture(&data, "new", r#"{"title":"Heron three"}"#, NOW + 5_000);
    let done = reindex(&data, &index, NOW + 5_000);

    assert!(!done.full);
    // The watermark compares `>=`, so the capture stamped at it is read again;
    // the older one is not.
    assert_eq!(
        done.inbox_indexed, 2,
        "the new capture and the one at the watermark"
    );
    let mut found = ids(&inbox(&data, &index, "heron"))
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    found.sort();
    assert_eq!(found, ["first", "latest", "new"]);
}

#[test]
fn a_missing_inbox_watermark_forces_the_first_fill() {
    let (data, index) = databases();
    capture(&data, "c1", r#"{"title":"Pelican"}"#, NOW);
    reindex(&data, &index, NOW);
    // An index filled before its inbox watermark existed: the notes and tasks
    // watermarks are set, the inbox ones are not, and fts_inbox is empty.
    index
        .execute_batch("DELETE FROM fts_inbox;")
        .expect("empty fts_inbox");
    index
        .execute(
            "DELETE FROM index_meta WHERE key = ?1",
            params![INBOX_WATERMARK_KEY],
        )
        .expect("drop the watermark");

    let done = reindex(&data, &index, NOW + 60_000);

    assert!(!done.full, "notes and tasks stay incremental");
    assert_eq!(done.inbox_indexed, 1);
    assert_eq!(ids(&inbox(&data, &index, "pelican")), ["c1"]);
}

#[test]
fn an_index_db_from_before_fts_inbox_is_rebuilt_and_filled() {
    let dir = std::env::temp_dir().join(format!("memry-inbox-index-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("scratch dir");
    let path = dir.join("index.db");
    {
        let mut old = Connection::open(&path).expect("old index.db");
        migrations::run(&mut old, &INDEX_MIGRATIONS[..2]).expect("version 2");
        old.execute(
            "INSERT INTO index_meta (key, value) VALUES (?1, '1')",
            params![NOTES_WATERMARK_KEY],
        )
        .expect("an old watermark");
    }

    let opened = open_index(&path).expect("open");
    assert!(
        opened.rebuild_reason.is_some(),
        "a version 2 file is rebuilt"
    );

    let mut data = Connection::open_in_memory().expect("data.db");
    migrations::run(&mut data, DATA_MIGRATIONS).expect("data migrations");
    capture(&data, "c1", r#"{"title":"Osprey"}"#, NOW);

    let (done, hits) = opened
        .db
        .call_blocking(move |index| {
            let done = reindex(&data, index, NOW);
            Ok((done, inbox(&data, index, "osprey")))
        })
        .expect("reindex the rebuilt file");
    assert!(done.full);
    assert_eq!(ids(&hits), ["c1"]);
    drop(opened);
    std::fs::remove_dir_all(&dir).expect("remove scratch dir");
}

#[test]
fn a_typo_finds_the_title() {
    let (data, index) = databases();
    capture(&data, "c1", r#"{"title":"Password managers"}"#, NOW);
    reindex(&data, &index, NOW);

    let hits = inbox(&data, &index, "pasword");
    assert_eq!(ids(&hits), ["c1"]);
    assert_eq!(hits[0].match_kind, MatchKind::Fuzzy);
    assert!(hits[0].snippet.is_empty());
}

#[test]
fn an_opened_capture_is_a_recent_until_it_is_deleted() {
    let (data, index) = databases();
    capture(&data, "c1", r#"{"title":"Kestrel"}"#, NOW);
    reindex(&data, &index, NOW);
    let hit = inbox(&data, &index, "kestrel").remove(0);

    recents::record(&data, &hit, "kestrel", NOW).expect("record");
    let listed = recents::list(&data).expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].hit.kind, HitKind::Inbox);
    assert_eq!(listed[0].hit.id, "c1");

    apply(&data, "c1", "{}", Some(NOW + 1_000), NOW + 1_000);
    assert!(recents::list(&data).expect("list").is_empty());
}
