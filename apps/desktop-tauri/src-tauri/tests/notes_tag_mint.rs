//! `notes_create` and `notes_update` define a note's new tags before they send
//! `notes:tags-changed` (#4732), as Electron's `createNote` and `updateNote` call
//! `ensureTagDefinitions` first: the tag list the event makes the renderer read shows each new
//! tag in its definition's colour, never its name's default colour first. A mock app over a real
//! vault and vault tier with no note index, so no index pass mints for them.

use std::fs;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_core::crypto::sodium;
use memry_core::domain::tag_admin::default_color;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use memry_desktop::notes::update::{HeaderTagEditInput, NoteUpdateInput};
use memry_desktop::notes::view::NoteCreateInput;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, Session};
use memry_desktop::vault::consumer::{Applied, VaultTier};
use memry_tauri::commands::notes::{notes_create, notes_update};
use memry_tauri::events::NoteTagsChangedEvent;
use tauri::test::{MockRuntime, mock_app};
use tauri::{App, Listener, Manager};
use tauri_specta::Event;

#[allow(
    dead_code,
    reason = "its mock app runs a note index, whose pass would mint the tags too"
)]
mod support;
use support::MemoryStore;

const WAIT: Duration = Duration::from_secs(25);

/// The colour each tag's definition held, `None` for none, read as each `notes:tags-changed`
/// arrived.
type Heard = Arc<Mutex<Vec<Vec<Option<String>>>>>;

fn opened(tags: &'static [&'static str]) -> (tempfile::TempDir, App<MockRuntime>, Heard) {
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
    app.manage(NotesService::new(tier, store));
    let heard: Heard = Arc::default();
    let sink = Arc::clone(&heard);
    let handle = app.handle().clone();
    app.listen_any(NoteTagsChangedEvent::NAME, move |_| {
        let open = handle.state::<Session>().current().unwrap();
        let names = tags.iter().map(|tag| (*tag).to_owned()).collect();
        sink.lock()
            .unwrap()
            .push(open.search.tag_colors(names).unwrap());
    });
    (dir, app, heard)
}

/// The colours read at the first `notes:tags-changed` not yet taken.
fn next_heard(heard: &Heard) -> Vec<Option<String>> {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Some(colors) = heard.lock().unwrap().pop() {
            return colors;
        }
        assert!(Instant::now() < deadline, "no notes:tags-changed");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn some(color: &str) -> Option<String> {
    Some(color.to_owned())
}

#[test]
fn a_new_tag_is_defined_before_notes_tags_changed() {
    // Minted by how many live definitions came before (`PALETTE[live % 24]`): rose, pink,
    // fuchsia, purple; none of these names defaults to its mint's colour.
    let tags = &["Plan", "idea", "Draft", "later"];
    let (_dir, app, heard) = opened(tags);
    for (tag, mint) in tags.iter().zip(["rose", "pink", "fuchsia", "purple"]) {
        assert_ne!(default_color(tag), mint, "{tag}");
    }

    let input = NoteCreateInput {
        title: "Plan".into(),
        content: Some("About #idea".into()),
        folder: None,
        tags: Some(vec!["Plan".into()]),
        properties: None,
        emoji: None,
        template: None,
    };
    let note = tauri::async_runtime::block_on(notes_create(app.handle().clone(), input)).unwrap();
    assert_eq!(
        next_heard(&heard),
        [some("rose"), some("pink"), None, None],
        "the header tag, then the body's"
    );

    let input = NoteUpdateInput {
        id: note.id,
        content: Some("About #idea, #later".into()),
        header_tags: Some(HeaderTagEditInput {
            add: Some(vec!["Draft".into()]),
            ..HeaderTagEditInput::default()
        }),
        ..NoteUpdateInput::default()
    };
    tauri::async_runtime::block_on(notes_update(app.handle().clone(), input)).unwrap();
    assert_eq!(
        next_heard(&heard),
        [some("rose"), some("pink"), some("fuchsia"), some("purple")]
    );
}
