//! An outside edit against typing the file does not have yet (#4030, kept for the editor bound
//! to the host): the typing wins, the outside file is kept as a version, and the write-back
//! writes the typing over it. An outside edit after the typing was written is a later edit, and
//! wins. One test per order of the typing's write and the outside edit.

use memry_core::crdt::body_edit::BlockEdit;

use super::*;
use crate::vault::watch::EchoGuard;
use crate::vault::writeback::{Keep, Outcome, Pass};

const OUTSIDE: &str = "edited outside\n";

/// A note at `n.md` with the file read, and a pass that writes it.
fn note(f: &Fixture) -> (String, Pass) {
    f.write("n.md", "first words\n");
    assert_eq!(f.added("n.md"), Step::Done);
    let echo: Arc<EchoGuard> = Arc::default();
    let pass = Pass::new(
        f.root.clone(),
        f.vault.clone(),
        f.rows.clone(),
        f.session(),
        echo,
        None,
        f.applier.own_files.clone(),
    );
    (only_note(f, "n.md"), pass)
}

/// The note's first block, retyped in the app's editor and stored.
fn type_in_app(f: &Fixture, id: &str, text: &str) {
    let blocks = f.vault.notes().blocks(id.to_owned()).unwrap().unwrap();
    let block_id = blocks.iter().find_map(|block| block.id.clone()).unwrap();
    let edit = BlockEdit::SetText {
        block_id,
        text: text.to_owned(),
    };
    assert!(f.identity.writer.edit_block(id.to_owned(), edit).unwrap());
}

fn kept_outside(facts: &[Applied]) -> bool {
    facts
        .iter()
        .any(|fact| matches!(fact, Applied::OutsideEditKept { path, .. } if path == "n.md"))
}

fn wrote(outcome: &Outcome) -> bool {
    matches!(outcome, Outcome::Wrote { .. })
}

/// The typing wins over the outside file the consumer just read: the body keeps it, the outside
/// file is a version, the record took what the file's frontmatter says, and the next pass writes
/// the typing over the file and tells the page (`replaced_outside`).
fn assert_typing_won(f: &mut Fixture, id: &str, pass: &Pass) {
    assert_eq!(f.body(id), "typed in the app");
    assert!(
        f.versions(id).iter().any(|v| v == OUTSIDE),
        "{:?}",
        f.versions(id)
    );
    assert!(!kept_outside(&f.facts()), "told before the write");
    assert_eq!(
        f.identity.changed.lock().unwrap().as_slice(),
        [(id.to_owned(), content_hash("first words\n"))]
    );
    assert!(matches!(
        pass.run(id),
        Outcome::Wrote {
            replaced_outside: true,
            ..
        }
    ));
    assert!(kept_outside(&f.facts()), "the page was not told");
    assert_eq!(
        std::fs::read_to_string(f.root.join("n.md")).unwrap(),
        "typed in the app\n"
    );
}

#[test]
fn an_outside_edit_while_typing_waits_for_its_write_keeps_the_typing() {
    let mut f = fixture();
    let (id, pass) = note(&f);
    f.facts();
    type_in_app(&f, &id, "typed in the app");
    f.write("n.md", OUTSIDE);
    assert_eq!(f.changed(&id, "n.md"), Step::Done);
    assert_typing_won(&mut f, &id, &pass);
}

/// The outside edit lands while the typing's file is written aside: the write keeps the file,
/// and the consumer then finds the typing ahead of it.
#[test]
fn an_outside_edit_during_the_typings_write_keeps_the_typing() {
    let mut f = fixture();
    let (id, pass) = note(&f);
    f.facts();
    type_in_app(&f, &id, "typed in the app");
    let file = f.root.join("n.md");
    let outcome = pass.run_checked(&id, &mut || std::fs::write(&file, OUTSIDE).unwrap());
    assert!(
        matches!(outcome, Outcome::Kept(Keep::FileChanged)),
        "{outcome:?}"
    );
    assert_eq!(f.changed(&id, "n.md"), Step::Done);
    assert_typing_won(&mut f, &id, &pass);
}

/// After the rename, the pass holds the rows' lane until the row names the typing's file, so
/// the consumer reads an outside edit made then only after: it is an edit of the typing's file,
/// and wins, as any later edit does. The typing is kept as a version.
#[test]
fn an_outside_edit_after_the_typings_write_wins_and_keeps_the_typing() {
    let mut f = fixture();
    let (id, pass) = note(&f);
    type_in_app(&f, &id, "typed in the app");
    assert!(wrote(&pass.run(&id)));
    f.facts();
    f.write("n.md", OUTSIDE);
    assert_eq!(f.changed(&id, "n.md"), Step::Done);
    assert_eq!(f.body(&id), "edited outside");
    let versions = f.versions(&id);
    assert!(
        versions.iter().any(|v| v.contains("typed in the app")),
        "{versions:?}"
    );
    assert!(!kept_outside(&f.facts()));
}

/// Bytes the app wrote are its own, never an outside edit to keep.
#[test]
fn the_apps_own_write_is_fed_while_typing_is_ahead_of_it() {
    let mut f = fixture();
    let (id, _) = note(&f);
    f.facts();
    type_in_app(&f, &id, "typed in the app");
    let saved = "saved by the app\n";
    f.write("n.md", saved);
    f.applier
        .own_files
        .wrote(&id, &content_hash(saved), ChangeSource::Save);
    assert_eq!(f.changed(&id, "n.md"), Step::Done);
    assert!(!kept_outside(&f.facts()));
    assert!(f.versions(&id).iter().all(|v| v != saved));
}

/// The body moved after the row's stamp, but its text is the file's (an edit undone, a link the
/// editor made a chip of): no typing is pending, and the outside edit is fed.
#[test]
fn a_body_that_moved_back_to_its_files_text_takes_an_outside_edit() {
    let mut f = fixture();
    let (id, _) = note(&f);
    type_in_app(&f, &id, "typed in the app");
    type_in_app(&f, &id, "first words");
    f.facts();
    f.write("n.md", OUTSIDE);
    assert_eq!(f.changed(&id, "n.md"), Step::Done);
    assert_eq!(f.body(&id), "edited outside");
    assert!(!kept_outside(&f.facts()));
}

/// The same, with the outside edit changing the file's frontmatter too: only the body's text
/// counts, so the outside edit is fed.
#[test]
fn a_body_back_at_its_files_text_takes_an_outside_edit_of_the_frontmatter_too() {
    let mut f = fixture();
    let (id, _) = note(&f);
    type_in_app(&f, &id, "typed in the app");
    type_in_app(&f, &id, "first words");
    f.facts();
    f.write("n.md", "---\nstatus: done\n---\nedited outside\n");
    assert_eq!(f.changed(&id, "n.md"), Step::Done);
    assert_eq!(f.body(&id), "edited outside");
    assert!(!kept_outside(&f.facts()));
}

/// A row an older build stamped has no mark: the body is compared through the file instead, so
/// a body back at the file's text (or one a fold moved) takes the outside edit, and typing still
/// wins.
#[test]
fn a_row_with_no_mark_compares_the_body_through_the_file() {
    // As an older build left it: no mark, and a stamp before the typing (the clock alone cannot
    // tell typing in the stamp's millisecond).
    let forget_marks = |f: &Fixture| {
        f.vault
            .db_handle()
            .call_blocking(|conn| {
                conn.execute_batch(
                    "DELETE FROM note_file_marks;
                     UPDATE note_files SET indexed_at = indexed_at - 1000;",
                )
                .map_err(|error| memry_core::api::errors::StorageError::Failed {
                    what: error.to_string(),
                })
            })
            .unwrap();
    };
    let mut f = fixture();
    let (id, _) = note(&f);
    type_in_app(&f, &id, "typed in the app");
    type_in_app(&f, &id, "first words");
    forget_marks(&f);
    f.facts();
    f.write("n.md", OUTSIDE);
    assert_eq!(f.changed(&id, "n.md"), Step::Done);
    assert_eq!(f.body(&id), "edited outside");

    let mut f = fixture();
    let (id, pass) = note(&f);
    type_in_app(&f, &id, "typed in the app");
    forget_marks(&f);
    f.facts();
    f.write("n.md", OUTSIDE);
    assert_eq!(f.changed(&id, "n.md"), Step::Done);
    assert_typing_won(&mut f, &id, &pass);
}
