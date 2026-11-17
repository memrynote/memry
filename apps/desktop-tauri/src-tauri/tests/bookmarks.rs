//! The `bookmarks_*` and `recents_*` commands through the IPC a renderer calls, over a real vault
//! (Electron's `ipc/bookmarks-handlers.ts` and `ipc/recents-handlers.ts`, #3547 30a): the
//! contract shapes, the refusals, the events each write sends, and desktop's cap of 20 search
//! reasons.

#[allow(
    dead_code,
    reason = "only the open, session and invoke of the harness are used"
)]
mod support;

use std::sync::{Arc, Mutex};

use memry_core::crypto::sodium;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::seams::secure_store::{DeviceIdentityStore, KeyringStore, Store, StoreFactory};
use memry_tauri::events::{BookmarkCreatedEvent, BookmarkDeletedEvent, BookmarksReorderedEvent};
use serde_json::{Value, json};
use support::{Mocked, WAIT};
use tauri::test::MockRuntime;
use tauri::{Listener, Manager};
use tauri_specta::{Event, collect_commands};

const PLAN: &str = "---\ntags: [work]\n---\nThe plan.\n";
const IDEAS: &str = "Some ideas.\n";

/// One in-memory keychain, shared by every build.
struct Keychain(Store);

impl StoreFactory for Keychain {
    fn build(&self) -> keyring_core::Result<Store> {
        Ok(self.0.clone())
    }
}

struct Fixture {
    mocked: Mocked,
    _keys: tempfile::TempDir,
    plan: String,
    ideas: String,
    heard: Arc<Mutex<Vec<(&'static str, Value)>>>,
}

fn commands() -> tauri_specta::Builder<MockRuntime> {
    tauri_specta::Builder::<MockRuntime>::new()
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::bookmarks::bookmarks_bulk_create::<MockRuntime>,
            memry_tauri::commands::bookmarks::bookmarks_bulk_delete::<MockRuntime>,
            memry_tauri::commands::bookmarks::bookmarks_create::<MockRuntime>,
            memry_tauri::commands::bookmarks::bookmarks_delete::<MockRuntime>,
            memry_tauri::commands::bookmarks::bookmarks_get::<MockRuntime>,
            memry_tauri::commands::bookmarks::bookmarks_get_by_item::<MockRuntime>,
            memry_tauri::commands::bookmarks::bookmarks_is_bookmarked::<MockRuntime>,
            memry_tauri::commands::bookmarks::bookmarks_list::<MockRuntime>,
            memry_tauri::commands::bookmarks::bookmarks_list_by_type::<MockRuntime>,
            memry_tauri::commands::bookmarks::bookmarks_reorder::<MockRuntime>,
            memry_tauri::commands::bookmarks::bookmarks_toggle::<MockRuntime>,
            memry_tauri::commands::recents::recents_list::<MockRuntime>,
            memry_tauri::commands::recents::recents_record::<MockRuntime>,
            memry_tauri::commands::search::search_add_reason::<MockRuntime>,
            memry_tauri::commands::search::search_get_reasons::<MockRuntime>,
        ])
}

fn note_id(mocked: &Mocked, path: &str) -> String {
    mocked
        .session()
        .current()
        .unwrap()
        .vault
        .note_files()
        .by_path(path)
        .unwrap()
        .unwrap_or_else(|| panic!("a row for {path}"))
        .note_id
}

/// A vault holding `files`, the app's device identity store, and every bookmark event heard.
fn opened_with(files: &[(&str, &str)]) -> Fixture {
    let mocked = Mocked::open(files, commands());
    let keys = tempfile::tempdir().unwrap();
    let keychain = Keychain(keyring_core::mock::Store::new().unwrap());
    let keyring = Arc::new(KeyringStore::with_factory(keychain, None, WAIT));
    let store = Arc::new(DeviceIdentityStore::with_probe(
        &keyring,
        keys.path(),
        || false,
    ));
    let (_, secret) = sodium::sign_seed_keypair(&[9u8; 32]).unwrap();
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .unwrap();
    let app = mocked.webview.app_handle().clone();
    app.manage(store);
    let heard: Arc<Mutex<Vec<(&'static str, Value)>>> = Arc::default();
    for name in [
        BookmarkCreatedEvent::NAME,
        BookmarkDeletedEvent::NAME,
        BookmarksReorderedEvent::NAME,
    ] {
        let sink = Arc::clone(&heard);
        app.listen_any(name, move |event| {
            let payload = serde_json::from_str(event.payload()).unwrap();
            sink.lock().unwrap().push((name, payload));
        });
    }
    let (plan, ideas) = match files.first() {
        Some(_) if files.len() == 2 => (note_id(&mocked, "Plan.md"), note_id(&mocked, "Ideas.md")),
        _ => (String::new(), String::new()),
    };
    Fixture {
        mocked,
        _keys: keys,
        plan,
        ideas,
        heard,
    }
}

fn opened() -> Fixture {
    opened_with(&[("Plan.md", PLAN), ("Ideas.md", IDEAS)])
}

impl Fixture {
    fn invoke(&self, cmd: &str, args: Value) -> Result<Value, Value> {
        self.mocked.invoke(cmd, args)
    }

    fn ok(&self, cmd: &str, args: Value) -> Value {
        self.invoke(cmd, args)
            .unwrap_or_else(|error| panic!("{cmd}: {error}"))
    }

    /// The events heard since the last call, as `(name, payload)`.
    fn heard(&self) -> Vec<(&'static str, Value)> {
        std::mem::take(&mut *self.heard.lock().unwrap())
    }

    fn item(&self, item_type: &str, item_id: &str) -> Value {
        json!({ "input": { "itemType": item_type, "itemId": item_id } })
    }
}

#[test]
fn a_toggle_bookmarks_an_item_then_removes_it_and_announces_each() {
    let f = opened();
    let plan = f.item("note", &f.plan);

    let on = f.ok("bookmarks_toggle", plan.clone());
    let id = format!("bmk_note_{}", f.plan);
    assert_eq!(on["isBookmarked"], true);
    assert_eq!(on["bookmark"]["id"], id);
    assert_eq!(on["bookmark"]["itemId"], f.plan.as_str());
    assert!(on["bookmark"]["createdAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(
        f.heard(),
        [(
            BookmarkCreatedEvent::NAME,
            json!({ "bookmark": on["bookmark"] })
        )]
    );
    assert_eq!(f.ok("bookmarks_is_bookmarked", plan.clone()), true);

    let off = f.ok("bookmarks_toggle", plan.clone());
    assert_eq!(off, json!({ "isBookmarked": false, "bookmark": null }));
    assert_eq!(
        f.heard(),
        [(
            BookmarkDeletedEvent::NAME,
            json!({ "id": id, "itemType": "note", "itemId": f.plan })
        )]
    );
    assert_eq!(f.ok("bookmarks_is_bookmarked", plan), false);
}

#[test]
fn a_create_answers_the_row_and_a_second_create_or_a_missing_delete_is_refused() {
    let f = opened();
    let plan = f.item("note", &f.plan);

    let row = f.ok("bookmarks_create", plan.clone());
    assert_eq!(
        f.heard(),
        [(BookmarkCreatedEvent::NAME, json!({ "bookmark": row }))]
    );
    let again = f.invoke("bookmarks_create", plan.clone()).unwrap_err();
    assert_eq!(again["code"], "already_bookmarked");
    assert_eq!(again["message"], "Item is already bookmarked");
    assert!(f.heard().is_empty(), "a refused create sends nothing");

    assert_eq!(f.ok("bookmarks_get", json!({ "id": row["id"] })), row);
    assert_eq!(f.ok("bookmarks_get_by_item", plan.clone()), row);
    assert_eq!(
        f.ok("bookmarks_get_by_item", f.item("note", &f.ideas)),
        Value::Null
    );

    assert_eq!(
        f.ok("bookmarks_delete", json!({ "id": row["id"] })),
        Value::Null
    );
    assert_eq!(f.heard()[0].0, BookmarkDeletedEvent::NAME);
    assert_eq!(
        f.ok("bookmarks_get", json!({ "id": row["id"] })),
        Value::Null
    );
    let missing = f
        .invoke("bookmarks_delete", json!({ "id": row["id"] }))
        .unwrap_err();
    assert_eq!(missing["code"], "not_found");
    assert_eq!(missing["message"], "Bookmark not found");
}

#[test]
fn the_list_resolves_each_item_pages_and_follows_a_reorder() {
    let f = opened();
    let items = json!({ "items": [
        { "itemType": "note", "itemId": f.plan },
        { "itemType": "folder", "itemId": "projects/alpha" },
        { "itemType": "tag", "itemId": "work" },
        { "itemType": "note", "itemId": "gone" },
    ] });
    assert_eq!(f.ok("bookmarks_bulk_create", items.clone()), 4);
    assert_eq!(f.heard().len(), 4);
    assert_eq!(
        f.ok("bookmarks_bulk_create", items),
        0,
        "each is bookmarked already"
    );

    // The header tags reach the search index after the open walk, from the note index's pass.
    let deadline = std::time::Instant::now() + WAIT;
    let all = loop {
        let all = f.ok("bookmarks_list", json!({ "input": {} }));
        if all["bookmarks"][0]["itemMeta"].get("tags").is_some() {
            break all;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "Plan's tags never reached the index"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    assert_eq!(all["total"], 4);
    assert_eq!(all["hasMore"], false);
    let rows = all["bookmarks"].as_array().unwrap();
    assert_eq!(rows[0]["itemTitle"], "Plan");
    assert_eq!(rows[0]["itemExists"], true);
    assert_eq!(
        rows[0]["itemMeta"],
        json!({ "path": "Plan.md", "tags": ["work"] })
    );
    assert_eq!(rows[1]["itemTitle"], "alpha");
    assert_eq!(rows[1]["itemMeta"], json!({ "path": "projects/alpha" }));
    assert_eq!(rows[2]["itemTitle"], "work");
    assert!(rows[2].get("itemMeta").is_none(), "a tag has no meta");
    assert_eq!(rows[3]["itemTitle"], Value::Null);
    assert_eq!(rows[3]["itemExists"], false);

    let page = f.ok(
        "bookmarks_list",
        json!({ "input": { "limit": 2, "offset": 1 } }),
    );
    assert_eq!(page["bookmarks"].as_array().unwrap().len(), 2);
    assert_eq!(page["hasMore"], true);
    let notes = f.ok("bookmarks_list_by_type", json!({ "itemType": "note" }));
    assert_eq!(notes["total"], 2);
    assert_eq!(notes["bookmarks"].as_array().unwrap().len(), 2);
    let refused = f
        .invoke("bookmarks_list", json!({ "input": { "limit": 0 } }))
        .unwrap_err();
    assert_eq!(refused["kind"], "invalid");

    let mut ids: Vec<Value> = rows.iter().map(|row| row["id"].clone()).collect();
    ids.reverse();
    f.ok("bookmarks_reorder", json!({ "bookmarkIds": ids }));
    assert_eq!(
        f.heard(),
        [(BookmarksReorderedEvent::NAME, json!({ "bookmarkIds": ids }))]
    );
    let reordered = f.ok("bookmarks_list", json!({ "input": {} }));
    let order: Vec<Value> = reordered["bookmarks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].clone())
        .collect();
    assert_eq!(order, ids);
    let newest_first = f.ok(
        "bookmarks_list",
        json!({ "input": { "sortBy": "position", "sortOrder": "desc" } }),
    );
    assert_eq!(newest_first["bookmarks"][0]["id"], ids[3]);

    let removed = f.ok(
        "bookmarks_bulk_delete",
        json!({ "bookmarkIds": [ids[0], ids[1], "bmk_note_none"] }),
    );
    assert_eq!(removed, 2, "an id with no live row is skipped");
    let deleted = f.heard();
    assert_eq!(deleted.len(), 2);
    assert!(
        deleted
            .iter()
            .all(|(name, event)| *name == BookmarkDeletedEvent::NAME
                && !event["itemType"].as_str().unwrap().is_empty())
    );
    assert_eq!(f.ok("bookmarks_list", json!({ "input": {} }))["total"], 2);
}

#[test]
fn the_trail_lists_opened_notes_newest_first_and_refuses_a_bad_input() {
    let f = opened();
    let record = |id: &str| {
        f.invoke(
            "recents_record",
            json!({ "input": { "itemId": id, "itemType": "note" } }),
        )
    };
    assert_eq!(record(&f.plan).unwrap(), true);
    assert_eq!(record(&f.ideas).unwrap(), true);
    assert_eq!(record("gone").unwrap(), true);

    let listed = f.ok("recents_list", json!({ "limit": null }));
    let items = listed.as_array().unwrap();
    assert_eq!(items.len(), 2, "a note that does not exist is left out");
    assert_eq!(items[0]["itemId"], f.ideas.as_str());
    assert_eq!(items[1]["itemId"], f.plan.as_str());
    assert_eq!(items[1]["itemType"], "note");
    assert_eq!(items[1]["title"], "Plan");
    assert_eq!(items[1]["path"], "Plan.md");
    assert_eq!(items[1]["fileType"], "markdown");
    assert!(items[1]["openedAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(
        f.ok("recents_list", json!({ "limit": 1 }))
            .as_array()
            .unwrap()
            .len(),
        1
    );

    assert_eq!(record("").unwrap_err()["kind"], "invalid");
    assert!(
        f.invoke(
            "recents_record",
            json!({ "input": { "itemId": "x", "itemType": "task" } })
        )
        .is_err(),
        "a type the trail does not hold"
    );
    assert_eq!(
        f.invoke("recents_list", json!({ "limit": 51 }))
            .unwrap_err()["kind"],
        "invalid"
    );
}

#[test]
fn the_palette_keeps_twenty_search_reasons_on_desktop() {
    let files: Vec<(String, String)> = (0..21)
        .map(|n| (format!("n{n:02}.md"), format!("Note {n}.\n")))
        .collect();
    let refs: Vec<(&str, &str)> = files
        .iter()
        .map(|(path, text)| (path.as_str(), text.as_str()))
        .collect();
    let f = opened_with(&refs);
    for (path, _) in &files {
        let id = note_id(&f.mocked, path);
        f.ok(
            "search_add_reason",
            json!({ "input": {
                "itemId": id, "itemType": "note", "itemTitle": path, "searchQuery": "q"
            } }),
        );
    }
    let reasons = f.ok("search_get_reasons", json!({}));
    let reasons = reasons.as_array().unwrap();
    assert_eq!(reasons.len(), 20);
    assert_eq!(reasons[0]["itemTitle"], "n20.md", "the newest first");
    assert!(
        reasons.iter().all(|reason| reason["itemTitle"] != "n00.md"),
        "the oldest past the cap is dropped"
    );
}
