//! `tags_rename` through its command on a mock app over a real vault (#3530 13j-4): the note's
//! file takes the new name, and the renderer hears the progress, then `tags:renamed` and
//! `notes:tags-changed`; another rename recorded with notes left is refused with what finishes
//! it, and sends nothing, until that one is stopped. `tags_merge`, `tags_delete` and
//! `tags_remove_from_note` the same way (#3530 13j-4d): the file takes the edit, and the renderer
//! hears `tags:deleted` or `tags:notes-changed`, then `notes:tags-changed`.

use std::fs;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_core::crypto::sodium;
use memry_core::domain::tag_rename::{Holder, RenameJob};
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::journal::write::NewDay;
use memry_desktop::locale::LocaleService;
use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::error::NotesError;
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
    RenameTagInput, RenameTagView, tag_change_failed, tags_rename, tags_rename_abandon,
    tags_rename_unfinished,
};
use memry_tauri::commands::tags_retag::{
    MergeTagInput, RemoveTagFromNoteInput, tags_delete, tags_merge, tags_remove_from_note,
};
use memry_tauri::events::{
    JournalExternalChangeEvent, NoteTagsChangedEvent, TagDeletedEvent, TagNotesChangedEvent,
    TagRenamedEvent, TagsProgressEvent,
};
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
        TagDeletedEvent::NAME,
        TagNotesChangedEvent::NAME,
        NoteTagsChangedEvent::NAME,
        JournalExternalChangeEvent::NAME,
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

/// Whether the index measured the bytes the note `Plan`'s row names.
fn measured(fixture: &Fixture) -> bool {
    measured_at(fixture, "Plan.md")
}

/// Whether the index measured the bytes the row of the note at `path` names.
fn measured_at(fixture: &Fixture, path: &str) -> bool {
    let open = fixture.app.state::<Session>().current().unwrap();
    let row = open.vault.note_files().by_path(path).unwrap().unwrap();
    let stats = open.search.note_stats(&row.note_id).unwrap();
    row.content_hash.is_some() && stats.and_then(|s| s.file_hash) == row.content_hash
}

/// The open vault's tags and their counts, as the renderer's refetch on the events reads them,
/// once a note `Bare` tagged `bare` in its header alone, its body carrying no `#tag`, is read.
/// Its header's last measure counts `bare` until the index measures the file again, so a list
/// read after a command that did not measure it would still count `bare`.
fn bare(fixture: &Fixture) -> impl Fn() -> Vec<(String, u32)> + '_ {
    let notes = fixture.app.state::<Arc<NotesService>>();
    let new = NewNoteFile {
        title: "Bare".into(),
        content: "Plain".into(),
        tags: vec!["bare".into()],
        ..NewNoteFile::default()
    };
    let open = fixture.app.state::<Session>().current().unwrap();
    notes.create(&open, new).unwrap();
    let counts = move || {
        let open = fixture.app.state::<Session>().current().unwrap();
        memry_desktop::tags::all_with_counts(&open)
            .unwrap()
            .into_iter()
            .map(|tag| (tag.name, tag.count))
            .collect::<Vec<_>>()
    };
    let read = [("bare".to_owned(), 1), ("work".to_owned(), 1)];
    let deadline = Instant::now() + WAIT;
    while counts() != read || !measured_at(fixture, "Bare.md") {
        assert!(Instant::now() < deadline, "not read: {:?}", counts());
        std::thread::sleep(Duration::from_millis(20));
    }
    fixture.heard();
    counts
}

/// A merge writes the header, answers the items it moved, and sends `tags:deleted` for the tag
/// that went, then `notes:tags-changed`; the tag list read then counts the target alone.
#[test]
fn a_merge_through_the_command_is_announced_and_counted_under_the_target() {
    let fixture = opened();
    let counts = bare(&fixture);
    let input = MergeTagInput {
        source: "Bare".into(),
        target: "job".into(),
    };
    let handle = fixture.app.handle().clone();
    let merged = tauri::async_runtime::block_on(tags_merge(handle, input)).unwrap();
    assert_eq!(merged.affected_items, 1);
    assert!(merged.failed_notes.is_empty());
    let text = fs::read_to_string(fixture.vault.join("Bare.md")).unwrap();
    assert!(text.contains("  - job\n"), "{text}");
    assert_eq!(
        fixture.heard(),
        [
            (
                TagDeletedEvent::NAME,
                r#"{"tag":"bare","affectedNotes":1}"#.to_owned()
            ),
            (NoteTagsChangedEvent::NAME, "null".to_owned()),
        ]
    );
    assert_eq!(counts(), [("job".to_owned(), 1), ("work".to_owned(), 1)]);
}

/// A merge into another spelling of the tag is refused in Electron's words, and sends nothing.
#[test]
fn a_merge_into_the_same_tag_is_refused_in_electrons_words() {
    let fixture = opened();
    let input = MergeTagInput {
        source: "work".into(),
        target: " WORK".into(),
    };
    let handle = fixture.app.handle().clone();
    let refused = tauri::async_runtime::block_on(tags_merge(handle, input)).unwrap_err();
    assert_eq!(
        (refused.code.as_str(), refused.message.as_str()),
        ("tag_merge_same_tag", "Source and target tags are the same")
    );
    assert!(fixture.heard().is_empty());
}

/// A delete takes the tag off the header, answers the notes it wrote, and sends `tags:deleted`,
/// then `notes:tags-changed`; the tag list read then leaves the tag out. A body's `#tag` stays,
/// as Electron's header write-back leaves it.
#[test]
fn a_delete_through_the_command_is_announced_and_leaves_no_count() {
    let fixture = opened();
    let counts = bare(&fixture);
    let handle = fixture.app.handle().clone();
    let deleted = tauri::async_runtime::block_on(tags_delete(handle, "bare".into())).unwrap();
    assert_eq!(deleted.affected_notes, 1);
    let text = fs::read_to_string(fixture.vault.join("Bare.md")).unwrap();
    assert!(!text.contains("bare"), "{text}");
    assert_eq!(
        fixture.heard(),
        [
            (
                TagDeletedEvent::NAME,
                r#"{"tag":"bare","affectedNotes":1}"#.to_owned()
            ),
            (NoteTagsChangedEvent::NAME, "null".to_owned()),
        ]
    );
    assert_eq!(counts(), [("work".to_owned(), 1)]);
    let handle = fixture.app.handle().clone();
    tauri::async_runtime::block_on(tags_delete(handle, "work".into())).unwrap();
    let text = fs::read_to_string(fixture.vault.join("Plan.md")).unwrap();
    assert!(
        !text.contains("  - work\n") && text.contains("About #work"),
        "{text}"
    );
}

/// Taking the tag off one note writes its header and sends `tags:notes-changed` (`removed`),
/// then `notes:tags-changed`.
#[test]
fn a_removal_from_a_note_through_the_command_is_announced() {
    let fixture = opened();
    let id = plan_id(&fixture);
    let input = RemoveTagFromNoteInput {
        note_id: id.clone(),
        tag: "work".into(),
    };
    let handle = fixture.app.handle().clone();
    tauri::async_runtime::block_on(tags_remove_from_note(handle, input)).unwrap();
    let text = fs::read_to_string(fixture.vault.join("Plan.md")).unwrap();
    assert!(!text.contains("  - work\n"), "{text}");
    let removed = format!(r#"{{"tag":"work","noteId":"{id}","action":"removed"}}"#);
    assert_eq!(
        fixture.heard(),
        [
            (TagNotesChangedEvent::NAME, removed),
            (NoteTagsChangedEvent::NAME, "null".to_owned()),
        ]
    );
}

/// A tag change refused while a merge, delete or removal runs says so in the window's language,
/// not as a rename of names it does not know.
#[test]
fn a_tag_change_refused_while_another_runs_says_so() {
    let fixture = opened();
    let refused = tag_change_failed(fixture.app.handle(), &NotesError::TagEditInProgress);
    assert_eq!(
        (refused.code.as_str(), refused.message.as_str()),
        (
            "tag_edit_in_progress",
            "Another tag change is still running. Try again when it finishes."
        )
    );
}

/// A note whose file cannot take the delete is answered in `failedNoteIds`, so the window can
/// say it kept the tag.
#[test]
fn a_note_the_delete_cannot_write_is_answered() {
    let fixture = opened();
    let id = plan_id(&fixture);
    let path = fixture.vault.join("Plan.md");
    let broken = fs::read_to_string(&path)
        .unwrap()
        .replacen("---\n", "---\n: [\n", 1);
    fs::write(&path, &broken).unwrap();
    let open = fixture.app.state::<Session>().current().unwrap();
    let deadline = Instant::now() + WAIT;
    while open
        .vault
        .note_files()
        .by_path("Plan.md")
        .unwrap()
        .unwrap()
        .content_hash
        != Some(content_hash(&broken))
    {
        assert!(Instant::now() < deadline, "the outside edit was not read");
        std::thread::sleep(Duration::from_millis(20));
    }
    let handle = fixture.app.handle().clone();
    let deleted = tauri::async_runtime::block_on(tags_delete(handle, "work".into())).unwrap();
    let kept: Vec<(String, String)> = deleted
        .failed_notes
        .into_iter()
        .map(|note| (note.id, note.title))
        .collect();
    assert_eq!(kept, [(id, "Plan".to_owned())]);
    assert!(
        !deleted.retry_finishes,
        "broken frontmatter needs fixing first"
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), broken);
}

/// A journal day tagged `work`, its counts measured, the events heard so far dropped.
fn day(fixture: &Fixture) -> String {
    let notes = fixture.app.state::<Arc<NotesService>>();
    let open = fixture.app.state::<Session>().current().unwrap();
    let new = NewDay {
        date: "2025-04-01".into(),
        content: "Walked".into(),
        tags: vec!["work".into()],
        ..NewDay::default()
    };
    let id = notes.create_day(&open, new).unwrap().id;
    let deadline = Instant::now() + WAIT;
    while open
        .search
        .note_stats(&id)
        .unwrap()
        .and_then(|row| row.date)
        .is_none()
    {
        assert!(Instant::now() < deadline, "the day was not measured");
        std::thread::sleep(Duration::from_millis(20));
    }
    fixture.heard();
    id
}

fn day_changed(fixture: &Fixture) -> bool {
    let changed = r#"{"date":"2025-04-01","type":"modified"}"#;
    fixture
        .heard()
        .iter()
        .any(|(name, payload)| *name == JournalExternalChangeEvent::NAME && payload == changed)
}

/// A delete, a merge or a rename changes a day's record alone, so the open day hears its
/// change: a page still holding the old tags would write them back on its next tag edit.
#[test]
fn a_day_a_tag_change_wrote_is_told_its_change() {
    let fixture = opened();
    day(&fixture);
    fixture.rename("work", "job").unwrap();
    assert!(day_changed(&fixture), "rename");
    let input = MergeTagInput {
        source: "job".into(),
        target: "career".into(),
    };
    let handle = fixture.app.handle().clone();
    tauri::async_runtime::block_on(tags_merge(handle, input)).unwrap();
    assert!(day_changed(&fixture), "merge");
    let handle = fixture.app.handle().clone();
    tauri::async_runtime::block_on(tags_delete(handle, "career".into())).unwrap();
    assert!(day_changed(&fixture), "delete");
}
