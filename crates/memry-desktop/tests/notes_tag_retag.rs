//! A tag merged or deleted across the vault, and taken off one note (`NotesService::merge_tag`,
//! `delete_tag`, `remove_tag_from_note`), through the vault tier as the app runs them.

use crate::notes_tag_rename::{
    clear_outbox, hub, measured, note, opened, path_of, record, upserts,
};
use std::sync::Arc;

use crate::vault_env::{Env, QUIET};
use memry_core::api::errors::StorageError;
use memry_core::domain::tag_rename::{Holder, RenameJob};
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::journal::write::NewDay;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::service::NotesService;
use memry_desktop::notes::tag_retag::KeptNote;
use memry_desktop::vault::consumer::{Applied, ChangeSource};

/// A note `Plan` with the tag, its child and a body `#tag`, a note `Both` holding the target
/// already with a pin on the tag, a day, and a file found outside with the tag in its header
/// only: each measured, the outbox cleared.
fn vault(notes: &NotesService, e: &mut Env, store: &Arc<dyn SecureStore>) -> [String; 4] {
    let plan = note(notes, e, "Plan", "Met #job here", &["job", "job/lead"]);
    let both = note(notes, e, "Both", "Plain", &["Work", "job"]);
    let open = e.session.current().unwrap();
    assert!(hub(e, store).set_pinned(&both, "job", true).unwrap());
    let day = NewDay {
        date: "2025-04-01".into(),
        content: "Walked".into(),
        tags: vec!["job".into()],
        ..NewDay::default()
    };
    let day = notes.create_day(&open, day).unwrap().id;
    e.write("Found.md", "---\ntags: [job]\n---\nfound\n");
    e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == "Found.md"));
    let found = e
        .rows()
        .into_iter()
        .find(|(_, p)| p == "Found.md")
        .unwrap()
        .0;
    for id in [&plan, &both, &day, &found] {
        measured(e, id);
    }
    std::thread::sleep(QUIET);
    e.drain();
    clear_outbox(e);
    [plan, both, day, found]
}

/// A merge renames the tag itself in each note's header and record once, a pin with it, a day
/// in its record alone; children and body `#tags` stay, the definition moves, and a second run
/// writes nothing.
#[test]
fn a_merge_writes_each_header_and_record_once_and_leaves_children_and_bodies() {
    let (mut e, notes, store) = opened();
    let [plan, both, day, found] = vault(&notes, &mut e, &store);
    let day_text = e.read(&path_of(&e, &day));
    hub(&e, &store).set_color("job", "#ff0000").unwrap();
    clear_outbox(&e);
    let open = e.session.current().unwrap();

    let merged = notes.merge_tag(&open, "job", "work").unwrap();
    assert_eq!(merged.failed, Vec::new());
    let mut written = merged.written.clone();
    written.sort();
    let mut expected = vec![plan.clone(), both.clone(), day.clone(), found.clone()];
    expected.sort();
    assert_eq!(written, expected);

    let text = e.read("Plan.md");
    assert!(text.contains("  - work\n  - job/lead\n"), "{text}");
    assert!(
        text.contains("Met #job here"),
        "the body keeps its #tags: {text}"
    );
    assert_eq!(record(&e, &plan, "tags"), ["work", "job/lead"]);
    // The target the note holds keeps its spelling, and the pin follows the tag into it.
    assert_eq!(record(&e, &both, "tags"), ["Work"]);
    assert_eq!(record(&e, &both, "pinnedTags"), ["Work"]);
    assert!(!e.read("Both.md").contains("job"), "{}", e.read("Both.md"));
    // A day's file is its author's: its record alone.
    assert_eq!(record(&e, &day, "tags"), ["work"]);
    assert_eq!(e.read(&path_of(&e, &day)), day_text);
    assert_eq!(e.read("Found.md"), "---\ntags:\n  - work\n---\nfound\n");
    for id in [&plan, &both, &day] {
        assert_eq!(upserts(&e, id), 1, "{id}");
    }
    let search = e.session.current().unwrap().search;
    let colors = search
        .tag_colors(vec!["job".into(), "work".into()])
        .unwrap();
    assert_eq!(colors[0], None, "the merged tag's definition is gone");
    assert!(colors[1].is_some(), "the target has a definition");

    // The watcher reports none of the writes as outside edits.
    std::thread::sleep(QUIET);
    let watcher = |f: &&Applied| {
        matches!(
            f,
            Applied::Changed {
                source: ChangeSource::Watcher,
                ..
            }
        )
    };
    assert_eq!(e.drain().iter().filter(watcher).count(), 0);

    clear_outbox(&e);
    let again = notes.merge_tag(&open, "job", "work").unwrap();
    assert!(again.written.is_empty(), "{again:?}");
    assert_eq!(
        upserts(&e, &plan) + upserts(&e, &both) + upserts(&e, &day),
        0
    );
}

/// A delete takes the tag itself, with its pin, off each note's header and record and a day's
/// record; children and body `#tags` stay, and the definition goes.
#[test]
fn a_delete_takes_the_tag_itself_off_headers_and_records() {
    let (mut e, notes, store) = opened();
    let [plan, both, day, found] = vault(&notes, &mut e, &store);
    let open = e.session.current().unwrap();

    let deleted = notes.delete_tag(&open, "JOB").unwrap();
    assert_eq!(deleted.written.len(), 4, "{deleted:?}");
    let text = e.read("Plan.md");
    assert!(text.contains("tags:\n  - job/lead\n"), "{text}");
    assert!(text.contains("Met #job here"), "{text}");
    assert_eq!(record(&e, &plan, "tags"), ["job/lead"]);
    assert_eq!(record(&e, &both, "tags"), ["Work"]);
    assert!(record(&e, &both, "pinnedTags").is_empty());
    assert!(record(&e, &day, "tags").is_empty());
    assert!(!e.read(&path_of(&e, &found)).contains("job"));
}

/// Two names of one tag are not merged, and nothing is written.
#[test]
fn a_merge_into_another_spelling_of_the_tag_is_refused() {
    let (mut e, notes, store) = opened();
    let [plan, ..] = vault(&notes, &mut e, &store);
    let open = e.session.current().unwrap();
    let refused = notes.merge_tag(&open, "job", " JOB ");
    assert!(
        matches!(refused, Err(NotesError::TagMergeSameTag)),
        "{refused:?}"
    );
    assert_eq!(upserts(&e, &plan), 0);
}

/// A merge, delete or removal asked while another tag change holds the lock is refused as a
/// tag change running, and so is a rename asked then; asked while a recorded rename runs, as
/// that rename running.
#[test]
fn a_tag_change_asked_while_another_runs_is_refused_with_what_runs() {
    let (mut e, notes, store) = opened();
    let [plan, ..] = vault(&notes, &mut e, &store);
    let open = e.session.current().unwrap();
    {
        let _held = notes.hold_tag_rename();
        let edit =
            |result: Result<_, NotesError>| matches!(result, Err(NotesError::TagEditInProgress));
        assert!(edit(notes.merge_tag(&open, "job", "work").map(drop)));
        assert!(edit(notes.delete_tag(&open, "job").map(drop)));
        assert!(edit(
            notes.remove_tag_from_note(&open, &plan, "job").map(drop)
        ));
        let job = RenameJob {
            from: "job".into(),
            to: "career".into(),
            run_id: "r".into(),
        };
        assert!(edit(
            notes.rename_tag(&open, &job, &mut |_, _| {}).map(drop)
        ));
    }
    let recorded = RenameJob {
        from: "old".into(),
        to: "new".into(),
        run_id: "earlier".into(),
    };
    let left = vec![Holder {
        id: "left".into(),
        day: false,
    }];
    assert_eq!(hub(&e, &store).rename_begin(&recorded, left).unwrap(), None);
    let _held = notes.hold_tag_rename();
    let merge = notes.merge_tag(&open, "job", "work");
    assert!(
        matches!(&merge, Err(NotesError::TagRenameInProgress { from, to }) if from == "old" && to == "new"),
        "{merge:?}"
    );
    assert_eq!(upserts(&e, &plan), 0);
}

/// While a rename is recorded with notes left, a merge, delete or removal is refused with what
/// finishes it, and writes nothing: the rename's resume reads its notes' files as it left them.
#[test]
fn a_tag_change_asked_while_a_rename_is_left_unfinished_is_refused() {
    let (mut e, notes, store) = opened();
    let [plan, ..] = vault(&notes, &mut e, &store);
    let open = e.session.current().unwrap();
    let recorded = RenameJob {
        from: "job".into(),
        to: "work".into(),
        run_id: "earlier".into(),
    };
    let left = vec![Holder {
        id: plan.clone(),
        day: false,
    }];
    assert_eq!(hub(&e, &store).rename_begin(&recorded, left).unwrap(), None);
    let before = e.read("Plan.md");
    let unfinished = |result: Result<(), NotesError>| {
        matches!(
            result,
            Err(NotesError::TagRenameUnfinished { ref from, ref to, left: 1 })
                if from == "job" && to == "work"
        )
    };
    assert!(unfinished(
        notes.merge_tag(&open, "work", "career").map(drop)
    ));
    assert!(unfinished(notes.delete_tag(&open, "work").map(drop)));
    assert!(unfinished(
        notes.remove_tag_from_note(&open, &plan, "job").map(drop)
    ));
    assert_eq!(e.read("Plan.md"), before);
    assert_eq!(upserts(&e, &plan), 0);
}

/// A merge into a blank name is refused as a name that is not a tag, not as the same tag.
#[test]
fn a_merge_into_a_blank_name_is_refused_as_invalid() {
    let (mut e, notes, store) = opened();
    let [plan, ..] = vault(&notes, &mut e, &store);
    let open = e.session.current().unwrap();
    let refused = notes.merge_tag(&open, "job", "  ");
    assert!(
        matches!(
            refused,
            Err(NotesError::Storage(StorageError::Invalid { .. }))
        ),
        "{refused:?}"
    );
    assert_eq!(upserts(&e, &plan), 0);
}

/// A note whose file cannot take the edit keeps the tag in its file and its record and is
/// answered; the others are written.
#[test]
fn a_note_the_delete_cannot_write_keeps_the_tag_and_is_answered() {
    let (mut e, notes, store) = opened();
    let [plan, both, ..] = vault(&notes, &mut e, &store);
    // A frontmatter that does not parse: the seam keeps the file.
    let broken = e.read("Both.md").replacen("---\n", "---\n: [\n", 1);
    e.write("Both.md", &broken);
    e.facts_until(|f| matches!(f, Applied::Changed { note_id, .. } if *note_id == both));
    let open = e.session.current().unwrap();

    let deleted = notes.delete_tag(&open, "job").unwrap();
    // Frontmatter that does not read: asking again cannot finish it until the file is fixed.
    let kept = KeptNote {
        id: both.clone(),
        title: "Both".into(),
        retry_finishes: false,
    };
    assert_eq!(deleted.failed, [kept]);
    assert!(deleted.written.contains(&plan));
    assert_eq!(e.read("Both.md"), broken);
    assert!(record(&e, &both, "tags").contains(&"job".to_owned()));
}

/// One note at a time: the tag itself comes off its header and record; a note that does not
/// carry it is answered `false` and left.
#[test]
fn removing_a_tag_from_a_note_edits_that_note_alone() {
    let (mut e, notes, store) = opened();
    let [plan, both, day, _] = vault(&notes, &mut e, &store);
    let open = e.session.current().unwrap();

    assert!(notes.remove_tag_from_note(&open, &plan, "JOB").unwrap());
    let text = e.read("Plan.md");
    assert!(text.contains("tags:\n  - job/lead\n"), "{text}");
    assert_eq!(record(&e, &plan, "tags"), ["job/lead"]);
    assert_eq!(record(&e, &both, "tags"), ["Work", "job"]);
    assert_eq!(upserts(&e, &both), 0);

    assert!(notes.remove_tag_from_note(&open, &day, "job").unwrap());
    assert!(record(&e, &day, "tags").is_empty());
    assert!(!notes.remove_tag_from_note(&open, &plan, "job").unwrap());
    let blank = notes.remove_tag_from_note(&open, " ", "job");
    assert!(
        matches!(
            blank,
            Err(NotesError::Storage(StorageError::Invalid { .. }))
        ),
        "{blank:?}"
    );
}
