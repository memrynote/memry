//! `tags_rename` through its command on a mock app over a real vault (#3530 13j-4): the note's
//! file takes the new name, and the renderer hears the progress, then `tags:renamed` and
//! `notes:tags-changed`; another rename recorded with notes left is refused with what finishes
//! it, and sends nothing, until that one is stopped.

use std::fs;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_core::crypto::sodium;
use memry_core::domain::tag_rename::{Holder, RenameJob};
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::locale::LocaleService;
use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::service::NotesService;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::seams::secure_store::{DeviceIdentityStore, KeyringStore, Store, StoreFactory};
use memry_desktop::session::{OpenSource, Session};
use memry_desktop::vault::consumer::{Applied, VaultTier};
use memry_desktop::vault::hash::content_hash;
use memry_tauri::commands::error::CommandError;
use memry_tauri::commands::tags::{
    RenameTagInput, RenameTagView, tags_rename, tags_rename_abandon, tags_rename_unfinished,
};
use memry_tauri::events::{NoteTagsChangedEvent, TagRenamedEvent, TagsProgressEvent};
use memry_tauri::shell::journal_events;
use tauri::test::{MockRuntime, mock_app};
use tauri::{App, Listener, Manager};
use tauri_specta::Event;

const WAIT: Duration = Duration::from_secs(25);

struct Keychain(Store);

impl StoreFactory for Keychain {
    fn build(&self) -> keyring_core::Result<Store> {
        Ok(self.0.clone())
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    vault: std::path::PathBuf,
    app: App<MockRuntime>,
    store: Arc<DeviceIdentityStore>,
    heard: Arc<Mutex<Vec<(&'static str, String)>>>,
}

/// An open vault holding one note tagged `work`, with the tag events heard in order.
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
    let index = NoteIndex::new(tier.clone(), |_| {}, |_| {}, |_| {});
    index.register(&session);
    let mut facts = tier.subscribe();
    session.open(&vault, OpenSource::Select).unwrap();
    let deadline = Instant::now() + WAIT;
    while !matches!(facts.try_recv(), Ok(Applied::Indexed { .. })) {
        assert!(Instant::now() < deadline, "the open walk did not end");
        std::thread::sleep(Duration::from_millis(20));
    }
    let notes = NotesService::new(tier, store.clone());
    let new = NewNoteFile {
        title: "Plan".into(),
        content: "About #work".into(),
        tags: vec!["work".into()],
        ..NewNoteFile::default()
    };
    notes.create(&session.current().unwrap(), new).unwrap();

    let app = mock_app();
    app.manage(session);
    app.manage(index);
    app.manage(store.clone());
    app.manage(notes);
    app.manage(Arc::new(LocaleService::new("en")));
    let heard = Arc::new(Mutex::new(Vec::new()));
    for name in [
        TagsProgressEvent::NAME,
        TagRenamedEvent::NAME,
        NoteTagsChangedEvent::NAME,
    ] {
        let sink = Arc::clone(&heard);
        app.listen_any(name, move |event| {
            sink.lock()
                .unwrap()
                .push((name, event.payload().to_owned()));
        });
    }
    Fixture {
        _dir: dir,
        vault,
        app,
        store,
        heard,
    }
}

impl Fixture {
    fn rename(&self, old: &str, new: &str) -> Result<RenameTagView, CommandError> {
        let input = RenameTagInput {
            old_name: old.into(),
            new_name: new.into(),
            run_id: Some("r1".into()),
        };
        tauri::async_runtime::block_on(tags_rename(self.app.handle().clone(), input))
    }

    fn heard(&self) -> Vec<(&'static str, String)> {
        std::mem::take(&mut *self.heard.lock().unwrap())
    }
}

#[test]
fn a_rename_through_the_command_writes_the_file_and_is_announced_after_its_progress() {
    let fixture = opened();
    let renamed = fixture.rename("work", "job").unwrap();
    assert_eq!(
        (
            renamed.affected_notes,
            renamed.failed_note_ids,
            renamed.body_skipped
        ),
        (1, Vec::new(), false)
    );
    let text = fs::read_to_string(fixture.vault.join("Plan.md")).unwrap();
    assert!(
        text.contains("  - job\n") && text.contains("About #job"),
        "{text}"
    );
    assert_eq!(
        fixture.heard(),
        [
            (
                TagsProgressEvent::NAME,
                r#"{"runId":"r1","done":1,"total":1}"#.to_owned()
            ),
            (
                TagRenamedEvent::NAME,
                r#"{"oldName":"work","newName":"job","affectedNotes":1}"#.to_owned()
            ),
            (NoteTagsChangedEvent::NAME, "null".to_owned()),
        ]
    );

    let long = "x".repeat(51);
    let refused = fixture.rename("job", &long).unwrap_err();
    assert_eq!(refused.code, "invalid");
    assert!(fixture.heard().is_empty());
}

#[test]
fn another_rename_left_unfinished_is_refused_with_what_finishes_it_until_it_is_stopped() {
    let fixture = opened();
    let store: Arc<dyn SecureStore> = fixture.store.clone();
    let open = fixture.app.state::<Session>().current().unwrap();
    let recorded = RenameJob {
        from: "old".into(),
        to: "new".into(),
        run_id: "earlier".into(),
    };
    let hub = open.vault.tag_hub(store).unwrap();
    let left = vec![Holder {
        id: "left".into(),
        day: false,
    }];
    assert_eq!(hub.rename_begin(&recorded, left).unwrap(), None);

    let refused = fixture.rename("work", "job").unwrap_err();
    assert_eq!(
        (refused.code.as_str(), refused.message.as_str()),
        (
            "tag_rename_unfinished",
            "Renaming #old to #new didn't finish for 1 note. Rename #old to #new again to finish it."
        )
    );
    assert!(fixture.heard().is_empty(), "a refused rename sends nothing");
    let text = fs::read_to_string(fixture.vault.join("Plan.md")).unwrap();
    assert!(text.contains("  - work\n"), "{text}");

    let handle = || fixture.app.handle().clone();
    let left = tauri::async_runtime::block_on(tags_rename_unfinished(handle())).unwrap();
    let left = left.expect("left unfinished");
    assert_eq!(
        (left.old_name.as_str(), left.new_name.as_str()),
        ("old", "new")
    );
    assert_eq!(left.left, 1);
    let named: Vec<(&str, &str)> = left
        .notes
        .iter()
        .map(|n| (n.id.as_str(), n.title.as_str()))
        .collect();
    assert_eq!(
        named,
        [("left", "left")],
        "a holder with no file is named by its id"
    );
    assert!(tauri::async_runtime::block_on(tags_rename_abandon(handle())).unwrap());
    assert!(
        fixture.heard().is_empty(),
        "a stop that renamed no record sends nothing"
    );
    assert!(!tauri::async_runtime::block_on(tags_rename_abandon(handle())).unwrap());
    assert_eq!(fixture.rename("work", "job").unwrap().affected_notes, 1);
}

/// Stopping a rename that wrote a note's file and not yet its record renames the record, and
/// tells the windows the tags changed. The stopped run's mark says the file's bytes now are the
/// ones it wrote.
#[test]
fn a_stop_that_renames_a_record_is_announced() {
    let fixture = opened();
    let store: Arc<dyn SecureStore> = fixture.store.clone();
    let open = fixture.app.state::<Session>().current().unwrap();
    let id = plan_id(&fixture);
    let hub = open.vault.tag_hub(store).unwrap();
    let job = RenameJob {
        from: "work".into(),
        to: "job".into(),
        run_id: "earlier".into(),
    };
    let holders = vec![Holder {
        id: id.clone(),
        day: false,
    }];
    assert_eq!(hub.rename_begin(&job, holders).unwrap(), None);
    let text = fs::read_to_string(fixture.vault.join("Plan.md")).unwrap();
    hub.rename_start(&id, "before", &content_hash(&text))
        .unwrap();

    let handle = fixture.app.handle().clone();
    assert!(tauri::async_runtime::block_on(tags_rename_abandon(handle)).unwrap());
    let heard: Vec<&str> = fixture.heard().into_iter().map(|(name, _)| name).collect();
    assert_eq!(heard, [NoteTagsChangedEvent::NAME]);
}

/// A note the rename's measure left to a pass tells the windows the tags changed once the pass
/// writes its row, as the note index calls `landed` then.
#[test]
fn a_renamed_note_left_to_a_pass_is_announced_when_its_row_lands() {
    let fixture = opened();
    let deadline = Instant::now() + WAIT;
    while !measured(&fixture) {
        assert!(Instant::now() < deadline, "the note was not measured");
        std::thread::sleep(Duration::from_millis(20));
    }
    journal_events::landed(fixture.app.handle(), &plan_id(&fixture));
    let heard: Vec<&str> = fixture.heard().into_iter().map(|(name, _)| name).collect();
    assert_eq!(heard, [NoteTagsChangedEvent::NAME]);
}

fn plan_id(fixture: &Fixture) -> String {
    let open = fixture.app.state::<Session>().current().unwrap();
    open.vault
        .note_files()
        .by_path("Plan.md")
        .unwrap()
        .unwrap()
        .note_id
}

/// The tag list read when the rename answers (the renderer's refetch on its events, through
/// `tags_get_all_with_counts`) counts the note under the new name alone: its header's last
/// measure is of the renamed file.
#[test]
fn the_tag_list_read_when_the_rename_answers_counts_the_new_name_alone() {
    let fixture = opened();
    let counts = || {
        let open = fixture.app.state::<Session>().current().unwrap();
        memry_desktop::tags::all_with_counts(&open)
            .unwrap()
            .into_iter()
            .map(|tag| (tag.name, tag.count))
            .collect::<Vec<_>>()
    };
    let deadline = Instant::now() + WAIT;
    while counts() != [("work".to_owned(), 1)] || !measured(&fixture) {
        assert!(
            Instant::now() < deadline,
            "the note was not read: {:?}",
            counts()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    fixture.rename("work", "job").unwrap();
    assert_eq!(counts(), [("job".to_owned(), 1)]);
}

/// Whether the index measured the bytes the note's row names.
fn measured(fixture: &Fixture) -> bool {
    let open = fixture.app.state::<Session>().current().unwrap();
    let row = open.vault.note_files().by_path("Plan.md").unwrap().unwrap();
    let stats = open.search.note_stats(&row.note_id).unwrap();
    row.content_hash.is_some() && stats.and_then(|s| s.file_hash) == row.content_hash
}
