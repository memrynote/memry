//! Search and index maintenance against real SQLite and real FTS5 (T131,
//! FR-053, data-model §A.5).
//!
//! | Test                                              | Rule                          |
//! | ------------------------------------------------- | ----------------------------- |
//! | the title weight outranks the content weight      | the bm25 vector is a contract |
//! | hostile query text never reaches the FTS5 parser  | FTS5 input is user input      |
//! | the body column is `extract_text` output          | §A.3, chapter 12 §12.1        |
//! | a second pass touches only what moved             | §A.5 watermarks, FR-053       |
//! | a body update alone re-indexes the note           | the log is a watermark source |
//! | a tombstone leaves the index and the results      | §A.1                          |
//! | a dropped index rebuilds to the same answers      | §A.1, index.db is rebuildable |
//! | a corrupt row is counted, an unreadable one errs  | never a silent skip           |
//! | a journal hit carries its date                    | §A.5                          |
//! | tasks rank in their own corpus                    | §A.5                          |

mod support;

use memry_core::domain::search::{
    self, HitKind, NOTES_WATERMARK_KEY, Reindexed, STAMPS_KEY, SearchHit, TASKS_WATERMARK_KEY,
};
use memry_core::storage::migrations::{self, DATA_MIGRATIONS, INDEX_MIGRATIONS};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use rusqlite::{Connection, params};
use support::{hex_field, str_field, vector_file};

const NOW: i64 = 1_760_000_000_000;

fn databases() -> (Connection, Connection) {
    let mut data = Connection::open_in_memory().expect("data.db");
    migrations::run(&mut data, DATA_MIGRATIONS).expect("data migrations");
    let mut index = Connection::open_in_memory().expect("index.db");
    migrations::run(&mut index, INDEX_MIGRATIONS).expect("index migrations");
    (data, index)
}

fn record(item_type: &str, id: &str, payload: &str, at: i64) -> InboundRecord {
    InboundRecord {
        item_type: item_type.to_owned(),
        item_id: id.to_owned(),
        payload_json: payload.to_owned(),
        server_cursor: Some(1),
        signer_device_id: Some("device-a".to_owned()),
        updated_at: at,
        deleted_at: None,
    }
}

fn put(data: &Connection, item_type: &str, id: &str, payload: &str, at: i64) {
    sync_items::apply_remote(data, &record(item_type, id, payload, at), at).expect("apply");
}

fn tombstone(data: &Connection, item_type: &str, id: &str, at: i64) {
    let mut gone = record(item_type, id, "{}", at);
    gone.deleted_at = Some(at);
    sync_items::apply_remote(data, &gone, at).expect("apply the tombstone");
}

fn ids(hits: &[SearchHit]) -> Vec<&str> {
    hits.iter().map(|hit| hit.id.as_str()).collect()
}

fn notes(data: &Connection, index: &Connection, query: &str) -> Vec<SearchHit> {
    search::search_notes(data, index, query, 20).expect("search notes")
}

fn reindex(data: &Connection, index: &Connection, at: i64) -> Reindexed {
    search::reindex(data, index, at).expect("reindex")
}

fn watermark(index: &Connection, key: &str) -> Option<i64> {
    index
        .query_row(
            "SELECT value FROM index_meta WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|value| value.parse().ok())
}

/// The first case in the committed `text-extract` class whose text carries the
/// word this suite searches for, with its update blob.
fn body_vector() -> (Vec<u8>, String) {
    let vectors = vector_file("text-extract");
    let cases = vectors["cases"].as_array().expect("cases");
    let case = cases
        .iter()
        .find(|case| !str_field(case, "expectedText").is_empty())
        .expect("a case with text");
    (
        hex_field(case, "updateHex"),
        str_field(case, "expectedText").to_owned(),
    )
}

#[test]
fn the_title_weight_outranks_the_content_weight() {
    let (data, index) = databases();
    let (update, text) = body_vector();
    // The first word of the extracted text, used as a query that matches one
    // note by title and the other by body only.
    let word: String = text
        .split(|c: char| !c.is_alphanumeric())
        .find(|part| part.len() > 2)
        .expect("a word in the extracted text")
        .to_owned();

    put(
        &data,
        "note",
        "in-title",
        &format!(r#"{{"title":"{word}"}}"#),
        NOW,
    );
    put(
        &data,
        "note",
        "in-body",
        r#"{"title":"Something else"}"#,
        NOW,
    );
    memry_core::crdt::update_log::append_server_update(&data, "in-body", 1, &update, NOW)
        .expect("append the body");

    reindex(&data, &index, NOW);

    let hits = notes(&data, &index, &word);
    assert_eq!(
        ids(&hits),
        vec!["in-title", "in-body"],
        "title weight 2.0 must outrank content weight 1.0"
    );
    assert!(hits[0].score < 0.0, "bm25 scores are negative");
    assert!(hits[0].score < hits[1].score, "better matches score lower");
}

#[test]
fn hostile_query_text_never_reaches_the_fts5_parser() {
    let (data, index) = databases();
    put(&data, "note", "n1", r#"{"title":"Chapter twelve"}"#, NOW);
    reindex(&data, &index, NOW);

    for hostile in [
        "he said \"hello",
        "*",
        "chapter*",
        "title:chapter",
        "-chapter",
        "(chapter OR twelve)",
        "^chapter",
        "NEAR(chapter twelve, 2)",
        "chapter AND NOT twelve",
        "\"\"\"",
        "",
        "   ",
        "🙂",
    ] {
        let found = search::search_notes(&data, &index, hostile, 20);
        assert!(
            found.is_ok(),
            "{hostile:?} reached the parser: {:?}",
            found.err()
        );
    }

    // The words survive the rewrite; only the syntax is gone.
    assert_eq!(ids(&notes(&data, &index, "(chapter twelve)")), vec!["n1"]);
    assert_eq!(ids(&notes(&data, &index, "chapter:")), vec!["n1"]);
    assert!(notes(&data, &index, "*").is_empty());
    assert!(
        notes(&data, &index, "chapter zebra").is_empty(),
        "terms AND"
    );
    assert!(
        notes(&data, &index, "chapter OR zebra").is_empty(),
        "`OR` is searched for as the word `or`, not honoured as an operator, \
         so this is three ANDed terms and matches nothing"
    );
}

#[test]
fn the_body_column_is_extract_text_output() {
    let (data, index) = databases();
    let (update, expected) = body_vector();
    put(&data, "note", "body", r#"{"title":"A note"}"#, NOW);
    memry_core::crdt::update_log::append_server_update(&data, "body", 1, &update, NOW)
        .expect("append");

    reindex(&data, &index, NOW);

    let indexed: String = index
        .query_row(
            "SELECT content FROM fts_notes WHERE id = 'body'",
            [],
            |row| row.get(0),
        )
        .expect("the indexed body");
    assert_eq!(
        indexed.as_bytes(),
        expected.as_bytes(),
        "the FTS content column is extract_text output, byte for byte"
    );

    // And it was materialised into note_bodies on the way past (§A.3).
    let (stored, source_seq): (String, Option<i64>) = data
        .query_row(
            "SELECT text, source_seq FROM note_bodies WHERE note_id = 'body'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the materialised body");
    assert_eq!(stored, expected);
    assert_eq!(source_seq, Some(1));
}

#[test]
fn a_second_pass_touches_only_what_moved() {
    let (data, index) = databases();
    put(&data, "note", "old", r#"{"title":"Alpha"}"#, NOW);
    put(&data, "note", "edge", r#"{"title":"Beta"}"#, NOW + 1_000);
    put(
        &data,
        "task",
        "t1",
        r#"{"title":"Gamma","projectId":"p"}"#,
        NOW,
    );

    let first = reindex(&data, &index, NOW + 1_000);
    assert!(first.full, "an index with no watermark is a full rebuild");
    assert_eq!((first.notes_indexed, first.tasks_indexed), (2, 1));
    assert_eq!(watermark(&index, NOTES_WATERMARK_KEY), Some(NOW + 1_000));
    // The two watermarks are independent: the only task moved at NOW.
    assert_eq!(watermark(&index, TASKS_WATERMARK_KEY), Some(NOW));

    let later = NOW + 2_000;
    put(&data, "note", "moved", r#"{"title":"Delta"}"#, later);
    let second = reindex(&data, &index, later);

    assert!(!second.full, "the watermark was intact");
    // `old` sits below the watermark and is not read at all. `edge` sits
    // exactly on it and is re-indexed, which is what the `>=` comparison buys:
    // a row written in the watermark's own millisecond is done twice rather
    // than missed once.
    assert_eq!(second.notes_indexed, 2, "`old` was skipped, `edge` re-done");
    // The one task also sits on its own watermark, for the same reason.
    assert_eq!(
        second.tasks_indexed, 1,
        "no task moved; the boundary row re-runs"
    );
    assert_eq!(watermark(&index, NOTES_WATERMARK_KEY), Some(later));

    assert_eq!(ids(&notes(&data, &index, "Delta")), vec!["moved"]);
    assert_eq!(
        ids(&notes(&data, &index, "Alpha")),
        vec!["old"],
        "old survived"
    );
    assert_eq!(ids(&notes(&data, &index, "Beta")), vec!["edge"]);
}

#[test]
fn an_index_built_before_apply_time_stamps_is_rebuilt_once() {
    // Pulled body updates used to carry the server's `createdAt`, below the
    // epoch-ms watermark: such an install holds rows no incremental pass
    // reads. An index without the stamps marker is rebuilt in full, once.
    let (data, index) = databases();
    put(&data, "note", "old", r#"{"title":"Alpha"}"#, NOW);
    assert!(reindex(&data, &index, NOW).full);
    index
        .execute("DELETE FROM index_meta WHERE key = ?1", params![STAMPS_KEY])
        .expect("an index from before the marker");

    let healed = reindex(&data, &index, NOW + 1_000);
    assert!(healed.full, "no stamps marker: one full rebuild");
    let next = reindex(&data, &index, NOW + 2_000);
    assert!(!next.full, "the marker is written, so it happens once");
}

#[test]
fn a_body_update_alone_re_indexes_the_note() {
    let (data, index) = databases();
    let (update, expected) = body_vector();
    put(&data, "note", "body", r#"{"title":"A note"}"#, NOW);
    let first = reindex(&data, &index, NOW);
    assert_eq!(first.notes_indexed, 1);

    let later = NOW + 1_000;
    memry_core::crdt::update_log::append_server_update(&data, "body", 1, &update, later)
        .expect("append");
    let second = reindex(&data, &index, later);

    assert_eq!(
        second.notes_indexed, 1,
        "the update log is a watermark source of its own; the record never moved"
    );
    let word = expected
        .split(|c: char| !c.is_alphanumeric())
        .find(|part| part.len() > 2)
        .expect("a word");
    assert_eq!(ids(&notes(&data, &index, word)), vec!["body"]);
}

#[test]
fn a_tombstone_leaves_the_index_and_the_results() {
    let (data, index) = databases();
    put(&data, "note", "n1", r#"{"title":"Ephemeral"}"#, NOW);
    reindex(&data, &index, NOW);
    assert_eq!(ids(&notes(&data, &index, "Ephemeral")), vec!["n1"]);

    let later = NOW + 1_000;
    tombstone(&data, "note", "n1", later);

    // Even before the index catches up, `data.db` is consulted per hit.
    assert!(
        notes(&data, &index, "Ephemeral").is_empty(),
        "a stale index must not resurrect a deleted note"
    );

    let pass = reindex(&data, &index, later);
    assert_eq!(pass.notes_removed, 1);
    let rows: i64 = index
        .query_row("SELECT COUNT(*) FROM fts_notes", [], |row| row.get(0))
        .expect("count");
    assert_eq!(rows, 0);
}

#[test]
fn a_dropped_index_rebuilds_to_the_same_answers() {
    let (data, index) = databases();
    let (update, _) = body_vector();
    put(&data, "note", "n1", r#"{"title":"Protocol chapter"}"#, NOW);
    put(
        &data,
        "journal",
        "j1",
        r#"{"date":"2026-04-16","title":"Protocol diary"}"#,
        NOW,
    );
    put(
        &data,
        "task",
        "t1",
        r#"{"title":"Protocol task","projectId":"p"}"#,
        NOW,
    );
    memry_core::crdt::update_log::append_server_update(&data, "n1", 1, &update, NOW)
        .expect("append");
    reindex(&data, &index, NOW);
    let before = notes(&data, &index, "Protocol");

    // §A.1: the whole file is a supported thing to throw away.
    let mut fresh = Connection::open_in_memory().expect("index.db");
    migrations::run(&mut fresh, INDEX_MIGRATIONS).expect("index migrations");
    let rebuilt = reindex(&data, &fresh, NOW + 1);

    assert!(rebuilt.full);
    assert_eq!((rebuilt.notes_indexed, rebuilt.tasks_indexed), (2, 1));
    assert_eq!(notes(&data, &fresh, "Protocol"), before);
    assert_eq!(
        ids(&search::search_tasks(&data, &fresh, "Protocol", 20).expect("tasks")),
        vec!["t1"]
    );
}

#[test]
fn a_corrupt_row_is_counted_and_an_unreadable_one_is_an_error() {
    let (data, index) = databases();
    // `apply_remote` records a payload it cannot read as corrupt rather than
    // refusing it, and projects nothing — so the row reaches the indexer only
    // through its body log, which is exactly how a body update for a corrupt
    // record arrives.
    put(&data, "note", "bad", r#"{"title":42}"#, NOW);
    let flagged: Option<String> = data
        .query_row(
            "SELECT corrupt_reason FROM sync_items WHERE item_id = 'bad'",
            [],
            |row| row.get(0),
        )
        .expect("the row exists");
    assert!(flagged.is_some(), "the apply path flagged it");

    memry_core::crdt::update_log::append_server_update(&data, "bad", 1, &body_vector().0, NOW)
        .expect("append");
    let pass = reindex(&data, &index, NOW);
    assert_eq!(pass.corrupt_skipped, 1, "already reported once, not twice");
    assert_eq!(pass.notes_indexed, 0);

    // A row that nothing flagged, whose payload will not read, stops the pass.
    // Reading it as an empty note would hide it from every search instead.
    let later = NOW + 1_000;
    data.execute(
        "UPDATE sync_items SET corrupt_reason = NULL WHERE item_id = 'bad'",
        [],
    )
    .expect("unflag the row");
    memry_core::crdt::update_log::append_server_update(&data, "bad", 2, &body_vector().0, later)
        .expect("append");

    let error = search::reindex(&data, &index, later)
        .expect_err("an unreadable row that nothing flagged is a hard error");
    assert!(
        error.to_string().contains("note/bad"),
        "the error names the row: {error}"
    );
}

#[test]
fn a_journal_hit_carries_its_date() {
    let (data, index) = databases();
    put(
        &data,
        "journal",
        "j1",
        r#"{"date":"2026-04-16","title":"Ferry day"}"#,
        NOW,
    );
    put(&data, "journal", "j2", r#"{"date":"2026-04-17"}"#, NOW);
    reindex(&data, &index, NOW);

    let hits = notes(&data, &index, "Ferry");
    assert_eq!(ids(&hits), vec!["j1"]);
    assert_eq!(
        hits[0].kind,
        HitKind::Journal {
            date: "2026-04-16".to_owned()
        }
    );

    // A journal with no title is findable by its date, which is the only name
    // it has: `journal_entries` projects no title column.
    let dated = notes(&data, &index, "2026 04 17");
    assert_eq!(ids(&dated), vec!["j2"]);
    assert_eq!(dated[0].title, "2026-04-17");
}

#[test]
fn tasks_rank_in_their_own_corpus() {
    let (data, index) = databases();
    put(
        &data,
        "task",
        "t1",
        r#"{"title":"Rewrite the ferry timetable","projectId":"p"}"#,
        NOW,
    );
    put(
        &data,
        "task",
        "t2",
        r#"{"title":"Unrelated","description":"mentions the ferry once","projectId":"p","tags":["travel"]}"#,
        NOW,
    );
    put(&data, "note", "n1", r#"{"title":"Ferry notes"}"#, NOW);
    reindex(&data, &index, NOW);

    let hits = search::search_tasks(&data, &index, "ferry", 20).expect("tasks");
    assert_eq!(ids(&hits), vec!["t1", "t2"], "title outranks description");
    assert!(hits.iter().all(|hit| hit.kind == HitKind::Task));
    assert_eq!(
        ids(&search::search_tasks(&data, &index, "travel", 20).expect("tags")),
        vec!["t2"],
        "the tags column is indexed"
    );

    // The note corpus is separate: a task never appears in a note search.
    assert_eq!(ids(&notes(&data, &index, "ferry")), vec!["n1"]);
}
