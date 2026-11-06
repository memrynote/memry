//! Every local body writer refuses a locked note on a real `data.db` (Step 14e-2,
//! Electron `assertNoteWritable`): a block edit, a block moved in, a journal
//! day's edit and the app's own feed of a note file. Each refuses with
//! [`CrdtError::Locked`] before a log row or an outbox row is written, and
//! writes again once the lock is lifted.

#![cfg(feature = "markdown")]

use memry_core::crdt::body_edit::BlockEdit;
use memry_core::crdt::errors::CrdtError;
use memry_core::domain::body_write;
use memry_core::domain::external_feed::{FeedInput, FeedOutcome};
use memry_core::domain::journal_ops::body::edit_entry;
use memry_core::domain::vault_locks::TargetKind;
use memry_core::markdown::convert::api::Converter;

use crate::editor_support::{Fixture, fixture};

const DATE: &str = "2026-04-16";

fn paragraph(text: &str, id: &str) -> BlockEdit {
    BlockEdit::InsertParagraph {
        after_block_id: None,
        text: text.to_owned(),
        new_block_id: id.to_owned(),
    }
}

fn lock(f: &Fixture, kind: TargetKind, target: &str, locked: bool) {
    f.vault
        .locks()
        .set(kind, target, locked)
        .expect("the lock row");
}

fn locked(id: &str) -> CrdtError {
    CrdtError::Locked {
        note_id: id.to_owned(),
    }
}

/// `(log rows, outbox rows)` of `id`'s body.
fn written(f: &Fixture, id: &str) -> (usize, i64) {
    (f.local_blobs(id).len(), f.queued(id))
}

fn feed_app_edit(f: &Fixture, note: &str, markdown: &str) -> Result<FeedOutcome, CrdtError> {
    let input = FeedInput {
        note_id: note,
        markdown,
        note_path: None,
        writing: None,
        frontmatter: None,
        embeds: None,
    };
    f.vault
        .external_feed(f.store.clone())
        .expect("a feed")
        .feed_app_edit(&Converter::new(Default::default()), input, "before\n")
}

#[test]
fn a_locked_notes_block_edit_and_block_move_are_refused_before_anything_is_written() {
    let f = fixture();
    let note = f.note();
    assert!(
        f.writer
            .edit_block(note.clone(), paragraph("before", "b1"))
            .unwrap()
    );
    let snapshot = f
        .writer
        .block_snapshot(note.clone(), "b1".to_owned())
        .unwrap()
        .expect("a snapshot");
    lock(&f, TargetKind::Note, &note, true);
    let before = written(&f, &note);

    assert_eq!(
        f.writer.edit_block(note.clone(), paragraph("after", "b2")),
        Err(locked(&note))
    );
    assert_eq!(
        f.writer
            .append_block_snapshot(note.clone(), snapshot.clone()),
        Err(locked(&note))
    );
    assert_eq!(written(&f, &note), before, "no log row and no outbox row");

    lock(&f, TargetKind::Note, &note, false);
    assert!(
        f.writer
            .edit_block(note.clone(), paragraph("after", "b2"))
            .unwrap()
    );
    assert!(
        f.writer
            .append_block_snapshot(note.clone(), snapshot)
            .unwrap()
    );
}

/// Inbox filing's article append.
#[test]
fn a_locked_notes_markdown_append_is_refused_before_anything_is_written() {
    let f = fixture();
    let note = f.note();
    lock(&f, TargetKind::Note, &note, true);

    let appended = f.vault.db_handle().call_blocking(|conn| {
        Ok(body_write::append_markdown(
            conn,
            &note,
            "An article.\n",
            "device",
            1,
        ))
    });

    assert_eq!(appended.expect("the call"), Err(locked(&note)));
    assert_eq!(written(&f, &note), (0, 0));
}

#[test]
fn a_folder_lock_refuses_the_edit_of_a_note_filed_under_it_and_nothing_beside_it() {
    let f = fixture();
    let (inside, beside) = (f.note(), f.note());
    f.file(&inside, "Archive/2026/a.md");
    f.file(&beside, "Archive 2026/b.md");
    lock(&f, TargetKind::Folder, "Archive", true);

    assert_eq!(
        f.writer.edit_block(inside.clone(), paragraph("x", "b1")),
        Err(locked(&inside))
    );
    assert_eq!(written(&f, &inside), (0, 0));
    assert!(f.writer.edit_block(beside, paragraph("x", "b1")).unwrap());
}

#[test]
fn a_locked_journal_day_refuses_an_edit_before_anything_is_written() {
    let f = fixture();
    f.journal
        .edit_day(DATE.to_owned(), paragraph("morning", "b1"))
        .expect("the day takes the edit");
    let day = f
        .journal
        .entry_id(DATE.to_owned())
        .unwrap()
        .expect("the day is live");
    lock(&f, TargetKind::Note, &day, true);
    let before = written(&f, &day);

    assert_eq!(
        f.journal
            .edit_day(DATE.to_owned(), paragraph("evening", "b2")),
        Err(locked(&day))
    );
    assert_eq!(written(&f, &day), before);

    let entry = f.vault.db_handle().call_blocking(|conn| {
        Ok(edit_entry(
            conn,
            &day,
            &paragraph("noon", "b3"),
            "device",
            2,
        ))
    });
    assert_eq!(entry.expect("the call"), Err(locked(&day)));
    assert_eq!(written(&f, &day), before);

    lock(&f, TargetKind::Note, &day, false);
    assert!(
        f.journal
            .edit_day(DATE.to_owned(), paragraph("evening", "b2"))
            .expect("unlocked")
            .changed
    );
}

#[test]
fn the_apps_own_feed_of_a_locked_note_file_is_refused_before_anything_is_written() {
    let f = fixture();
    let note = f.note();
    assert_eq!(feed_app_edit(&f, &note, "before\n"), Ok(FeedOutcome::Fed));
    lock(&f, TargetKind::Note, &note, true);
    let before = written(&f, &note);

    assert_eq!(feed_app_edit(&f, &note, "after\n"), Err(locked(&note)));
    assert_eq!(written(&f, &note), before);
    assert_eq!(before, (1, 1), "the unlocked feed wrote and queued its row");
}

#[test]
fn the_refusal_says_electrons_fixed_text() {
    assert_eq!(
        locked("n1").to_string(),
        "The owner made this note read-only."
    );
}
