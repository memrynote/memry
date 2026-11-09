//! `vault_locks_list` and `vault_locks_set` (#3531 14e-3) through the IPC a renderer calls, on a
//! mock app over a real vault, vault tier and note index: a lock change answers and sends
//! `VaultLocksChangedEvent` once, one that changes nothing sends nothing, a folder not on disk is
//! refused by its code, and an outside edit of a locked note sends
//! `VaultLocksExternalEditRestoredEvent` once the tier wrote the locked text back.

mod support;

use std::fs;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_desktop::vault::consumer::VaultTier;
use memry_tauri::events::{VaultLocksChangedEvent, VaultLocksExternalEditRestoredEvent};
use memry_tauri::shell::lock_events;
use serde_json::{Value, json};
use support::{Mocked, WAIT};
use tauri::test::MockRuntime;
use tauri::{Listener, Manager};
use tauri_specta::{Event, collect_commands};

const NOTE: &str = "The body.\n";

struct Fixture {
    mocked: Mocked,
    id: String,
    changed: Arc<Mutex<Vec<Value>>>,
    restored: Arc<Mutex<Vec<Value>>>,
}

fn heard(mocked: &Mocked, event: &str) -> Arc<Mutex<Vec<Value>>> {
    let payloads = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&payloads);
    mocked.webview.listen_any(event, move |event| {
        sink.lock()
            .unwrap()
            .push(serde_json::from_str(event.payload()).unwrap());
    });
    payloads
}

fn opened() -> Fixture {
    // As `registry::builder` lists them, with its error handling.
    let commands = tauri_specta::Builder::new()
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::vault_locks::vault_locks_list::<MockRuntime>,
            memry_tauri::commands::vault_locks::vault_locks_set::<MockRuntime>,
        ]);
    let mocked = Mocked::open(&[("Plan.md", NOTE), ("Archive/Old.md", NOTE)], commands);
    let tier = mocked.webview.state::<Arc<VaultTier>>().inner().clone();
    lock_events::forward(mocked.webview.app_handle().clone(), tier.subscribe());
    let id = mocked
        .session()
        .current()
        .unwrap()
        .vault
        .note_files()
        .by_path("Plan.md")
        .unwrap()
        .expect("a row for Plan.md")
        .note_id;
    let changed = heard(&mocked, VaultLocksChangedEvent::NAME);
    let restored = heard(&mocked, VaultLocksExternalEditRestoredEvent::NAME);
    Fixture {
        mocked,
        id,
        changed,
        restored,
    }
}

impl Fixture {
    fn set(&self, kind: &str, target: &str, locked: bool) -> Result<Value, Value> {
        let input = json!({ "kind": kind, "target": target, "locked": locked });
        self.mocked
            .invoke("vault_locks_set", json!({ "input": input }))
    }

    fn until(&self, what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + WAIT;
        while !done() {
            assert!(Instant::now() < deadline, "never: {what}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

#[test]
fn a_lock_change_answers_the_state_and_tells_every_window_once() {
    let f = opened();
    let locked = json!({ "notes": [f.id], "folders": ["Archive"] });

    f.set("note", &f.id, true).unwrap();
    assert_eq!(f.set("folder", "Archive/", true).unwrap(), locked);
    assert_eq!(
        f.mocked.invoke("vault_locks_list", json!({})).unwrap(),
        locked
    );
    let plan = f.mocked.vault.join("Plan.md");
    assert!(fs::metadata(&plan).unwrap().permissions().readonly());
    assert_eq!(f.set("note", &f.id, true).unwrap(), locked, "no change");
    f.set("folder", "Archive", false).unwrap();

    let told = f.changed.lock().unwrap().clone();
    assert_eq!(
        told,
        [
            json!({ "notes": [f.id], "folders": [] }),
            locked,
            json!({ "notes": [f.id], "folders": [] }),
        ]
    );
}

#[test]
fn a_folder_not_on_disk_or_a_note_not_there_is_refused_by_its_code() {
    let f = opened();
    let missing = f.set("folder", "Missing", true).unwrap_err();
    assert_eq!(missing["code"], "folder_not_found");
    let gone = f.set("note", "no-such-note", true).unwrap_err();
    assert_eq!(gone["code"], "not_found");
    assert!(f.changed.lock().unwrap().is_empty());
}

#[test]
fn an_outside_edit_of_a_locked_note_is_told_once_its_text_is_back() {
    let f = opened();
    f.set("note", &f.id, true).unwrap();
    // The watcher's start settles before the edit.
    std::thread::sleep(Duration::from_millis(300));
    let plan = f.mocked.vault.join("Plan.md");
    let mut permissions = fs::metadata(&plan).unwrap().permissions();
    #[allow(clippy::permissions_set_readonly_false)]
    permissions.set_readonly(false);
    fs::set_permissions(&plan, permissions).unwrap();
    fs::write(&plan, "Written outside the app.\n").unwrap();

    f.until("the notice", || !f.restored.lock().unwrap().is_empty());
    assert_eq!(fs::read_to_string(&plan).unwrap(), NOTE);
    assert_eq!(
        f.restored.lock().unwrap()[0],
        json!({ "noteId": f.id, "path": "Plan.md", "title": "Plan" })
    );
}
