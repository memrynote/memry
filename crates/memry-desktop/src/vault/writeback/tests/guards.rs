//! A file that holds what the document does not, or a body whose write would lose content, is
//! never written over, whoever changed the body.

use super::*;
use crate::vault::note_file::{NoteFileError, write_note_over_checked};

/// The ways a body changes: an edit in the app (0) and one merged from sync (1).
fn edit(f: &Fixture, id: &str, way: usize) {
    match way {
        0 => f.edit_in_app(id, "typed in the app"),
        _ => f.paragraph_from_sync(id, "from the other device"),
    }
}

#[test]
fn an_outside_edit_not_yet_fed_is_never_written_over() {
    for way in 0..2 {
        let mut f = fixture();
        let id = f.adopt("n.md", "first words\n");
        edit(&f, &id, way);
        f.write("n.md", "edited outside the app\n");
        let outcome = f.run(&id);
        assert_kept(
            &mut f,
            &outcome,
            Keep::FileChanged,
            "n.md",
            "edited outside the app\n",
        );
    }
}

/// A row without a hash names no text the document holds: its file may have text the body
/// never took (synced, kept, never read).
#[test]
fn a_file_the_document_is_not_known_to_hold_is_never_written_over() {
    for way in 0..2 {
        let mut f = fixture();
        let id = f.adopt("n.md", "first words\n");
        f.record(&id, "n.md", None);
        f.facts();
        edit(&f, &id, way);
        let outcome = f.run(&id);
        assert_kept(&mut f, &outcome, Keep::NotRead, "n.md", "first words\n");
    }
}

#[test]
fn a_file_ahead_of_its_document_is_never_written_over() {
    for way in 0..2 {
        let mut f = fixture();
        let id = f.adopt("n.md", "first words\n");
        edit(&f, &id, way);
        f.owe_file(&id);
        let outcome = f.run(&id);
        assert_kept(&mut f, &outcome, Keep::FileAhead, "n.md", "first words\n");
    }
}

/// A feed this build refused marks the file ahead. Its file back at the row's bytes is still
/// not written until the marker is taken.
#[test]
fn a_file_whose_edit_was_refused_is_never_written_over() {
    let mut f = fixture();
    let id = f.adopt("n.md", "first words\n");
    f.edit_from_sync(&id, |txn| raw_block(txn, "futureBlock", "a newer build's"));
    let input = FeedInput {
        note_id: &id,
        markdown: "an outside edit\n",
        note_path: Some("n.md"),
        writing: None,
        frontmatter: None,
    };
    let outcome = f
        .vault
        .external_feed(f.store.clone())
        .unwrap()
        .feed(&converter_for(None), input)
        .unwrap();
    assert!(matches!(outcome, FeedOutcome::Refused(_)), "{outcome:?}");
    f.edit_in_app(&id, "typed in the app");
    let outcome = f.run(&id);
    assert_kept(&mut f, &outcome, Keep::FileAhead, "n.md", "first words\n");
}

#[test]
fn a_note_whose_server_body_is_not_pulled_keeps_its_file() {
    let mut f = fixture();
    let id = f.adopt("n.md", "first words\n");
    f.edit_in_app(&id, "typed in the app");
    f.owe_server_body(&id);
    let outcome = f.run(&id);
    assert_kept(
        &mut f,
        &outcome,
        Keep::BodyNotPulled,
        "n.md",
        "first words\n",
    );
}

/// Another device's raw change to a body.
type Extend = fn(&mut yrs::TransactionMut);

/// What this build cannot write out whole: a block a newer build added, a table whose rows the
/// read drops, a mark a newer build added. Each would be lost by the write.
#[test]
fn a_body_whose_write_would_lose_content_keeps_the_file() {
    let cases: [(&str, Extend); 3] = [
        ("a newer block", |txn| {
            raw_block(txn, "futureBlock", "a newer build's")
        }),
        ("a table the read drops", |txn| raw_block(txn, "table", "")),
        ("a newer mark", |txn| {
            raw_marked(txn, "marked by a newer build", "futureMark");
        }),
    ];
    for (case, extend) in cases {
        let mut f = fixture();
        let id = f.adopt("n.md", "first words\n");
        f.edit_from_sync(&id, extend);
        f.edit_in_app(&id, "typed in the app");
        let outcome = f.run(&id);
        assert!(
            matches!(&outcome, Outcome::Kept(Keep::NotRepresentable(_))),
            "{case}: {outcome:?}"
        );
        assert_eq!(f.read("n.md"), "first words\n", "{case}");
        assert!(f.facts().is_empty(), "{case}");
    }
}

/// An edit that lands between the pass's read and its rename is kept, as is a file moved away
/// in that window (the write must not bring it back at the old path).
#[test]
fn a_file_that_changes_or_moves_while_it_is_written_is_kept() {
    let f = fixture();
    let text = "first words\n";
    f.write("n.md", text);
    let hash = content_hash(text);
    let root = f.root.clone();
    let result = write_note_over_checked(&f.root, "n.md", "the app's\n", &hash, &mut || {
        std::fs::write(root.join("n.md"), "edited meanwhile\n").unwrap();
    });
    assert!(
        matches!(result, Err(NoteFileError::ChangedUnderWrite)),
        "{result:?}"
    );
    assert_eq!(f.read("n.md"), "edited meanwhile\n");

    f.write("m.md", text);
    let root = f.root.clone();
    let result = write_note_over_checked(&f.root, "m.md", "the app's\n", &hash, &mut || {
        std::fs::rename(root.join("m.md"), root.join("moved.md")).unwrap();
    });
    assert!(
        matches!(result, Err(NoteFileError::ChangedUnderWrite)),
        "{result:?}"
    );
    assert!(!f.root.join("m.md").exists());
    assert_eq!(f.read("moved.md"), text);
    let leftovers: Vec<_> = std::fs::read_dir(&f.root)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

/// A pass of a session that closed, or of one before the vault was opened again, writes
/// nothing.
#[test]
fn a_pass_of_a_closed_session_writes_nothing() {
    let mut f = fixture();
    let id = f.adopt("n.md", "first words\n");
    f.edit_in_app(&id, "typed in the app");
    f.rows.close();
    let outcome = f.run(&id);
    assert_kept(&mut f, &outcome, Keep::Closed, "n.md", "first words\n");
    f.rows.open(f.vault.clone()).unwrap();
    let outcome = f.run(&id);
    assert_kept(&mut f, &outcome, Keep::Closed, "n.md", "first words\n");
}

#[test]
fn a_note_without_a_row_or_a_file_creates_none() {
    let mut f = fixture();
    let id = f.writer.create("No file".into(), None).unwrap();
    assert_eq!(f.run(&id), Outcome::Kept(Keep::NoRow));
    let id = f.adopt("gone.md", "first words\n");
    std::fs::remove_file(f.root.join("gone.md")).unwrap();
    assert_eq!(f.run(&id), Outcome::Kept(Keep::NoFile));
    assert!(!f.root.join("gone.md").exists());
    assert_eq!(f.run("j2026-01-02"), Outcome::Kept(Keep::Journal));
    assert!(f.facts().is_empty());
}
