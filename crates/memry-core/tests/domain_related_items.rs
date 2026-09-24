//! The task detail's related-item search and linked-item resolution (spec 004
//! TP027), against real SQLite seeded through the real apply path.
//!
//! | Test                                                  | Desktop reference                   |
//! | ----------------------------------------------------- | ----------------------------------- |
//! | the empty query lists recent notes and files          | `notesService.list` modified desc   |
//! | a typed query ranks title prefix, words, path, substr | FTS prefix + title weight + fuzzy   |
//! | every term must match, case-insensitively             | FTS implicit AND                    |
//! | a query with no match or only syntax is empty         | `buildPrefixQuery` -> no results    |
//! | linked note ids resolve like open-related-vault-item  | `openRelatedVaultItem`              |
//! | a linked canvas is not on this device                 | core does not subscribe to `canvas` |

use memry_core::domain::related_items::{
    self, LinkState, LinkedField, LinkedItem, RECENT_LIMIT, RelatedItem, RelatedKind, SEARCH_LIMIT,
};
use memry_core::storage::migrations::{self, DATA_MIGRATIONS};
use memry_core::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use rusqlite::Connection;
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;

fn data() -> Connection {
    let mut conn = Connection::open_in_memory().expect("data.db");
    migrations::run(&mut conn, DATA_MIGRATIONS).expect("data migrations");
    conn
}

fn record(item_type: &str, id: &str, payload: &Value) -> InboundRecord {
    InboundRecord {
        item_type: item_type.to_owned(),
        item_id: id.to_owned(),
        payload_json: serde_json::to_string(payload).expect("serialise"),
        server_cursor: None,
        signer_device_id: None,
        updated_at: NOW,
        deleted_at: None,
    }
}

fn apply(conn: &Connection, item_type: &str, id: &str, payload: Value) {
    let outcome =
        sync_items::apply_remote(conn, &record(item_type, id, &payload), NOW).expect("apply");
    assert_eq!(outcome, ApplyOutcome::Applied, "{id}");
}

/// A markdown note modified `minutes` after NOW.
fn note(conn: &Connection, id: &str, title: &str, folder: Option<&str>, minutes: i64) {
    apply(
        conn,
        "note",
        id,
        json!({
            "title": title,
            "folderPath": folder,
            "modifiedAt": NOW + minutes * 60_000,
            "clock": {"device-b": 1}
        }),
    );
}

fn tombstone(conn: &Connection, item_type: &str, id: &str) {
    let mut gone = record(item_type, id, &json!({}));
    gone.deleted_at = Some(NOW + 1);
    sync_items::apply_remote(conn, &gone, NOW + 1).expect("apply the tombstone");
}

fn ids(items: &[RelatedItem]) -> Vec<&str> {
    items.iter().map(|item| item.id.as_str()).collect()
}

fn search(conn: &Connection, query: &str) -> Vec<RelatedItem> {
    related_items::search(conn, query, SEARCH_LIMIT).expect("search")
}

#[test]
fn the_empty_query_lists_recent_notes_and_files_newest_first() {
    let conn = data();
    note(&conn, "old", "Old note", None, 1);
    note(&conn, "new", "New note", Some("Work"), 3);
    apply(
        &conn,
        "note",
        "pdf",
        json!({"title": "Scan", "fileType": "pdf", "mimeType": "application/pdf", "modifiedAt": NOW + 2 * 60_000}),
    );
    note(&conn, "gone", "Deleted note", None, 4);
    tombstone(&conn, "note", "gone");
    apply(
        &conn,
        "journal",
        "j2026-04-16",
        json!({"date": "2026-04-16"}),
    );

    let recent = related_items::search(&conn, "   ", RECENT_LIMIT).expect("search");
    assert_eq!(ids(&recent), ["new", "pdf", "old"]);
    assert_eq!(
        recent[0],
        RelatedItem {
            kind: RelatedKind::Note,
            id: "new".to_owned(),
            title: "New note".to_owned(),
            folder_path: Some("Work".to_owned()),
            emoji: None,
            file_type: "markdown".to_owned(),
            modified_at: Some(NOW + 3 * 60_000),
            journal_date: None,
        }
    );
    assert_eq!(recent[1].kind, RelatedKind::File);
    assert_eq!(recent[1].file_type, "pdf");

    let limited = related_items::search(&conn, "", 2).expect("search");
    assert_eq!(ids(&limited), ["new", "pdf"]);
    assert!(
        related_items::search(&conn, "", 0)
            .expect("search")
            .is_empty()
    );
}

#[test]
fn a_typed_query_ranks_title_prefix_then_title_words_then_path_then_substring() {
    let conn = data();
    // Tier 4: "road" inside a word of the title.
    note(&conn, "substring", "Railroad history", None, 9);
    // Tier 3: only the folder path carries a word starting with "road".
    note(&conn, "path", "Q3 goals", Some("Roadmaps/2026"), 8);
    // Tier 2: a later title word starts with "road".
    note(&conn, "word-new", "Product roadmap", None, 7);
    note(&conn, "word-old", "The road ahead", None, 2);
    // Tier 1: the title starts with the query; the older one still leads the
    // lower tiers.
    note(&conn, "prefix-old", "Roadmap 2025", None, 1);
    note(&conn, "prefix-new", "road trip", None, 5);
    note(&conn, "unrelated", "Groceries", Some("Home"), 10);

    assert_eq!(
        ids(&search(&conn, "Road")),
        [
            "prefix-new",
            "prefix-old",
            "word-new",
            "word-old",
            "path",
            "substring"
        ]
    );
    assert_eq!(
        ids(&related_items::search(&conn, "road", 3).expect("search")),
        ["prefix-new", "prefix-old", "word-new"]
    );
}

#[test]
fn every_term_must_match_case_insensitively() {
    let conn = data();
    note(&conn, "both", "Weekly Planning Notes", None, 1);
    note(&conn, "one", "Weekly review", None, 2);
    note(&conn, "split", "Planning", Some("Weekly"), 3);

    assert_eq!(ids(&search(&conn, "PLAN week")), ["both", "split"]);
    assert_eq!(ids(&search(&conn, "weekly planning")), ["both", "split"]);
}

#[test]
fn a_query_with_no_match_or_only_syntax_is_empty_without_failing() {
    let conn = data();
    note(&conn, "n1", "Design review", None, 1);

    assert!(search(&conn, "zebra").is_empty());
    for hostile in ["\"", "*", "(a OR b", "%", "_", "'; DROP TABLE notes; --"] {
        assert!(search(&conn, hostile).is_empty(), "{hostile}");
    }
    assert_eq!(ids(&search(&conn, "design")), ["n1"]);
}

#[test]
fn linked_note_ids_resolve_like_open_related_vault_item() {
    let conn = data();
    note(&conn, "note-1", "Spec", Some("Work"), 1);
    apply(
        &conn,
        "note",
        "file-1",
        json!({"title": "Photo", "fileType": "image", "modifiedAt": NOW}),
    );
    apply(
        &conn,
        "journal",
        "legacy-journal-id",
        json!({"date": "2026-04-15"}),
    );
    note(&conn, "deleted", "Gone", None, 1);
    tombstone(&conn, "note", "deleted");

    let linked_notes: Vec<String> = [
        "note-1",
        "file-1",
        "legacy-journal-id",
        "j2026-04-16",
        "deleted",
        "never-existed",
    ]
    .map(str::to_owned)
    .to_vec();
    let linked_canvases = vec!["canvas-1".to_owned()];

    let resolved = related_items::resolve(&conn, &linked_notes, &linked_canvases).expect("resolve");

    let states: Vec<(&str, LinkedField, &LinkState)> = resolved
        .iter()
        .map(|LinkedItem { field, id, state }| (id.as_str(), *field, state))
        .collect();
    assert_eq!(states.len(), 7);

    let present = |index: usize| match states[index].2 {
        LinkState::Present(item) => item.clone(),
        other => panic!("{} resolved to {other:?}", states[index].0),
    };
    let spec = present(0);
    assert_eq!(
        (spec.kind, spec.title.as_str()),
        (RelatedKind::Note, "Spec")
    );
    assert_eq!(spec.folder_path.as_deref(), Some("Work"));
    let photo = present(1);
    assert_eq!(
        (photo.kind, photo.file_type.as_str()),
        (RelatedKind::File, "image")
    );

    // A journal entry found by id, and a `j<date>` id with no entry: desktop
    // opens the day by date, so neither is missing.
    let entry = present(2);
    assert_eq!(entry.kind, RelatedKind::Journal);
    assert_eq!(entry.journal_date.as_deref(), Some("2026-04-15"));
    let day = present(3);
    assert_eq!(day.kind, RelatedKind::Journal);
    assert_eq!(day.journal_date.as_deref(), Some("2026-04-16"));
    assert_eq!(day.title, "2026-04-16");

    assert_eq!(
        states[4],
        ("deleted", LinkedField::Note, &LinkState::Missing)
    );
    assert_eq!(
        states[5],
        ("never-existed", LinkedField::Note, &LinkState::Missing)
    );
    for (id, field, _) in &states[..6] {
        assert_eq!(*field, LinkedField::Note, "{id}");
    }
    assert_eq!(
        states[6],
        ("canvas-1", LinkedField::Canvas, &LinkState::NotOnDevice)
    );
}

#[test]
fn nothing_linked_resolves_to_nothing() {
    let conn = data();
    assert!(
        related_items::resolve(&conn, &[], &[])
            .expect("resolve")
            .is_empty()
    );
}
