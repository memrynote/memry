//! Search filters (#4321): type, modified date and tag, through `reindex` and
//! the real FTS5 index, on connections that carry `tag_fold`.
//!
//! | Test                                                      | Rule                               |
//! | --------------------------------------------------------- | ---------------------------------- |
//! | a type filter searches only that group                    | `types`                            |
//! | a tag filter keeps items carrying any of the tags         | OR, by the tag fold, every type    |
//! | a tag no item carries keeps nothing                       | no fallback to unfiltered          |
//! | a date filter keeps items modified inside the range       | inclusive epoch-ms bounds          |
//! | a late edit in a non-UTC local day is that day's          | the range is the shell's local day |
//! | a body-only edit counts as a modification                 | newest body update stamp           |
//! | the filters combine                                       | type, date and tag together        |
//! | fuzzy and alias hits pass the filter too                  | not desktop's unfiltered fallback  |
//! | a filtered search still fills the limit                   | the ×5 over-fetch                  |

use memry_core::domain::search::{
    self, Groups, MatchKind, ModifiedRange, SearchFilter, SearchHit, SearchType,
};
use memry_core::storage::Db;
use memry_core::storage::migrations::{self, DATA_MIGRATIONS, INDEX_MIGRATIONS};
use memry_core::storage::repositories::instants;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use rusqlite::{Connection, params};

/// 2026-11-12T00:00:00+03:00, the start of a local day at UTC+3.
const DAY_START: i64 = 1_794_430_800_000;
const HOUR: i64 = 3_600_000;
const DAY_END: i64 = DAY_START + 24 * HOUR - 1;
const LAST_WEEK: i64 = DAY_START - 7 * 24 * HOUR;

fn databases() -> (Db, Db) {
    let data = Db::open_in_memory().expect("data.db");
    data.call_blocking(|conn| migrations::run(conn, DATA_MIGRATIONS).map(|_| ()))
        .expect("data migrations");
    let index = Db::open_in_memory().expect("index.db");
    index
        .call_blocking(|conn| migrations::run(conn, INDEX_MIGRATIONS).map(|_| ()))
        .expect("index migrations");
    (data, index)
}

fn put(data: &Connection, item_type: &str, id: &str, payload: &str) {
    let record = InboundRecord {
        item_type: item_type.to_owned(),
        item_id: id.to_owned(),
        payload_json: payload.to_owned(),
        server_cursor: Some(1),
        signer_device_id: Some("device-a".to_owned()),
        updated_at: LAST_WEEK,
        deleted_at: None,
    };
    sync_items::apply_remote(data, &record, LAST_WEEK).expect("apply");
}

fn note(data: &Connection, id: &str, title: &str, tags: &[&str], modified: i64) {
    let payload = serde_json::json!({ "title": title, "tags": tags, "modifiedAt": modified });
    put(data, "note", id, &payload.to_string());
}

fn task(data: &Connection, id: &str, title: &str, tags: &[&str], modified: i64) {
    // A task's `modifiedAt` is ISO text (`projectors/tasks.rs`).
    let modified = instants::to_iso8601(modified).expect("an instant");
    let payload = serde_json::json!({
        "title": title, "projectId": "p", "tags": tags, "modifiedAt": modified,
    });
    put(data, "task", id, &payload.to_string());
}

fn capture(data: &Connection, id: &str, title: &str, tags: &[&str], modified: i64) {
    let payload = serde_json::json!({ "title": title, "type": "note", "modifiedAt": modified });
    put(data, "inbox", id, &payload.to_string());
    for tag in tags {
        data.execute(
            "INSERT INTO inbox_item_tags (item_id, tag, created_at) VALUES (?1, ?2, 0)",
            params![id, tag],
        )
        .expect("tag the capture");
    }
}

fn search(data: &Db, index: &Db, query: &str, filter: &SearchFilter, limit: usize) -> Groups {
    data.call_blocking(|data| {
        index.call_blocking(|index| {
            search::reindex(data, index, DAY_START)?;
            search::search(data, index, query, filter, limit)
        })
    })
    .expect("search")
}

fn ids(hits: &[SearchHit]) -> Vec<&str> {
    hits.iter().map(|hit| hit.id.as_str()).collect()
}

fn tagged(tags: &[&str]) -> SearchFilter {
    SearchFilter {
        tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
        ..SearchFilter::default()
    }
}

fn today() -> Option<ModifiedRange> {
    Some(ModifiedRange {
        from_ms: DAY_START,
        to_ms: DAY_END,
    })
}

/// One note, task and capture each carrying `searchtest`, and one of each
/// carrying `other`, all titled with `zephyr`, all modified last week.
fn tagged_vault(data: &Db) {
    data.call_blocking(|data| {
        note(
            data,
            "n-search",
            "Zephyr password list",
            &["searchtest"],
            LAST_WEEK,
        );
        note(data, "n-other", "Zephyr grocery", &["other"], LAST_WEEK);
        task(
            data,
            "t-search",
            "Zephyr rotate credentials",
            &["searchtest"],
            LAST_WEEK,
        );
        task(
            data,
            "t-other",
            "Zephyr water plants",
            &["other"],
            LAST_WEEK,
        );
        capture(
            data,
            "c-search",
            "Zephyr article",
            &["searchtest"],
            LAST_WEEK,
        );
        capture(data, "c-other", "Zephyr podcast", &["other"], LAST_WEEK);
        Ok(())
    })
    .expect("seed");
}

#[test]
fn a_type_filter_searches_only_that_group() {
    let (data, index) = databases();
    tagged_vault(&data);
    let filter = SearchFilter {
        types: vec![SearchType::Task],
        ..SearchFilter::default()
    };

    let groups = search(&data, &index, "zephyr", &filter, 20);

    let mut tasks = ids(&groups.tasks);
    tasks.sort_unstable();
    assert_eq!(tasks, ["t-other", "t-search"]);
    assert!(groups.notes.is_empty() && groups.journals.is_empty() && groups.inbox.is_empty());
}

#[test]
fn a_tag_filter_keeps_items_carrying_any_of_the_tags() {
    let (data, index) = databases();
    tagged_vault(&data);
    data.call_blocking(|data| {
        note(data, "n-third", "Zephyr ledger", &["third"], LAST_WEEK);
        Ok(())
    })
    .expect("seed");

    let one = search(&data, &index, "zephyr", &tagged(&["SearchTest"]), 20);
    assert_eq!(ids(&one.notes), ["n-search"], "matched by the tag fold");
    assert_eq!(ids(&one.tasks), ["t-search"]);
    assert_eq!(ids(&one.inbox), ["c-search"]);

    let either = search(
        &data,
        &index,
        "zephyr",
        &tagged(&["searchtest", "third"]),
        20,
    );
    let mut notes = ids(&either.notes);
    notes.sort_unstable();
    assert_eq!(notes, ["n-search", "n-third"], "any of the tags");
}

#[test]
fn a_tag_no_item_carries_keeps_nothing() {
    let (data, index) = databases();
    tagged_vault(&data);

    let groups = search(&data, &index, "zephyr", &tagged(&["nowhere"]), 20);

    assert_eq!(groups, Groups::default());
}

#[test]
fn a_date_filter_keeps_items_modified_inside_the_range() {
    let (data, index) = databases();
    tagged_vault(&data);
    data.call_blocking(|data| {
        note(data, "n-today", "Zephyr today", &[], DAY_START + HOUR);
        task(data, "t-today", "Zephyr today", &[], DAY_END);
        capture(data, "c-today", "Zephyr today", &[], DAY_START);
        note(data, "n-tomorrow", "Zephyr tomorrow", &[], DAY_END + 1);
        Ok(())
    })
    .expect("seed");
    let filter = SearchFilter {
        modified: today(),
        ..SearchFilter::default()
    };

    let groups = search(&data, &index, "zephyr", &filter, 20);

    assert_eq!(ids(&groups.notes), ["n-today"]);
    assert_eq!(ids(&groups.tasks), ["t-today"], "the end is inclusive");
    assert_eq!(ids(&groups.inbox), ["c-today"], "the start is inclusive");
}

#[test]
fn a_late_edit_in_a_non_utc_local_day_is_that_days() {
    // 23:30 at UTC+3 is 20:30Z, the same UTC date; 00:30 the next local day
    // is 21:30Z, still the same UTC date, and must not count as today.
    let (data, index) = databases();
    data.call_blocking(|data| {
        note(data, "late", "Zephyr late", &[], DAY_END - 30 * 60_000);
        note(data, "next", "Zephyr next", &[], DAY_END + 30 * 60_000);
        Ok(())
    })
    .expect("seed");
    let filter = SearchFilter {
        modified: today(),
        ..SearchFilter::default()
    };

    let groups = search(&data, &index, "zephyr", &filter, 20);

    assert_eq!(ids(&groups.notes), ["late"]);
}

#[test]
fn a_body_only_edit_counts_as_a_modification() {
    // Desktop pushes a body edit as a CRDT update with no record, so the
    // record's `modifiedAt` stays at last week.
    let (data, index) = databases();
    data.call_blocking(|data| {
        note(data, "edited", "Zephyr edited", &[], LAST_WEEK);
        note(data, "untouched", "Zephyr untouched", &[], LAST_WEEK);
        put(
            data,
            "journal",
            "j-edited",
            r#"{"date":"2026-11-01","title":"Zephyr day","modifiedAt":1793000000000}"#,
        );
        for doc in ["edited", "j-edited"] {
            memry_core::crdt::update_log::append_server_update(
                data,
                doc,
                1,
                &yrs_empty_update(),
                DAY_START + 22 * HOUR,
            )
            .map_err(|error| memry_core::api::errors::StorageError::Failed {
                what: error.to_string(),
            })?;
        }
        Ok(())
    })
    .expect("seed");
    let filter = SearchFilter {
        modified: today(),
        ..SearchFilter::default()
    };

    let groups = search(&data, &index, "zephyr", &filter, 20);

    assert_eq!(ids(&groups.notes), ["edited"]);
    assert_eq!(ids(&groups.journals), ["j-edited"]);
}

/// A valid update that changes nothing in the document.
fn yrs_empty_update() -> Vec<u8> {
    vec![0, 0]
}

#[test]
fn the_filters_combine() {
    let (data, index) = databases();
    tagged_vault(&data);
    data.call_blocking(|data| {
        task(
            data,
            "t-search-today",
            "Zephyr today",
            &["searchtest"],
            DAY_START + HOUR,
        );
        note(
            data,
            "n-search-today",
            "Zephyr today",
            &["searchtest"],
            DAY_START + HOUR,
        );
        task(
            data,
            "t-other-today",
            "Zephyr today too",
            &["other"],
            DAY_START + HOUR,
        );
        Ok(())
    })
    .expect("seed");
    let filter = SearchFilter {
        types: vec![SearchType::Task],
        modified: today(),
        tags: vec!["searchtest".to_owned()],
    };

    let groups = search(&data, &index, "zephyr", &filter, 20);

    assert_eq!(ids(&groups.tasks), ["t-search-today"]);
    assert!(groups.notes.is_empty());
}

#[test]
fn fuzzy_and_alias_hits_pass_the_filter_too() {
    let (data, index) = databases();
    data.call_blocking(|data| {
        note(data, "pw", "Password list", &["searchtest"], LAST_WEEK);
        note(data, "pw-other", "Password ideas", &["other"], LAST_WEEK);
        put(
            data,
            "note",
            "creds",
            r#"{"title":"Bank logins","aliases":["Creds"],"tags":["other"]}"#,
        );
        Ok(())
    })
    .expect("seed");

    let fuzzy = search(&data, &index, "pasword", &tagged(&["searchtest"]), 20);
    assert_eq!(ids(&fuzzy.notes), ["pw"]);
    assert_eq!(fuzzy.notes[0].match_kind, MatchKind::Fuzzy);

    let unfiltered_alias = search(&data, &index, "creds", &SearchFilter::default(), 20);
    assert_eq!(ids(&unfiltered_alias.notes), ["creds"]);
    let alias = search(&data, &index, "creds", &tagged(&["searchtest"]), 20);
    assert!(
        alias.notes.is_empty(),
        "the alias hit carries no searchtest tag"
    );
}

#[test]
fn a_filtered_search_still_fills_the_limit() {
    // Ten untagged notes outrank three tagged ones. Fetching only the limit
    // would find none of the tagged ones in the index and leave the group to
    // the fuzzy fallback, without snippets.
    let (data, index) = databases();
    data.call_blocking(|data| {
        for at in 0..10 {
            note(data, &format!("plain-{at}"), "Zephyr", &[], LAST_WEEK);
        }
        for at in 0..3 {
            let title = "Zephyr with a much longer title than the rest";
            note(
                data,
                &format!("tagged-{at}"),
                title,
                &["searchtest"],
                LAST_WEEK,
            );
        }
        Ok(())
    })
    .expect("seed");

    let groups = search(&data, &index, "zephyr", &tagged(&["searchtest"]), 3);

    let mut found = ids(&groups.notes);
    found.sort_unstable();
    assert_eq!(found, ["tagged-0", "tagged-1", "tagged-2"]);
    assert!(
        groups
            .notes
            .iter()
            .all(|hit| hit.match_kind == MatchKind::Body),
        "found in the index, not by the fallback"
    );
}
