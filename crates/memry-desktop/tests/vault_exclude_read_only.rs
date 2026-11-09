//! A note under an exclude pattern is read-only (#3530 13m-7b-3b), on a real vault and session:
//! every write the app makes to it is refused with `note_excluded` and changes nothing, through
//! three opens. Electron's index drops such a note, so these writes fail there with "Note not
//! found"; a tag rename across notes passes it by, as Electron's index-wide rename does.
//!
//! | Test                                                        | Rule                               |
//! | ----------------------------------------------------------- | ---------------------------------- |
//! | every app write to an excluded note is refused              | delete too; then writes land again |
//! | a tag rename across notes leaves the excluded note          | its file and record keep the tag   |
//! | an excluded day refuses an update                           | a tags-only update as well         |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use memry_core::domain::tag_rename::RenameJob;
use memry_desktop::attachments::{AttachmentError, upload};
use memry_desktop::error::CoreError;
use memry_desktop::journal::update::DayUpdate;
use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::service::NotesService;
use memry_desktop::notes::update::NoteUpdateInput;
use memry_desktop::vault::config::VaultConfigPatch;
use serde_json::json;
use vault_env::{Env, indexed};

use crate::journal_folder::{daily, journal_vault, outbox, reopen};
use crate::notes_tag_rename::{opened as tagged_vault, record};
use crate::vault_settings::{opened_keeping, update};

const OLD: &str = "archive/old.md";

fn exclude(e: &mut Env, patterns: &[&str]) {
    let patch = VaultConfigPatch {
        exclude_patterns: Some(patterns.iter().map(|p| (*p).to_owned()).collect()),
        ..VaultConfigPatch::default()
    };
    update(e, patch, |_| {}).unwrap();
    e.facts_until(indexed);
}

fn excluded<T: std::fmt::Debug>(answer: Result<T, NotesError>) {
    let error = answer.unwrap_err();
    assert_eq!(error.kind_and_code().1, "note_excluded", "{error:?}");
    assert_eq!(error.to_string(), "This note is in an excluded folder.");
}

#[test]
fn every_app_write_to_an_excluded_note_is_refused_and_changes_nothing() {
    let (mut e, store) = opened_keeping(json!({}), &[(OLD, "Old\n"), ("notes/new.md", "New\n")]);
    let notes = NotesService::new(e.tier.clone(), store);
    let old = e.rows().into_iter().find(|(_, at)| at == OLD).unwrap().0;
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

    exclude(&mut e, &[]);
    let open = e.session.current().unwrap();
    notes.delete(&open, &old, true).unwrap();
    assert!(!e.rows().iter().any(|(id, _)| *id == old));
}

#[test]
fn a_tag_rename_across_notes_leaves_the_excluded_note() {
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
    drop(open);
    exclude(&mut e, &["archive"]);

    let job = RenameJob {
        from: "job".into(),
        to: "career".into(),
        run_id: "run".into(),
    };
    let open = e.session.current().unwrap();
    notes.rename_tag(&open, &job, &mut |_, _| {}).unwrap();
    assert_eq!(record(&e, &renamed.id, "tags"), ["career"]);
    assert!(e.read(&renamed.path).contains("career"));
    assert_eq!(record(&e, &kept.id, "tags"), ["job"]);
    assert!(e.read(&kept.path).contains("job"));
    assert!(!e.read(&kept.path).contains("career"));
}

#[test]
fn an_excluded_day_refuses_an_update() {
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
    assert_eq!(e.read("journal/2025-01-02.md"), "A day\n");
}
