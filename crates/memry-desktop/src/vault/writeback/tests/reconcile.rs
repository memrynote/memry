//! Which notes the open reconcile writes (module invariants, "Every open brings the files
//! left behind"): a note whose body moved after its row was stamped, and no other; and a
//! pass's stamp, which takes a reconciled note off the list and keeps an edit made while the
//! pass ran on it.

use std::time::Duration;

use super::*;

/// The body moved later than the row's stamp: the reconcile's window.
fn later() {
    std::thread::sleep(Duration::from_millis(3));
}

#[test]
fn an_edit_made_in_the_app_after_the_file_was_read_puts_the_note_behind_until_a_pass_writes_it() {
    let mut f = fixture();
    let id = f.adopt("n.md", "first words\n");
    assert!(f.behind().is_empty());
    later();
    f.edit_in_app(&id, "typed in the app");
    assert_eq!(f.behind(), std::slice::from_ref(&id));
    let outcome = f.run(&id);
    assert_wrote(&mut f, &outcome, "n.md");
    assert_eq!(f.read("n.md"), "typed in the app\n");
    assert!(f.behind().is_empty(), "a written note is behind again");
}

#[test]
fn a_page_merged_from_sync_after_the_file_was_read_puts_the_note_behind() {
    let mut f = fixture();
    let id = f.adopt("n.md", "first words\n");
    later();
    f.paragraph_from_sync(&id, "from another device");
    assert_eq!(f.behind(), std::slice::from_ref(&id));
    let outcome = f.run(&id);
    assert_wrote(&mut f, &outcome, "n.md");
    assert_eq!(f.read("n.md"), "first words\n\nfrom another device\n");
    assert!(f.behind().is_empty());
}

/// A file the read does not keep whole (the reference app seeds `` `<!--ghost-->` `` as
/// empty code) is not behind while the app leaves the note alone, though a pass would
/// rewrite it: the reconcile, not the pass, is what keeps such a file as the author wrote it.
#[test]
fn a_note_the_app_did_not_change_is_not_behind_even_when_a_pass_would_rewrite_it() {
    let mut f = fixture();
    let plain = f.adopt("plain.md", "first words\n");
    let ghost = f.adopt("ghost.md", "`<!--ghost-->`\n");
    later();
    assert!(f.behind().is_empty(), "{:?}", f.behind());
    assert!(
        matches!(f.run(&ghost), Outcome::Wrote { .. }),
        "the read keeps this file whole now; pick another"
    );
    assert_eq!(f.run(&plain), Outcome::Unchanged);
}

/// The body moved after the row (a compaction, a page that changed no text) and the pass
/// finds the file unchanged: it stamps the row, so the note is not behind on the next open.
#[test]
fn a_pass_that_finds_the_file_unchanged_stamps_the_row() {
    let mut f = fixture();
    let id = f.adopt("n.md", "first words\n");
    f.sql(
        "UPDATE note_files SET indexed_at = indexed_at - 60000 WHERE note_id = ?1",
        &id,
    );
    assert_eq!(f.behind(), std::slice::from_ref(&id));
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert!(f.behind().is_empty(), "an unchanged note stays behind");
    assert!(f.facts().is_empty(), "a stamp is not a change of the file");
}

/// An edit made after the pass read the body is not in what it wrote: the row is stamped
/// with the time before that read, so the note stays behind.
#[test]
fn an_edit_made_while_the_pass_runs_leaves_the_note_behind() {
    let mut f = fixture();
    let id = f.adopt("n.md", "first words\n");
    later();
    f.edit_in_app(&id, "typed in the app");
    let outcome = f.pass.run_checked(&id, &mut || {
        later();
        f.edit_in_app(&id, "typed while the pass ran");
    });
    assert_wrote(&mut f, &outcome, "n.md");
    assert_eq!(f.read("n.md"), "typed in the app\n");
    assert_eq!(f.behind(), [id]);
}
