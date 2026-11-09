//! A note under an exclude pattern is read-only (#3530 13m-7b-3b), on a real vault and session:
//! every write the app makes to it is refused with `note_excluded` and changes nothing, through
//! three opens. Electron's index drops such a note, so these writes fail there with "Note not
//! found"; a tag rename across notes passes it by, as Electron's index-wide rename does.
//!
//! | Test                                                        | Rule                               |
//! | ----------------------------------------------------------- | ---------------------------------- |
//! | every app write to an excluded note is refused              | delete too; then writes land again |
//! | a tag change across notes leaves the excluded note          | its file and record keep the tag   |
//! | a folder holding an excluded note is not deleted            | no note goes, no delete syncs      |
//! | every write to an excluded day is refused                   | update, delete, a new day there    |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use memry_core::domain::tag_rename::RenameJob;
use memry_desktop::attachments::{AttachmentError, upload};
use memry_desktop::editor::versions;
use memry_desktop::error::CoreError;
use memry_desktop::journal::update::DayUpdate;
use memry_desktop::journal::write::NewDay;
use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::local_only;
use memry_desktop::notes::service::NotesService;
use memry_desktop::notes::update::NoteUpdateInput;
use memry_desktop::vault::config::VaultConfigPatch;
use serde_json::json;
use vault_env::{Env, indexed};

use crate::journal_folder::{daily, journal_vault, outbox, reopen, try_day};
use crate::notes_tag_rename::{opened as tagged_vault, record};
use crate::vault_settings::{opened_keeping, update};

const OLD: &str = "archive/old.md";

pub(crate) fn exclude(e: &mut Env, patterns: &[&str]) {
    let patch = VaultConfigPatch {
        exclude_patterns: Some(patterns.iter().map(|p| (*p).to_owned()).collect()),
        ..VaultConfigPatch::default()
    };
    update(e, patch, |_| {}).unwrap();
    e.facts_until(indexed);
}

fn excluded<T: std::fmt::Debug, E: CoreError + std::fmt::Display + std::fmt::Debug>(
    answer: Result<T, E>,
) {
    let error = answer.unwrap_err();
    assert_eq!(error.kind_and_code().1, "note_excluded", "{error:?}");
    assert_eq!(error.to_string(), "This note is in an excluded folder.");
}

#[test]
fn every_app_write_to_an_excluded_note_is_refused_and_changes_nothing() {
    let (mut e, store) = opened_keeping(json!({}), &[(OLD, "Old\n"), ("notes/new.md", "New\n")]);
    let notes = NotesService::new(e.tier.clone(), store);
    let old = e.rows().into_iter().find(|(_, at)| at == OLD).unwrap().0;
    assert!(
        e.core()
            .write_back()
            .keep_replaced(&old, "Earlier\n", "Earlier\n")
            .unwrap()
    );
    let open = e.session.current().unwrap();
    let version = versions::list(&open, &old).unwrap()[0].id.clone();
    drop(open);
    let rows = e.rows();
    exclude(&mut e, &["archive"]);

    let open = e.session.current().unwrap();
    let save = NoteUpdateInput {
        id: old.clone(),
        content: Some("Changed".to_owned()),
        ..NoteUpdateInput::default()
    };
    excluded(notes.update(&open, save));
    excluded(notes.rename(&open, &old, "Renamed"));
    excluded(notes.move_to_folder(&open, &old, "notes"));
    excluded(notes.delete(&open, &old, false));
    excluded(notes.delete(&open, &old, true));
    excluded(versions::restore(&notes, &open, &version));
    excluded(local_only::set(&open, &old, true, None));
    assert!(matches!(
        upload(&open, &old, "a.png", b"png"),
        Err(AttachmentError::Excluded)
    ));
    drop(open);

    for _ in 0..3 {
        reopen(&mut e);
    }
    assert_eq!(e.rows(), rows);
    assert_eq!(e.read(OLD), "Old\n");
    assert!(!outbox(&e, &old).contains(&"delete".to_owned()));
    assert!(!e.vault.join("attachments").join(&old).exists());
    assert_eq!(
        e.core()
            .note_files()
            .by_id(&old)
            .unwrap()
            .map(|f| f.local_only),
        Some(false)
    );

    exclude(&mut e, &[]);
    let open = e.session.current().unwrap();
    notes.delete(&open, &old, true).unwrap();
    assert!(!e.rows().iter().any(|(id, _)| *id == old));
}

#[test]
fn a_tag_change_across_notes_leaves_the_excluded_note() {
    let (mut e, notes, _store) = tagged_vault();
    let open = e.session.current().unwrap();
    let new_note = |title: &str, folder: Option<&str>| {
        let note = NewNoteFile {
            title: title.into(),
            content: "Body".into(),
            folder: folder.map(str::to_owned),
            tags: vec!["job".into()],
            ..NewNoteFile::default()
        };
        notes.create(&open, note).unwrap()
    };
    let kept = new_note("Old", Some("archive"));
    let renamed = new_note("New", None);
    let day = NewDay {
        date: "2025-01-02".into(),
        content: "A day".into(),
        tags: vec!["job".into()],
        ..NewDay::default()
    };
    let day = notes.create_day(&open, day).unwrap().id;
    drop(open);
    exclude(&mut e, &["archive", "journal"]);

    let job = RenameJob {
        from: "job".into(),
        to: "career".into(),
        run_id: "run".into(),
    };
    let open = e.session.current().unwrap();
    let done = notes.rename_tag(&open, &job, &mut |_, _| {}).unwrap();
    assert_eq!(done.failed_note_ids, Vec::<String>::new());
    // Finished: no plan waits on the excluded note, so the next tag change is not refused.
    assert!(e.core().tag_rename_recorded().unwrap().is_none());
    assert_eq!(record(&e, &renamed.id, "tags"), ["career"]);
    assert!(e.read(&renamed.path).contains("career"));
    let text = e.read(&kept.path);
    let day_text = e.read("journal/2025-01-02.md");
    let keeps_job = |e: &vault_env::Env| {
        assert_eq!(record(e, &kept.id, "tags"), ["job"]);
        assert_eq!(e.read(&kept.path), text);
        assert_eq!(record(e, &day, "tags"), ["job"]);
        assert_eq!(e.read("journal/2025-01-02.md"), day_text);
    };
    keeps_job(&e);
    assert!(!text.contains("career"));

    excluded(notes.remove_tag_from_note(&open, &kept.id, "job"));
    excluded(notes.remove_tag_from_note(&open, &day, "job"));
    let deleted = notes.delete_tag(&open, "job").unwrap();
    assert!(deleted.failed.is_empty(), "{:?}", deleted.failed);
    keeps_job(&e);
}

#[test]
fn every_write_to_an_excluded_day_is_refused() {
    let (mut e, notes) = journal_vault(daily("journal"), &[("journal/2025-01-02.md", "A day\n")]);
    exclude(&mut e, &["journal"]);
    let open = e.session.current().unwrap();
    let day = |content: Option<&str>, tags: Option<Vec<String>>| DayUpdate {
        date: "2025-01-02".into(),
        content: content.map(str::to_owned),
        tags,
        inline_tags: None,
        properties: None,
    };
    excluded(notes.update_day(&open, day(Some("Changed"), None)));
    excluded(notes.update_day(&open, day(None, Some(vec!["idea".into()]))));
    excluded(notes.delete_day(&open, "2025-01-02"));
    excluded(try_day(&notes, &e, "2025-01-03"));
    drop(open);
    reopen(&mut e);
    assert_eq!(e.read("journal/2025-01-02.md"), "A day\n");
    assert!(!e.vault.join("journal/2025-01-03.md").exists());
    let id = e
        .rows()
        .into_iter()
        .find(|(_, at)| at == "journal/2025-01-02.md");
    assert!(!outbox(&e, &id.unwrap().0).contains(&"delete".to_owned()));
}

#[test]
fn a_folder_holding_an_excluded_note_is_not_deleted() {
    let inner = "projects/archive/old.md";
    let files = [(inner, "Old\n"), ("projects/plan.md", "Plan\n")];
    let (mut e, store) = opened_keeping(json!({}), &files);
    let notes = NotesService::with_trash(e.tier.clone(), store, |_| {
        panic!("a refused delete trashes nothing")
    });
    let rows = e.rows();
    exclude(&mut e, &["archive"]);

    let open = e.session.current().unwrap();
    excluded(notes.delete_folder(&open, "projects"));
    drop(open);
    reopen(&mut e);
    assert_eq!(e.rows(), rows);
    assert_eq!(e.read(inner), "Old\n");
    for (id, _) in &rows {
        assert!(!outbox(&e, id).contains(&"delete".to_owned()));
    }
}
