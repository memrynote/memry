//! The search box grammar against real FTS5 (#4318): prefix words, phrases,
//! uppercase operators, and phrase-first order.
//!
//! | Test                                            | Rule                               |
//! | ----------------------------------------------- | ---------------------------------- |
//! | no typed text raises an FTS5 error              | user text is not an FTS5 query     |
//! | a partial word finds the whole word             | plain words are prefixes           |
//! | a quoted phrase needs its words in order        | `"…"` is an exact phrase           |
//! | NOT excludes and OR widens                      | uppercase operators                |
//! | lowercase operator words are searched for       | only uppercase is an operator      |
//! | rows with the words side by side rank first     | phrase-first, then bm25            |

use memry_core::domain::search::{self, SearchHit};
use memry_core::storage::migrations::{self, DATA_MIGRATIONS, INDEX_MIGRATIONS};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use rusqlite::Connection;

const NOW: i64 = 1_760_000_000_000;

/// Data and index databases holding one note per `(id, title)`, indexed.
fn vault(titles: &[(&str, &str)]) -> (Connection, Connection) {
    let mut data = Connection::open_in_memory().expect("data.db");
    migrations::run(&mut data, DATA_MIGRATIONS).expect("data migrations");
    let mut index = Connection::open_in_memory().expect("index.db");
    migrations::run(&mut index, INDEX_MIGRATIONS).expect("index migrations");
    for (id, title) in titles {
        let record = InboundRecord {
            item_type: "note".to_owned(),
            item_id: (*id).to_owned(),
            payload_json: format!(r#"{{"title":"{title}"}}"#),
            server_cursor: Some(1),
            signer_device_id: Some("device-a".to_owned()),
            updated_at: NOW,
            deleted_at: None,
        };
        sync_items::apply_remote(&data, &record, NOW).expect("apply");
    }
    search::reindex(&data, &index, NOW).expect("reindex");
    (data, index)
}

fn ids(data: &Connection, index: &Connection, query: &str) -> Vec<String> {
    search::search(data, index, query, &search::SearchFilter::default(), 20)
        .map(|groups| [groups.notes, groups.journals].concat())
        .unwrap_or_else(|error| panic!("{query:?} failed: {error:?}"))
        .into_iter()
        .map(|hit: SearchHit| hit.id)
        .collect()
}

fn sorted(mut ids: Vec<String>) -> Vec<String> {
    ids.sort();
    ids
}

#[test]
fn no_typed_text_raises_an_fts5_error() {
    let (data, index) = vault(&[("n1", "Chapter twelve")]);
    for hostile in [
        "\"",
        "*",
        ":",
        "chapter NOT",
        "OR",
        "NOT chapter",
        "chapter OR NOT twelve",
        "he said \"hello",
        "chapter*",
        "title:chapter",
        "-chapter",
        "(chapter OR twelve)",
        "^chapter",
        "NEAR(chapter twelve, 2)",
        "chapter AND AND twelve",
        "\"\"\"",
        "\"chapter",
        "🙂",
        "",
    ] {
        let found = search::search(&data, &index, hostile, &search::SearchFilter::default(), 20)
            .map(|groups| [groups.notes, groups.journals].concat());
        assert!(found.is_ok(), "{hostile:?} raised {:?}", found.err());
    }
    assert_eq!(
        ids(&data, &index, "NOT chapter"),
        vec!["n1"],
        "a leading NOT is dropped"
    );
    assert_eq!(
        ids(&data, &index, "chapter NOT"),
        vec!["n1"],
        "a trailing NOT is dropped"
    );
    assert!(ids(&data, &index, "*").is_empty());
}

#[test]
fn a_partial_word_finds_the_whole_word() {
    let (data, index) = vault(&[("pw", "Password list"), ("g", "Grocery")]);
    assert_eq!(ids(&data, &index, "pas"), vec!["pw"]);
    assert_eq!(ids(&data, &index, "pass"), vec!["pw"]);
    assert_eq!(
        ids(&data, &index, "pass li"),
        vec!["pw"],
        "every word is a prefix"
    );
}

#[test]
fn a_quoted_phrase_needs_its_words_in_order() {
    let (data, index) = vault(&[
        ("ordered", "exact phrase here"),
        ("reordered", "phrase exact here"),
    ]);
    assert_eq!(ids(&data, &index, "\"exact phrase\""), vec!["ordered"]);
    assert_eq!(
        sorted(ids(&data, &index, "exact phrase")),
        vec!["ordered", "reordered"],
        "unquoted, the words may sit anywhere"
    );
}

#[test]
fn not_excludes_and_or_widens() {
    let (data, index) = vault(&[
        ("ab", "apple banana"),
        ("ac", "apple cherry"),
        ("z", "zebra"),
    ]);
    assert_eq!(ids(&data, &index, "apple NOT banana"), vec!["ac"]);
    assert_eq!(
        sorted(ids(&data, &index, "zebra OR cherry")),
        vec!["ac", "z"]
    );
    assert_eq!(
        sorted(ids(&data, &index, "zebra OR \"apple banana\"")),
        vec!["ab", "z"],
        "an OR before a phrase is kept"
    );
    assert_eq!(ids(&data, &index, "apple AND cherry"), vec!["ac"]);
}

#[test]
fn lowercase_operator_words_are_searched_for() {
    let (data, index) = vault(&[("ab", "apple banana"), ("words", "apple or not banana")]);
    assert_eq!(ids(&data, &index, "apple not banana"), vec!["words"]);
    assert_eq!(ids(&data, &index, "apple or banana"), vec!["words"]);
}

#[test]
fn rows_with_the_words_side_by_side_rank_first() {
    // The title weight puts `scattered` first on bm25 alone: it holds both
    // words in a short title, `adjacent` holds them in a longer one.
    let (data, index) = vault(&[
        (
            "adjacent",
            "the long list of filler words before the black white design",
        ),
        ("scattered", "white and black"),
    ]);
    assert_eq!(
        ids(&data, &index, "black white"),
        vec!["adjacent", "scattered"]
    );
    assert_eq!(
        ids(&data, &index, "black whi"),
        vec!["adjacent", "scattered"],
        "the last word is still a prefix inside the phrase"
    );
    assert_eq!(
        ids(&data, &index, "black OR white"),
        vec!["scattered", "adjacent"],
        "an operator query keeps bm25 order"
    );
}
