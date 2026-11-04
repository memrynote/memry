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
        .wrote(&id, &content_hash(saved), ChangeSource::Save);
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
    assert_eq!(f.hash_of("a.md"), Some(content_hash("first\n")));

    f.identity.changed_fails.store(false, Ordering::SeqCst);
    assert_eq!(f.changed(&id, "a.md"), Step::Done);
    let previous = content_hash("first\n");
    assert_eq!(told(&f), [(id.clone(), previous.clone()), (id, previous)]);
    assert_eq!(
        f.hash_of("a.md"),
        Some(content_hash("---\ntags: [x]\n---\nfirst\n"))
    );
}
