//! The body snippet under each search hit (#4316), through a real body
//! document, `reindex`, and FTS5 `snippet()`.
//!
//! | Test                                         | Rule                                    |
//! | -------------------------------------------- | --------------------------------------- |
//! | a body hit highlights the word it matched    | segments carry the highlight            |
//! | a title-only hit shows the body plainly      | no highlight, still shown               |
//! | an empty body has no snippet                 | empty list                              |
//! | a non-ASCII word is highlighted whole        | segments split on characters, not bytes |
//! | an emoji in the window survives              | same                                    |
//! | a task snippet comes from its description    | tasks: `description`, not the title     |

use std::sync::{Arc, Mutex};

use memry_core::crdt::DocumentRegistry;
use memry_core::crdt::markdown_seed::seed_document;
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::update_log::append_server_update;
use memry_core::domain::search::{self, SearchHit, SnippetSegment};
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

/// A note titled `title` whose body is `markdown`, written the way a peer's
/// body reaches this device: as a server update in the log.
fn note(data: &Connection, id: &str, title: &str, markdown: &str) {
    put(data, "note", id, &format!(r#"{{"title":"{title}"}}"#));
    if markdown.is_empty() {
        return;
    }
    let seen: Arc<Mutex<Vec<Vec<u8>>>> = Arc::default();
    let captured = Arc::clone(&seen);
    let sink: UpdateSink = Arc::new(move |_, bytes| {
        captured.lock().expect("sink").push(bytes.to_vec());
    });
    let document = DocumentRegistry::new("device-a", sink)
        .get_or_open(id)
        .expect("open the body");
    seed_document(&document, markdown).expect("seed the body");
    for (seq, update) in seen.lock().expect("sink").iter().enumerate() {
        append_server_update(data, id, seq as i64 + 1, update, NOW).expect("append the body");
    }
}

fn only_hit(hits: Vec<SearchHit>) -> SearchHit {
    assert_eq!(hits.len(), 1, "{hits:?}");
    hits.into_iter().next().expect("one hit")
}

fn note_hit(data: &Connection, index: &Connection, query: &str) -> SearchHit {
    search::reindex(data, index, NOW).expect("reindex");
    only_hit(search::search_notes(data, index, query, 20).expect("search notes"))
}

fn highlighted(snippet: &[SnippetSegment]) -> Vec<&str> {
    snippet
        .iter()
        .filter(|segment| segment.highlighted)
        .map(|segment| segment.text.as_str())
        .collect()
}

fn text(snippet: &[SnippetSegment]) -> String {
    snippet
        .iter()
        .map(|segment| segment.text.as_str())
        .collect()
}

#[test]
fn a_body_hit_highlights_the_word_it_matched() {
    let (data, index) = databases();
    note(
        &data,
        "n1",
        "Accounts",
        "# Router\n\n- the wifi password is on the fridge",
    );

    let hit = note_hit(&data, &index, "password");
    assert_eq!(highlighted(&hit.snippet), vec!["password"]);
    assert_eq!(
        text(&hit.snippet),
        "Router the wifi password is on the fridge",
        "block markers and line breaks collapse into one line"
    );
}

#[test]
fn a_title_only_hit_shows_the_body_plainly() {
    let (data, index) = databases();
    note(&data, "n1", "Password list", "Nothing about it here.");

    let hit = note_hit(&data, &index, "password");
    assert_eq!(
        hit.snippet,
        vec![SnippetSegment {
            text: "Nothing about it here.".to_owned(),
            highlighted: false,
        }]
    );
}

#[test]
fn an_empty_body_has_no_snippet() {
    let (data, index) = databases();
    note(&data, "n1", "Password list", "");

    assert_eq!(note_hit(&data, &index, "password").snippet, Vec::new());
}

#[test]
fn a_non_ascii_word_is_highlighted_whole() {
    let (data, index) = databases();
    note(&data, "tr", "Hesaplar", "Yeni şifre burada yazılı.");
    note(&data, "fr", "Notes", "A naïve approach works.");

    let turkish = note_hit(&data, &index, "şifre");
    assert_eq!(highlighted(&turkish.snippet), vec!["şifre"]);
    assert_eq!(text(&turkish.snippet), "Yeni şifre burada yazılı.");

    let french = note_hit(&data, &index, "naïve");
    assert_eq!(highlighted(&french.snippet), vec!["naïve"]);
}

#[test]
fn an_emoji_in_the_window_survives() {
    let (data, index) = databases();
    note(&data, "n1", "Trip", "Packed 🧳 the passport and 🔑 keys");

    let hit = note_hit(&data, &index, "passport");
    assert_eq!(highlighted(&hit.snippet), vec!["passport"]);
    assert_eq!(text(&hit.snippet), "Packed 🧳 the passport and 🔑 keys");
}

#[test]
fn a_task_snippet_comes_from_its_description() {
    let (data, index) = databases();
    put(
        &data,
        "task",
        "t1",
        r#"{"title":"Call the bank","description":"ask about the zephyrquartz card","projectId":"p"}"#,
    );
    search::reindex(&data, &index, NOW).expect("reindex");

    let hit = only_hit(search::search_tasks(&data, &index, "zephyrquartz", 20).expect("tasks"));
    assert_eq!(highlighted(&hit.snippet), vec!["zephyrquartz"]);
    assert_eq!(text(&hit.snippet), "ask about the zephyrquartz card");
}
