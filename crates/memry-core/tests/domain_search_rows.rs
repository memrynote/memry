//! What a search hit carries for its row (#4323): a note its emoji and folder
//! from `data.db`, a journal its date, a task neither. Real SQLite and FTS5.

use memry_core::api::search::SearchResult;
use memry_core::domain::search::{self, HitKind};
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

#[test]
fn a_note_hit_carries_its_emoji_and_folder() {
    let (data, index) = databases();
    put(
        &data,
        "note",
        "n1",
        r#"{"title":"Password list","emoji":"🔑","folderPath":"Work/Accounts"}"#,
    );
    put(
        &data,
        "note",
        "n2",
        r#"{"title":"Password at the root","emoji":"","folderPath":""}"#,
    );
    put(&data, "note", "n3", r#"{"title":"Password bare"}"#);
    search::reindex(&data, &index, NOW).expect("reindex");

    let hits = search::search(
        &data,
        &index,
        "password",
        &search::SearchFilter::default(),
        20,
    )
    .map(|groups| [groups.notes, groups.journals].concat())
    .expect("search");
    let kind = |id: &str| {
        hits.iter()
            .find(|hit| hit.id == id)
            .map(|hit| hit.kind.clone())
            .expect("the hit")
    };
    assert_eq!(
        kind("n1"),
        HitKind::Note {
            emoji: Some("🔑".to_owned()),
            folder_path: Some("Work/Accounts".to_owned()),
        }
    );
    let none = HitKind::Note {
        emoji: None,
        folder_path: None,
    };
    assert_eq!(
        kind("n2"),
        none,
        "an empty string is no emoji and no folder"
    );
    assert_eq!(kind("n3"), none);

    let result = SearchResult::from(hits.into_iter().find(|hit| hit.id == "n1").expect("n1"));
    assert_eq!(result.kind, "note");
    assert_eq!(result.emoji.as_deref(), Some("🔑"));
    assert_eq!(result.folder_path.as_deref(), Some("Work/Accounts"));
    assert_eq!(result.journal_date, None);
}

#[test]
fn journal_and_task_hits_carry_no_emoji_or_folder() {
    let (data, index) = databases();
    put(
        &data,
        "journal",
        "j1",
        r#"{"date":"2026-11-10","title":"Router","emoji":"📓"}"#,
    );
    put(
        &data,
        "task",
        "t1",
        r#"{"title":"Router firmware","projectId":"p"}"#,
    );
    search::reindex(&data, &index, NOW).expect("reindex");

    let journal = SearchResult::from(
        search::search(
            &data,
            &index,
            "router",
            &search::SearchFilter::default(),
            20,
        )
        .map(|groups| [groups.notes, groups.journals].concat())
        .expect("notes")
        .remove(0),
    );
    assert_eq!(journal.kind, "journal");
    assert_eq!(journal.journal_date.as_deref(), Some("2026-11-10"));
    assert_eq!((journal.emoji, journal.folder_path), (None, None));

    let task = SearchResult::from(
        search::search(
            &data,
            &index,
            "router",
            &search::SearchFilter::default(),
            20,
        )
        .map(|groups| groups.tasks)
        .expect("tasks")
        .remove(0),
    );
    assert_eq!(task.kind, "task");
    assert_eq!((task.emoji, task.folder_path), (None, None));
}
