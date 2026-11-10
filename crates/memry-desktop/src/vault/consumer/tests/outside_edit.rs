//! Which changed files the identity is told about (`NoteIdentity::on_changed`, #3825): an outside
//! edit of the file the row named, once the document took it; never bytes the app wrote, nor a
//! file that only fills a body the row named no text of.

use std::sync::atomic::Ordering;

use super::*;

fn told(f: &Fixture) -> Vec<(String, String)> {
    f.identity.changed.lock().unwrap().clone()
}

#[test]
fn an_outside_edit_of_the_file_the_row_named_is_told_with_that_files_hash() {
    let f = fixture();
    f.write("a.md", "first\n");
    f.added("a.md");
    let id = only_note(&f, "a.md");
    assert!(told(&f).is_empty(), "a new file is the adopt's");

    f.write("a.md", "---\ntags: [x]\n---\nfirst\n");
    assert_eq!(f.changed(&id, "a.md"), Step::Done);
    assert_eq!(told(&f), [(id, content_hash("first\n"))]);
}

#[test]
fn bytes_a_save_wrote_are_not_told() {
    let mut f = fixture();
    f.write("a.md", "first\n");
    f.added("a.md");
    let id = only_note(&f, "a.md");
    f.facts();
    let saved = "---\ntags: [x]\n---\nsaved\n";
    f.write("a.md", saved);
    f.applier
        .own_files
        .wrote(&id, &content_hash(saved), ChangeSource::Save, None);
    assert_eq!(f.changed(&id, "a.md"), Step::Done);
    assert!(told(&f).is_empty());
    assert!(matches!(
        f.facts().as_slice(),
        [Applied::Changed {
            source: ChangeSource::Save,
            ..
        }]
    ));
}

#[test]
fn a_file_that_fills_a_body_the_row_named_no_text_of_is_not_told() {
    let f = fixture();
    let id = f.note();
    f.rows
        .reserve(f.session(), &id, "a.md", Fixture::stat(0))
        .unwrap();
    f.write("a.md", "---\ntags: [x]\n---\nwritten\n");
    assert_eq!(f.changed(&id, "a.md"), Step::Done);
    assert!(told(&f).is_empty());
}

/// The record did not take it: the row keeps naming the file it had, so the retry feeds the
/// same text, which the document answers `Unchanged`, and tells again.
#[test]
fn a_record_that_did_not_take_the_edit_retries_it() {
    let f = fixture();
    f.write("a.md", "first\n");
    f.added("a.md");
    let id = only_note(&f, "a.md");
    f.identity.changed_fails.store(true, Ordering::SeqCst);
    f.write("a.md", "---\ntags: [x]\n---\nfirst\n");
    assert_eq!(f.changed(&id, "a.md"), Step::Retry("a.md".into()));
    let edited = content_hash("---\ntags: [x]\n---\nfirst\n");
    let row = f.row("a.md").unwrap();
    assert_eq!(row.content_hash, Some(content_hash("first\n")));
    assert_eq!(
        row.file_hash,
        Some(edited),
        "a move before the retry pairs on the bytes read"
    );

    f.identity.changed_fails.store(false, Ordering::SeqCst);
    assert_eq!(f.changed(&id, "a.md"), Step::Done);
    let previous = content_hash("first\n");
    assert_eq!(told(&f), [(id.clone(), previous.clone()), (id, previous)]);
    assert_eq!(
        f.hash_of("a.md"),
        Some(content_hash("---\ntags: [x]\n---\nfirst\n"))
    );
}

/// A record that never takes it: the row moves on once the retries are spent, so it names the
/// file the document holds and the app's edits of that file are not refused.
#[test]
fn a_record_that_never_takes_the_edit_lets_the_row_move_on() {
    let mut f = fixture();
    f.write("a.md", "first\n");
    f.added("a.md");
    let id = only_note(&f, "a.md");
    f.facts();
    f.identity.changed_fails.store(true, Ordering::SeqCst);
    let edited = "---\ntags: [x]\n---\nfirst\n";
    f.write("a.md", edited);
    for _ in 0..crate::vault::consumer::MAX_RETRIES {
        assert_eq!(f.changed(&id, "a.md"), Step::Retry("a.md".into()));
    }
    assert_eq!(f.changed(&id, "a.md"), Step::Done);
    assert_eq!(f.hash_of("a.md"), Some(content_hash(edited)));
    assert!(matches!(
        f.facts().as_slice(),
        [Applied::Changed {
            source: ChangeSource::Watcher,
            ..
        }]
    ));
}

/// The write-back tells an outside text replaced only for an outside edit the body did not take
/// (`body::outside_edit`, typing won): one the body took is its text (#4124), and bytes the app
/// wrote are its own.
#[test]
fn a_fed_outside_edit_and_an_own_write_are_not_recorded_for_the_write_back() {
    let f = fixture();
    f.write("a.md", "first\n");
    f.added("a.md");
    let id = only_note(&f, "a.md");
    let own = &f.applier.own_files;
    assert!(
        !own.is_outside(&id, &content_hash("first\n")),
        "the adopt's"
    );

    f.write("a.md", "edited outside\n");
    assert_eq!(f.changed(&id, "a.md"), Step::Done);
    assert!(!own.is_outside(&id, &content_hash("edited outside\n")));

    let saved = "saved\n";
    f.write("a.md", saved);
    own.wrote(&id, &content_hash(saved), ChangeSource::Save, None);
    assert_eq!(f.changed(&id, "a.md"), Step::Done);
    assert!(!own.is_outside(&id, &content_hash(saved)));
}
