//! `notes_rename`, `notes_reorder` and `notes_get_all_positions` through their commands on a
//! mock app over a real vault and vault tier (#3530 13g), and the `NoteRenamedEvent` a rename's
//! row fact sends through the shell's note events.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_core::api::errors::SecureStoreError;
use memry_core::crypto::sodium;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, Session};
use memry_desktop::vault::consumer::{Applied, VaultTier};
use memry_tauri::commands::notes::{notes_get_all_positions, notes_rename, notes_reorder};
use memry_tauri::events::NoteRenamedEvent;
use memry_tauri::shell::note_events;
use serde_json::{Value, json};
use tauri::test::{MockRuntime, mock_app};
use tauri::{App, Listener, Manager};
use tauri_specta::Event;

const WAIT: Duration = Duration::from_secs(25);

#[derive(Default)]
struct MemoryStore(Mutex<HashMap<SecureStoreKey, Vec<u8>>>);

impl SecureStore for MemoryStore {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        Ok(self.0.lock().unwrap().get(&key).cloned())
    }

    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().insert(key, value);
        Ok(())
    }

    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().remove(&key);
        Ok(())
    }

    fn clear(&self) -> Result<(), SecureStoreError> {
        self.0.lock().unwrap().clear();
        Ok(())
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    vault: PathBuf,
    app: App<MockRuntime>,
    notes: Arc<NotesService>,
    renamed: Arc<Mutex<Vec<Value>>>,
}

/// An open vault with its first walk done, its tier's note events forwarded, and every
/// `NoteRenamedEvent` heard.
fn opened() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("vault");
    fs::create_dir_all(&vault).unwrap();
    fs::create_dir_all(dir.path().join("app")).unwrap();
    let store: Arc<dyn SecureStore> = Arc::new(MemoryStore::default());
    let (_, secret) = sodium::sign_seed_keypair(&[7u8; 32]).unwrap();
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .unwrap();
    let config = AppConfig::load(dir.path().join("app/memry-config.json"));
    let session = Session::new(VaultRegistry::new(Arc::new(config)));
    let tier = VaultTier::new(store.clone());
    tier.set_identity(NotesIdentity::new(store.clone()));
    tier.register(&session);
    let mut facts = tier.subscribe();
    session.open(&vault, OpenSource::Select).unwrap();
    let deadline = Instant::now() + WAIT;
    while !matches!(facts.try_recv(), Ok(Applied::Indexed { .. })) {
        assert!(Instant::now() < deadline, "the open walk did not end");
        std::thread::sleep(Duration::from_millis(20));
    }

    let app = mock_app();
    app.manage(session);
    let notes = NotesService::new(tier.clone(), store);
    app.manage(notes.clone());
    note_events::forward(app.handle().clone(), tier.subscribe());
    let renamed = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&renamed);
    app.listen_any(NoteRenamedEvent::NAME, move |event| {
        let payload = serde_json::from_str(event.payload()).unwrap();
        sink.lock().unwrap().push(payload);
    });
    Fixture {
        _dir: dir,
        vault,
        app,
        notes,
        renamed,
    }
}

impl Fixture {
    fn create(&self, title: &str, folder: &str) -> String {
        let open = self.app.state::<Session>().current().unwrap();
        let note = NewNoteFile {
            title: title.into(),
            content: format!("About {title}"),
            folder: Some(folder.into()),
            ..NewNoteFile::default()
        };
        self.notes.create(&open, note).unwrap().id
    }

    fn rename(&self, id: &str, title: &str) -> Result<(String, String), String> {
        let call = notes_rename(self.app.handle().clone(), id.into(), title.into());
        tauri::async_runtime::block_on(call)
            .map(|note| (note.path, note.title))
            .map_err(|error| error.code)
    }

    fn reorder(&self, folder: &str, paths: &[&str]) {
        let paths = paths.iter().map(|path| (*path).to_owned()).collect();
        let call = notes_reorder(self.app.handle().clone(), folder.into(), paths);
        tauri::async_runtime::block_on(call).unwrap();
    }

    fn positions(&self) -> BTreeMap<String, i64> {
        tauri::async_runtime::block_on(notes_get_all_positions(self.app.handle().clone())).unwrap()
    }

    /// The next `NoteRenamedEvent` heard.
    fn next_renamed(&self) -> Value {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(event) = self.renamed.lock().unwrap().pop() {
                return event;
            }
            assert!(Instant::now() < deadline, "no NoteRenamedEvent");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

#[test]
fn a_rename_answers_the_note_and_sends_notes_renamed_with_the_new_title() {
    let f = opened();
    let id = f.create("Plan", "work");

    // `:` is a character no file name holds; the title keeps it.
    assert_eq!(
        f.rename(&id, "Plan: Q3"),
        Ok(("work/Plan Q3.md".into(), "Plan: Q3".into()))
    );
    assert!(f.vault.join("work/Plan Q3.md").exists());
    let event = json!({
        "id": id, "oldPath": "work/Plan.md", "newPath": "work/Plan Q3.md",
        "oldTitle": "Plan", "newTitle": "Plan: Q3",
    });
    assert_eq!(f.next_renamed(), event);

    // A rename that changes only case respells the file in place; the renderer's tab title
    // follows the event.
    let lower = f.create("draft", "");
    assert_eq!(
        f.rename(&lower, "Draft"),
        Ok(("Draft.md".into(), "Draft".into()))
    );
    let event = json!({
        "id": lower, "oldPath": "draft.md", "newPath": "Draft.md",
        "oldTitle": "draft", "newTitle": "Draft",
    });
    assert_eq!(f.next_renamed(), event);

    // A title the file's name already says moves nothing, and still sends the new title.
    let ab = f.create("ab", "");
    assert_eq!(f.rename(&ab, "a/b"), Ok(("ab.md".into(), "a/b".into())));
    let event = json!({
        "id": ab, "oldPath": "ab.md", "newPath": "ab.md", "oldTitle": "ab", "newTitle": "a/b",
    });
    assert_eq!(f.next_renamed(), event);

    assert_eq!(f.rename(&ab, ""), Err("invalid_title".into()));
    assert_eq!(f.rename("missing", "X"), Err("note_not_found".into()));
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(*f.renamed.lock().unwrap(), Vec::<Value>::new());
}

#[test]
fn a_reorder_sets_the_slots_and_a_rename_carries_its_slot() {
    let f = opened();
    let a = f.create("A", "");
    f.create("B", "");
    f.create("C", "work");
    assert_eq!(f.positions(), BTreeMap::new());

    f.reorder("", &["B.md", "A.md"]);
    f.reorder("work", &["work/C.md"]);
    let slots = |pairs: &[(&str, i64)]| -> BTreeMap<String, i64> {
        pairs
            .iter()
            .map(|(path, slot)| ((*path).into(), *slot))
            .collect()
    };
    assert_eq!(
        f.positions(),
        slots(&[("A.md", 1), ("B.md", 0), ("work/C.md", 0)])
    );

    f.rename(&a, "Alpha").unwrap();
    assert_eq!(
        f.positions(),
        slots(&[("Alpha.md", 1), ("B.md", 0), ("work/C.md", 0)])
    );
}
