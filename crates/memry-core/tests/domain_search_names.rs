//! Fuzzy title fallback and alias matches (#4319), through `reindex` and the
//! real FTS5 index. The scorer's parity with desktop's fuzzysort is pinned in
//! `domain/search/fuzzy.rs`.

use memry_core::api::search::SearchResult;
use memry_core::domain::search::{self, MatchKind, SearchHit};
use memry_core::storage::migrations::{self, DATA_MIGRATIONS, INDEX_MIGRATIONS};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use rusqlite::Connection;

const NOW: i64 = 1_760_000_000_000;

fn databases() -> (Connection, Connection) {
    let mut data = Connection::open_in_memory().expect("data.db");
    migrations::run(&mut data, DATA_MIGRATIONS).expect("data migrations");
    let mut index = Connection::open_in_memory().expect("index.db");
    migrations::run(&mut index, INDEX_MIGRATIONS).expect("index migrations");
    (data, index)
}

fn put(data: &Connection, item_type: &str, id: &str, payload: &str) {
    let record = InboundRecord {
        item_type: item_type.to_owned(),
        item_id: id.to_owned(),
        payload_json: payload.to_owned(),
        server_cursor: Some(1),
        signer_device_id: Some("device-a".to_owned()),
        updated_at: NOW,
        deleted_at: None,
    };
    sync_items::apply_remote(data, &record, NOW).expect("apply");
}

fn note(data: &Connection, id: &str, title: &str) {
    put(data, "note", id, &format!(r#"{{"title":"{title}"}}"#));
}

fn notes(data: &Connection, index: &Connection, query: &str) -> Vec<SearchHit> {
    search::reindex(data, index, NOW).expect("reindex");
    search::search(data, index, query, &search::SearchFilter::default(), 20)
        .map(|groups| [groups.notes, groups.journals].concat())
        .expect("search")
}

fn listed(hits: &[SearchHit]) -> Vec<(&str, MatchKind, Option<&str>)> {
    hits.iter()
        .map(|hit| (hit.id.as_str(), hit.match_kind, hit.matched_name.as_deref()))
        .collect()
}

#[test]
fn a_dropped_letter_finds_the_note_by_its_title() {
    let (data, index) = databases();
    note(&data, "n1", "Password list");
    note(&data, "n2", "Grocery");

    let hits = notes(&data, &index, "pasword");

    assert_eq!(listed(&hits), [("n1", MatchKind::Fuzzy, None)]);
    assert!(hits[0].snippet.is_empty(), "a fuzzy hit has no snippet");
    let result = SearchResult::from(hits[0].clone());
    assert_eq!(
        (result.title.as_str(), result.match_kind),
        ("Password list", MatchKind::Fuzzy)
    );
}

#[test]
fn swapped_letters_find_nothing() {
    let (data, index) = databases();
    note(&data, "n1", "Password list");

    assert_eq!(notes(&data, &index, "passwrod"), []);
}

#[test]
fn a_fuzzy_match_never_repeats_a_body_hit() {
    let (data, index) = databases();
    note(&data, "n1", "Pasword list");
    note(&data, "n2", "Paswords");

    let hits = notes(&data, &index, "pasword");

    assert_eq!(
        listed(&hits),
        [("n2", MatchKind::Body, None), ("n1", MatchKind::Body, None)]
    );
}

#[test]
fn each_type_falls_back_on_its_own_count() {
    let (data, index) = databases();
    for id in ["n1", "n2", "n3"] {
        note(&data, id, &format!("pasword {id}"));
    }
    note(&data, "n4", "Password list");
    put(
        &data,
        "journal",
        "j1",
        r#"{"date":"2026-11-10","title":"Password day"}"#,
    );
    put(
        &data,
        "task",
        "t1",
        r#"{"title":"Password reset","projectId":"p"}"#,
    );

    let hits = notes(&data, &index, "pasword");
    let tasks = search::search(
        &data,
        &index,
        "pasword",
        &search::SearchFilter::default(),
        20,
    )
    .map(|groups| groups.tasks)
    .expect("tasks");

    let ids: Vec<&str> = hits.iter().map(|hit| hit.id.as_str()).collect();
    assert!(
        !ids.contains(&"n4"),
        "three note hits: no fuzzy notes, {ids:?}"
    );
    assert_eq!(
        hits.last().map(|hit| (hit.id.as_str(), hit.match_kind)),
        Some(("j1", MatchKind::Fuzzy))
    );
    assert_eq!(listed(&tasks), [("t1", MatchKind::Fuzzy, None)]);
}

#[test]
fn an_alias_finds_its_note_and_names_itself() {
    let (data, index) = databases();
    put(
        &data,
        "note",
        "exact",
        r#"{"title":"Password list","aliases":["Creds"]}"#,
    );
    put(
        &data,
        "note",
        "body",
        r#"{"title":"Rotation","tags":["creds"],"aliases":["Creds vault"]}"#,
    );
    put(
        &data,
        "note",
        "prefix",
        r#"{"title":"Vault","aliases":["Creds backup"]}"#,
    );
    put(
        &data,
        "note",
        "titled",
        r#"{"title":"Creds overview","aliases":["Creds old"]}"#,
    );

    let hits = notes(&data, &index, "creds");

    assert_eq!(
        listed(&hits),
        [
            ("exact", MatchKind::Alias, Some("Creds")),
            ("titled", MatchKind::Body, None),
            ("body", MatchKind::Body, Some("Creds vault")),
            ("prefix", MatchKind::Alias, Some("Creds backup")),
        ]
    );
}

#[test]
fn an_excluded_title_stays_out_of_the_fuzzy_and_alias_fallbacks() {
    let (data, index) = databases();
    note(&data, "agenda", "Meeting agenda");
    put(
        &data,
        "note",
        "personal",
        r#"{"title":"Meeting notes personal","aliases":["Meeting not personal"]}"#,
    );

    assert_eq!(
        listed(&notes(&data, &index, "meeting NOT personal")),
        [("agenda", MatchKind::Body, None)]
    );
    assert_eq!(
        listed(&notes(&data, &index, "\"meeting agenda\"")),
        [("agenda", MatchKind::Body, None)],
        "a quoted phrase asks for those words, not titles that look like them"
    );
}
