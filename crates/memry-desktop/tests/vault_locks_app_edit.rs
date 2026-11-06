//! The app's edits of a locked note's file (Step 14e-2, Electron `assertNoteWritable` and
//! `keepLockedNoteTags`) over a real session, tier, watcher, `data.db` and vault files: a save
//! is refused as `note_locked` with Electron's text and leaves the file, the document and the
//! record; a lock taken while an edit reads refuses it before the file is written; a tag rename
//! or delete across notes leaves a locked note as it is and finishes for the others.

use memry_core::domain::tag_rename::RenameJob;
use memry_core::domain::vault_locks::TargetKind;
use memry_desktop::error::{FailureKind, map_core};
use memry_desktop::journal::write::NewDay;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::update::NoteUpdateInput;
use memry_desktop::notes::write_order::WriteOrder;
use memry_desktop::vault::app_edit::{AppEdit, Edited, Kept, OwnFiles, Precondition};
use memry_desktop::vault::consumer::ChangeSource;
use serde_json::json;

use crate::index_support::until;
use crate::notes_link_rewrite::{id_at, opened, row_hash};
use crate::notes_tag_rename::{note, path_of, record};
use crate::vault_env::Env;

const NOTE: &str = "---\ntags: [x]\n---\nThe body.\n";

fn lock(e: &Env, kind: TargetKind, target: &str) {
    e.core().locks().set(kind, target, true).unwrap();
}

fn save(id: &str, content: &str) -> NoteUpdateInput {
    NoteUpdateInput {
        id: id.to_owned(),
        content: Some(content.to_owned()),
        ..NoteUpdateInput::default()
    }
}

fn assert_note_locked(error: &NotesError) {
    let failure = map_core(error);
    assert_eq!(
        (failure.kind, failure.code),
        (FailureKind::Locked, "note_locked")
    );
    assert_eq!(failure.message, "The owner made this note read-only.");
}

#[test]
fn a_save_of_a_locked_note_or_of_one_in_a_locked_folder_is_refused_and_changes_nothing() {
    let (e, notes, _) = opened(&[("Plan.md", NOTE), ("Archive/Old.md", NOTE)]);
    let open = e.session.current().unwrap();
    let (plan, old) = (id_at(&e, "Plan.md"), id_at(&e, "Archive/Old.md"));
    lock(&e, TargetKind::Note, &plan);
    lock(&e, TargetKind::Folder, "Archive");
    let hashes = (row_hash(&e, &plan), row_hash(&e, &old));

    for (id, path) in [(&plan, "Plan.md"), (&old, "Archive/Old.md")] {
        let refused = notes.update(&open, save(id, "Rewritten.\n")).unwrap_err();
        assert_note_locked(&refused);
        // A frontmatter-only save feeds no body, so only the seam's own check stops it.
        let framing = NoteUpdateInput {
            id: id.to_owned(),
            frontmatter: Some(json!({ "coverFocus": 30 }).as_object().unwrap().clone()),
            ..NoteUpdateInput::default()
        };
        assert_note_locked(&notes.update(&open, framing).unwrap_err());
        assert_eq!(e.read(path), NOTE, "{path}");
        assert_eq!(e.body(id), "The body.", "{path}");
    }
    assert_eq!((row_hash(&e, &plan), row_hash(&e, &old)), hashes);

    e.core()
        .locks()
        .set(TargetKind::Note, &plan, false)
        .unwrap();
    notes.update(&open, save(&plan, "Rewritten.\n")).unwrap();
    assert_eq!(e.body(&plan), "Rewritten.");
}

#[test]
fn a_lock_taken_while_an_edit_reads_the_file_refuses_it_before_the_file_is_written() {
    let (e, _, store) = opened(&[("Plan.md", NOTE)]);
    let open = e.session.current().unwrap();
    let plan = id_at(&e, "Plan.md");
    let edit = AppEdit::new(&e.tier, &store, &open).unwrap();

    let edited = WriteOrder::default()
        .run(&plan, |turn| {
            edit.run(turn, Precondition::Held, ChangeSource::AppEdit, |text| {
                // Another window locks the note after the edit's own check.
                lock(&e, TargetKind::Note, &plan);
                Ok::<_, NotesError>(Some(text.replace("The body.", "Rewritten.")))
            })
        })
        .unwrap();

    assert_eq!(edited, Edited::Kept(Kept::Locked));
    assert_eq!(e.read("Plan.md"), NOTE, "the file was never written");
    assert_eq!(e.body(&plan), "The body.", "the document never took it");
}

#[test]
fn a_tag_rename_or_delete_leaves_a_locked_note_and_finishes_for_the_others() {
    let (e, notes, _) = opened(&[]);
    let open = e.session.current().unwrap();
    let held = note(&notes, &e, "Held", "Body #job.", &["job"]);
    let free = note(&notes, &e, "Free", "Body #job.", &["job"]);
    lock(&e, TargetKind::Note, &held);
    let before = e.read("Held.md");

    let job = RenameJob {
        from: "job".into(),
        to: "career".into(),
        run_id: "run".into(),
    };
    let renamed = notes.rename_tag(&open, &job, &mut |_, _| {}).unwrap();
    assert_eq!(renamed.written, vec![free.clone()]);
    assert_eq!(renamed.failed_note_ids, Vec::<String>::new());
    assert_eq!(
        e.read("Held.md"),
        before,
        "the locked file keeps the old tag"
    );
    assert_eq!(record(&e, &held, "tags"), ["job"]);
    assert_eq!(record(&e, &free, "tags"), ["career"]);

    let deleted = notes.delete_tag(&open, "job").unwrap();
    assert!(deleted.failed.is_empty(), "{:?}", deleted.failed);
    assert_eq!(e.read("Held.md"), before);
}

/// A rename that wrote a note's file and crashed before its record, then the note locked: the
/// record still takes the name its file holds, whether the rename is resumed or stopped
/// (14e-2 review). A lock never leaves a record that disagrees with its file.
#[test]
fn a_rename_crashed_after_a_write_gives_a_locked_note_the_name_its_file_holds() {
    for resume in [true, false] {
        let (e, notes, _) = opened(&[]);
        let open = e.session.current().unwrap();
        let ids = [
            note(&notes, &e, "One", "#a one", &["a"]),
            note(&notes, &e, "Two", "#a two", &["a"]),
        ];
        let job = RenameJob {
            from: "a".into(),
            to: "a/b".into(),
            run_id: "run".into(),
        };
        notes.crash_after_next_rename_write();
        let crashed = notes.rename_tag(&open, &job, &mut |_, _| {});
        assert!(matches!(crashed, Err(NotesError::Closed)), "{crashed:?}");
        let written = ids
            .iter()
            .find(|id| e.read(&path_of(&e, id)).contains("#a/b"))
            .expect("one file written");
        assert_eq!(record(&e, written, "tags"), ["a"]);
        lock(&e, TargetKind::Note, written);

        match resume {
            true => {
                notes.resume_tag_rename(&open, &|| false).unwrap();
            }
            false => {
                notes.abandon_tag_rename(&open).unwrap().expect("stopped");
            }
        }

        assert_eq!(record(&e, written, "tags"), ["a/b"], "resume: {resume}");
        assert!(e.core().tag_rename_recorded().unwrap().is_none());
    }
}

/// A stopped run's file edit that an outside edit replaced before the note locked never landed:
/// the record keeps what the file holds, not the rename (14e-2 review).
#[test]
fn a_crashed_renames_edit_an_outside_edit_replaced_leaves_a_locked_notes_record() {
    let (e, notes, _) = opened(&[]);
    let open = e.session.current().unwrap();
    let id = note(&notes, &e, "One", "#a one", &["a"]);
    let job = RenameJob {
        from: "a".into(),
        to: "a/b".into(),
        run_id: "run".into(),
    };
    notes.crash_after_next_rename_write();
    let crashed = notes.rename_tag(&open, &job, &mut |_, _| {});
    assert!(matches!(crashed, Err(NotesError::Closed)), "{crashed:?}");
    let path = path_of(&e, &id);
    let text = e.read(&path);
    e.write(
        &path,
        &text
            .replace("  - a/b\n", "  - a\n  - x\n")
            .replace("#a/b", "#a"),
    );
    until("the record took the outside edit", || {
        record(&e, &id, "tags") == ["a", "x"]
    });
    lock(&e, TargetKind::Note, &id);

    notes.resume_tag_rename(&open, &|| false).unwrap();

    assert_eq!(record(&e, &id, "tags"), ["a", "x"]);
    assert!(e.core().tag_rename_recorded().unwrap().is_none());
}

/// Days and notes with no file skip `AppEdit`; their record is the edit (14e-2 review). A merge
/// or delete leaves a locked day's tags, and taking a tag off it is refused.
#[test]
fn a_locked_day_keeps_its_tags_through_a_delete_and_refuses_a_removal() {
    let (e, notes, _) = opened(&[]);
    let open = e.session.current().unwrap();
    let day = NewDay {
        date: "2025-04-01".into(),
        content: "Walked".into(),
        tags: vec!["job".into()],
        ..NewDay::default()
    };
    let day = notes.create_day(&open, day).unwrap().id;
    lock(&e, TargetKind::Note, &day);

    assert_note_locked(&notes.remove_tag_from_note(&open, &day, "job").unwrap_err());
    let deleted = notes.delete_tag(&open, "job").unwrap();
    assert!(deleted.failed.is_empty(), "{:?}", deleted.failed);
    assert!(deleted.written.is_empty(), "{:?}", deleted.written);
    assert_eq!(record(&e, &day, "tags"), ["job"]);
}

/// A frontmatter-only save feeds nothing, so the core never asks the lock: the seam asks again
/// before the write (14e-2 review).
#[test]
fn a_lock_taken_while_a_frontmatter_only_save_reads_refuses_it_before_the_file_is_written() {
    let (e, _, store) = opened(&[("Plan.md", NOTE)]);
    let open = e.session.current().unwrap();
    let plan = id_at(&e, "Plan.md");
    let edit = AppEdit::new(&e.tier, &store, &open).unwrap();
    let own = OwnFiles::default();

    let edited = WriteOrder::default()
        .run(&plan, |turn| {
            edit.run(turn, Precondition::Save(&own), ChangeSource::Save, |text| {
                lock(&e, TargetKind::Note, &plan);
                Ok::<_, NotesError>(Some(text.replace("[x]", "[y]")))
            })
        })
        .unwrap();

    assert_eq!(edited, Edited::Kept(Kept::Locked));
    assert_eq!(e.read("Plan.md"), NOTE);
}
