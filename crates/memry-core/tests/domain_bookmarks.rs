//! Bookmarks (`bookmark`), read-only, against real SQLite.
//!
//! | Test                                                      | Rule                        |
//! | --------------------------------------------------------- | --------------------------- |
//! | the declaration subscribes to `bookmark`                  | chapter 13 §13.1            |
//! | inbound bookmarks resolve as desktop's sidebar does       | desktop `resolveBookmarkItem` |
//! | an inbound tombstone hides the bookmark                   | §5.12                       |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::domain::bookmarks::{self, BookmarkEntry};
use memry_core::protocol::types::{ArrivingItemType, Declaration};
use memry_core::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use memry_core::storage::{Db, open_data};
use memry_core::sync::apply::apply_inbound;
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-bookmarks-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn inbound(
    item_type: &str,
    item_id: &str,
    payload: &Value,
    deleted_at: Option<i64>,
) -> InboundRecord {
    InboundRecord {
        item_type: item_type.to_owned(),
        item_id: item_id.to_owned(),
        payload_json: serde_json::to_string(payload).expect("serialise"),
        server_cursor: Some(7),
        signer_device_id: Some("device-desktop".to_owned()),
        updated_at: NOW,
        deleted_at,
    }
}

/// What desktop pushes: `JSON.stringify` of its `bookmarks` row, `id` and
/// `syncedAt` included.
fn bookmark(item_type: &str, item_id: &str, position: i64) -> (String, Value) {
    let id = format!("bmk_{item_type}_{item_id}");
    let payload = json!({
        "id": id,
        "itemType": item_type,
        "itemId": item_id,
        "position": position,
        "clock": { "device-desktop": 1 },
        "syncedAt": null,
        "createdAt": "2025-10-09T08:53:20.000Z",
    });
    (id, payload)
}

#[test]
fn the_declaration_subscribes_to_bookmark() {
    let declaration = Declaration::subscribed();
    assert_eq!(
        declaration.classify("bookmark"),
        ArrivingItemType::Subscribed
    );
    assert!(
        declaration
            .header_value()
            .contains(",calendar_binding,bookmark,")
    );
}

#[test]
fn inbound_bookmarks_resolve_as_desktops_sidebar_does() {
    let db = open("resolve");
    db.call_blocking(|conn| {
        let note =
            json!({ "title": "Why I'm building", "emoji": "x", "clock": { "device-desktop": 1 } });
        assert_eq!(
            apply_inbound(conn, &inbound("note", "n1", &note, None), NOW)?,
            ApplyOutcome::Applied
        );

        let rows = [
            bookmark("tag", "movies", 4),
            bookmark("note", "n1", 0),
            bookmark("folder", "Projects/Launch", 2),
            // Gone and unknown: left out, as desktop's `itemExists` does.
            bookmark("note", "missing", 1),
            bookmark("canvas", "c1", 3),
        ];
        for (id, payload) in &rows {
            assert_eq!(
                apply_inbound(conn, &inbound("bookmark", id, payload, None), NOW)?,
                ApplyOutcome::Applied
            );
        }

        // §13.2 rule 1: the bytes as received, desktop's local columns intact.
        let (first_id, first_payload) = &rows[0];
        assert_eq!(
            sync_items::push_payload(conn, "bookmark", first_id)?,
            Some(serde_json::to_string(first_payload).expect("serialise"))
        );

        assert_eq!(
            bookmarks::list(conn)?,
            vec![
                BookmarkEntry {
                    id: "bmk_note_n1".to_owned(),
                    item_type: "note".to_owned(),
                    item_id: "n1".to_owned(),
                    title: Some("Why I'm building".to_owned()),
                    emoji: Some("x".to_owned()),
                    journal_date: None,
                    position: 0,
                },
                BookmarkEntry {
                    id: "bmk_folder_Projects/Launch".to_owned(),
                    item_type: "folder".to_owned(),
                    item_id: "Projects/Launch".to_owned(),
                    title: Some("Launch".to_owned()),
                    emoji: None,
                    journal_date: None,
                    position: 2,
                },
                BookmarkEntry {
                    id: "bmk_tag_movies".to_owned(),
                    item_type: "tag".to_owned(),
                    item_id: "movies".to_owned(),
                    title: Some("movies".to_owned()),
                    emoji: None,
                    journal_date: None,
                    position: 4,
                },
            ]
        );
        Ok(())
    })
    .expect("the inbound apply");
}

#[test]
fn an_inbound_tombstone_hides_the_bookmark() {
    let db = open("tombstone");
    db.call_blocking(|conn| {
        let (id, payload) = bookmark("tag", "movies", 0);
        apply_inbound(conn, &inbound("bookmark", &id, &payload, None), NOW)?;
        assert_eq!(bookmarks::list(conn)?.len(), 1);
        let mut deleted = payload.clone();
        deleted["clock"] = json!({ "device-desktop": 2 });
        apply_inbound(
            conn,
            &inbound("bookmark", &id, &deleted, Some(NOW + 1)),
            NOW + 1,
        )?;
        assert!(bookmarks::list(conn)?.is_empty());
        Ok(())
    })
    .expect("the tombstone");
}
