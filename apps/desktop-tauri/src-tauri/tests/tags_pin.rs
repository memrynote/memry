//! `tags_pin_note_to_tag` and `tags_unpin_note_from_tag` through their commands on a mock app
//! over a real vault (#3530 13j-2): the record's pin, Electron's failure wording, and the
//! `TagNotesChangedEvent` each answered pin sends.

use std::fs;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_core::crypto::sodium;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::locale::LocaleService;
use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::seams::secure_store::{DeviceIdentityStore, KeyringStore, Store, StoreFactory};
use memry_desktop::session::{OpenSource, Session};
use memry_desktop::tags::notes_by_tag;
use memry_desktop::tags::view::NotesByTagInput;
use memry_desktop::vault::consumer::{Applied, VaultTier};
use memry_tauri::commands::error::CommandError;
use memry_tauri::commands::tags::{tags_pin_note_to_tag, tags_unpin_note_from_tag};
use memry_tauri::events::TagNotesChangedEvent;
use tauri::test::{MockRuntime, mock_app};
use tauri::{App, Listener, Manager};
use tauri_specta::Event;

const WAIT: Duration = Duration::from_secs(25);

/// One in-memory keychain, shared by every build.
struct Keychain(Store);

impl StoreFactory for Keychain {
    fn build(&self) -> keyring_core::Result<Store> {
        Ok(self.0.clone())
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    app: App<MockRuntime>,
    note: String,
    heard: Arc<Mutex<Vec<String>>>,
}

/// An open vault holding one note tagged `work`, with every `TagNotesChangedEvent` heard.
fn opened() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("vault");
    fs::create_dir_all(&vault).unwrap();
    fs::create_dir_all(dir.path().join("app")).unwrap();
    let keychain = Keychain(keyring_core::mock::Store::new().unwrap());
    let keyring = Arc::new(KeyringStore::with_factory(keychain, None, WAIT));
    let store = Arc::new(DeviceIdentityStore::with_probe(
        &keyring,
        dir.path(),
        || false,
    ));
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
    let open = session.current().unwrap();
    let new = NewNoteFile {
        title: "Plan".into(),
        content: "About the plan".into(),
        tags: vec!["work".into()],
        ..NewNoteFile::default()
    };
    let note = NotesService::new(tier, store.clone())
        .create(&open, new)
        .unwrap()
        .id;

    let app = mock_app();
    app.manage(session);
    app.manage(store);
    app.manage(Arc::new(LocaleService::new("en")));
    let heard = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&heard);
    app.listen_any(TagNotesChangedEvent::NAME, move |event| {
        sink.lock().unwrap().push(event.payload().to_owned());
    });
    Fixture {
        _dir: dir,
        app,
        note,
        heard,
    }
}

impl Fixture {
    fn pin(&self, note: &str, tag: &str, pinned: bool) -> Result<(), CommandError> {
        let (app, note, tag) = (self.app.handle().clone(), note.into(), tag.into());
        if pinned {
            tauri::async_runtime::block_on(tags_pin_note_to_tag(app, note, tag))
        } else {
            tauri::async_runtime::block_on(tags_unpin_note_from_tag(app, note, tag))
        }
    }

    /// The payloads heard since the last call.
    fn heard(&self) -> Vec<String> {
        std::mem::take(&mut *self.heard.lock().unwrap())
    }

    fn pinned(&self) -> Vec<String> {
        let open = self.app.state::<Session>().current().unwrap();
        let input = NotesByTagInput {
            tag: "work".into(),
            sort_by: None,
            sort_order: None,
            include_descendants: None,
        };
        let view = notes_by_tag(&open, &input).unwrap();
        view.pinned_notes.into_iter().map(|note| note.id).collect()
    }
}

#[test]
fn a_pin_through_the_command_reaches_the_tag_and_every_answered_pin_is_announced() {
    let fixture = opened();
    let note = fixture.note.clone();
    let event = |action: &str| format!(r#"{{"tag":"Work","noteId":"{note}","action":"{action}"}}"#);

    fixture.pin(&note, "Work", true).unwrap();
    assert_eq!(fixture.pinned(), std::slice::from_ref(&note));
    assert_eq!(fixture.heard(), [event("pinned")]);
    fixture.pin(&note, "Work", true).unwrap();
    assert_eq!(
        fixture.heard(),
        [event("pinned")],
        "a pin that changed nothing"
    );

    fixture.pin(&note, "Work", false).unwrap();
    assert!(fixture.pinned().is_empty());
    assert_eq!(fixture.heard(), [event("unpinned")]);

    let refused = fixture.pin(&note, "elsewhere", true).unwrap_err();
    assert_eq!(
        (refused.code.as_str(), refused.message.as_str()),
        ("invalid", "Failed to pin note")
    );
    let missing = fixture.pin("no-such-note", "Work", false).unwrap_err();
    assert_eq!(missing.message, "Failed to unpin note");
    assert!(fixture.heard().is_empty(), "a failed pin sends nothing");
}
