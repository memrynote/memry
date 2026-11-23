//! A reindex pass in batches keeps the previous index visible until it replaces it (#5417,
//! REVIEW-5425).
//!
//! | Test                                                    | Rule                            |
//! | ------------------------------------------------------- | ------------------------------- |
//! | a failing full pass keeps the previous index            | no up-front delete, error kept  |
//! | a resume point from another stamps or index version     | the resume point names versions |
//! | tasks stay searchable during a full pass                | tasks replaced, never emptied   |
//! | a pass overlapped by another never doubles a row        | every batch commit is counted   |

use memry_core::domain::search::{self, NOTES_WATERMARK_KEY, STAMPS_KEY};
use memry_core::storage::migrations::{self, DATA_MIGRATIONS, INDEX_MIGRATIONS};
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

fn put(data: &Connection, item_type: &str, id: &str, payload: &str, at: i64) {
    let record = InboundRecord {
        item_type: item_type.to_owned(),
        item_id: id.to_owned(),
        payload_json: payload.to_owned(),
        server_cursor: Some(1),
        signer_device_id: Some("device-a".to_owned()),
        updated_at: at,
        deleted_at: None,
    };
    sync_items::apply_remote(data, &record, at).expect("apply");
}

fn count(index: &Connection, table: &str) -> usize {
    index
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get::<_, i64>(0)
        })
        .expect("count") as usize
}

fn meta(index: &Connection, key: &str) -> Option<String> {
    index
        .query_row(
            "SELECT value FROM index_meta WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .ok()
}

/// `total` notes and one task, fully indexed.
fn indexed_vault(total: usize) -> (Connection, Connection) {
    let (data, index) = databases();
    for n in 0..total {
        put(
            &data,
            "note",
            &format!("n{n:04}"),
            r#"{"title":"Alpha"}"#,
            NOW,
        );
    }
    put(
        &data,
        "task",
        "t1",
        r#"{"title":"Ferry timetable","projectId":"p"}"#,
        NOW,
    );
    search::reindex(&data, &index, NOW).expect("first pass");
    assert_eq!(count(&index, "fts_notes"), total);
    assert_eq!(count(&index, "fts_tasks"), 1);
    (data, index)
}

/// What a newer build does to this index: its stamps rule changed, so the next pass is full.
fn bump_stamps(index: &Connection) {
    index
        .execute(
            "UPDATE index_meta SET value = '0' WHERE key = ?1",
            params![STAMPS_KEY],
        )
        .expect("bump the stamps version");
}

#[test]
fn r5425_a_failing_full_pass_keeps_the_previous_index() {
    let total = search::BATCH_NOTES + 100;
    let (data, index) = indexed_vault(total);
    bump_stamps(&index);
    let watermark = meta(&index, NOTES_WATERMARK_KEY);
    // A row nothing flagged whose payload will not read: index_note fails on it.
    data.execute(
        "UPDATE sync_items SET payload = '{\"title\":42}' WHERE item_id = 'n0250'",
        [],
    )
    .expect("break one note");

    let error = search::reindex(&data, &index, NOW + 1).expect_err("the broken note fails");
    assert!(error.to_string().contains("note/n0250"), "{error}");
    assert_eq!(count(&index, "fts_notes"), total, "every note keeps a row");
    let kept: i64 = index
        .query_row(
            "SELECT count(*) FROM fts_notes WHERE id = 'n0250'",
            [],
            |row| row.get(0),
        )
        .expect("count");
    assert_eq!(kept, 1, "the failing note keeps its old row");
    assert_eq!(count(&index, "fts_tasks"), 1, "tasks are still searchable");
    assert_eq!(meta(&index, NOTES_WATERMARK_KEY), watermark, "unmoved");
    assert_eq!(meta(&index, STAMPS_KEY).as_deref(), Some("0"), "still owed");
    assert_eq!(meta(&index, search::RESUME_KEY), None);
}

#[test]
fn r5425_b_a_resume_point_from_another_stamps_or_index_version_is_ignored() {
    for change in ["drop the versions", "another index version"] {
        let (data, index) = databases();
        let total = search::BATCH_NOTES + 50;
        for n in 0..total {
            put(
                &data,
                "note",
                &format!("n{n:04}"),
                r#"{"title":"Alpha"}"#,
                NOW,
            );
        }
        let stop = || meta(&index, search::RESUME_KEY).is_some();
        assert_eq!(
            search::reindex_until(&data, &index, NOW, &stop).expect("reindex"),
            None
        );
        let raw = meta(&index, search::RESUME_KEY).expect("a resume point");
        let mut resume: serde_json::Value = serde_json::from_str(&raw).expect("json");
        let object = resume.as_object_mut().expect("an object");
        match change {
            "drop the versions" => {
                object.remove("stamps");
                object.remove("index_version");
            }
            _ => {
                object.insert("index_version".to_owned(), serde_json::json!(9_999));
            }
        }
        index
            .execute(
                "UPDATE index_meta SET value = ?2 WHERE key = ?1",
                params![search::RESUME_KEY, resume.to_string()],
            )
            .expect("rewrite the resume point");
        // What a newer build's index migration does: it drops the rows the resume point names.
        index
            .execute_batch("DELETE FROM fts_notes")
            .expect("drop rows");

        search::reindex(&data, &index, NOW).expect("reindex");
        assert_eq!(count(&index, "fts_notes"), total, "{change}: a fresh plan");
    }
}

#[test]
fn r5425_c_tasks_stay_searchable_during_a_full_pass() {
    let total = search::BATCH_NOTES + 50;
    let (data, index) = indexed_vault(total);
    bump_stamps(&index);
    let stop = || meta(&index, search::RESUME_KEY).is_some();
    assert_eq!(
        search::reindex_until(&data, &index, NOW + 1, &stop).expect("reindex"),
        None
    );
    assert!(
        meta(&index, search::RESUME_KEY).is_some(),
        "a batch committed"
    );
    assert_eq!(count(&index, "fts_tasks"), 1, "tasks during the pass");
    assert_eq!(count(&index, "fts_notes"), total, "old rows until replaced");

    search::reindex(&data, &index, NOW + 2).expect("finish");
    assert_eq!(count(&index, "fts_tasks"), 1);
    assert_eq!(count(&index, "fts_notes"), total, "every note once");
}

/// A pass that planned before another pass committed goes stale even when the other left the
/// resume point and the notes watermark as they were: its planned rowids are gone.
#[test]
fn r5425_d_a_pass_overlapped_by_another_never_doubles_a_row() {
    let (data, index) = indexed_vault(3);
    put(
        &data,
        "task",
        "t1",
        r#"{"title":"Ferry timetable v2","projectId":"p"}"#,
        NOW + 1,
    );
    let mut first = search::ReindexPass::plan(&data, &index).expect("plan");
    search::reindex(&data, &index, NOW + 2).expect("the other pass");
    loop {
        match first.batch(&data, &index, NOW + 3, &|| false) {
            Ok(search::ReindexStep::More) => continue,
            Ok(_) => break,
            Err(error) => panic!("batch: {error:?}"),
        }
    }
    assert_eq!(count(&index, "fts_notes"), 3, "every note once");
    assert_eq!(count(&index, "fts_tasks"), 1, "every task once");
}
