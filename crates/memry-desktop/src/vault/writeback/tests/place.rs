//! A pulled title, folder, tags or properties of a note with a file (`place`): the file moves
//! and its frontmatter takes the record, behind the pass's guards. The record is changed through
//! this device's writer, as a pulled page leaves it, and the note is marked as the sync
//! observer marks it.

use serde_json::Map;

use super::*;
use crate::notes::properties::text_values;
use crate::vault::consumer::MoveKind;

/// A note named `n` at `n.md` whose document took `text`.
fn note(f: &mut Fixture, text: &str) -> String {
    let id = f.writer.create("n".into(), None).unwrap();
    f.seed(&id, "n.md", text);
    id
}

fn pulled_rename(f: &Fixture, id: &str, title: &str) {
    f.writer.rename(id.to_owned(), title.into()).unwrap();
    f.pass.mark_pulled(id);
}

fn pulled_tags(f: &Fixture, id: &str, tags: &[&str]) {
    let tags = tags.iter().map(|tag| (*tag).to_owned()).collect();
    f.writer.set_tags(id.to_owned(), tags).unwrap();
    f.pass.mark_pulled(id);
}

fn row_path(f: &Fixture, id: &str) -> String {
    f.vault.note_files().by_id(id).unwrap().expect("a row").path
}

/// The file moves to the pulled title's name and is at exactly one path after the pass: the
/// old name is gone, the new one holds the bytes, and the row names it.
#[test]
fn a_pulled_rename_moves_the_file_to_one_place() {
    let mut f = fixture();
    let id = note(&mut f, "first words\n");
    pulled_rename(&f, &id, "Renamed");
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert!(!f.root.join("n.md").exists(), "the old file is gone");
    assert_eq!(f.read("Renamed.md"), "first words\n");
    assert_eq!(row_path(&f, &id), "Renamed.md");
    let facts = f.facts();
    assert!(
        facts.iter().any(|fact| matches!(
            fact,
            Applied::Renamed { old_path, new_path, kind: MoveKind::Renamed, .. }
                if old_path == "n.md" && new_path == "Renamed.md"
        )),
        "{facts:?}"
    );
    assert!(
        facts.iter().any(|fact| matches!(
            fact,
            Applied::Changed { path, source: ChangeSource::Sync, .. } if path == "Renamed.md"
        )),
        "{facts:?}"
    );
    // The mark is taken: a second pass finds the file in place and changes nothing.
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert!(f.facts().is_empty());
}

/// A local pass never moves the file, whatever the record's title says (`Pulled`).
#[test]
fn an_unmarked_pass_never_moves_the_file() {
    let mut f = fixture();
    let id = note(&mut f, "first words\n");
    f.writer.rename(id.clone(), "Renamed".into()).unwrap();
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert_eq!(f.read("n.md"), "first words\n");
    assert!(!f.root.join("Renamed.md").exists());
}

/// Another file at the pulled name stays; the note takes the first free number.
#[test]
fn a_taken_name_numbers_the_moved_file() {
    let mut f = fixture();
    let id = note(&mut f, "first words\n");
    f.write("Renamed.md", "someone else's\n");
    pulled_rename(&f, &id, "Renamed");
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert_eq!(f.read("Renamed.md"), "someone else's\n");
    assert_eq!(f.read("Renamed 1.md"), "first words\n");
    assert_eq!(row_path(&f, &id), "Renamed 1.md");
}

/// An outside edit the document has not taken is never moved or rewritten, and the mark waits
/// for the pass after the edit is fed.
#[test]
fn an_outside_edit_since_the_last_hash_is_kept_and_the_mark_waits() {
    let mut f = fixture();
    let id = note(&mut f, "first words\n");
    pulled_rename(&f, &id, "Renamed");
    f.write("n.md", "edited outside\n");
    let outcome = f.run(&id);
    assert_kept(
        &mut f,
        &outcome,
        Keep::FileChanged,
        "n.md",
        "edited outside\n",
    );
    assert!(!f.root.join("Renamed.md").exists());

    // The consumer read the file back as it was: the mark is still there.
    f.write("n.md", "first words\n");
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert_eq!(f.read("Renamed.md"), "first words\n");
}

/// A missing file is not made again, at the old path or the new one.
#[test]
fn a_missing_file_is_not_recreated() {
    let mut f = fixture();
    let id = note(&mut f, "first words\n");
    pulled_rename(&f, &id, "Renamed");
    std::fs::remove_file(f.root.join("n.md")).unwrap();
    assert_eq!(f.run(&id), Outcome::Kept(Keep::NoFile));
    assert!(!f.root.join("n.md").exists());
    assert!(!f.root.join("Renamed.md").exists());
}

/// A pulled journal day never moves (its record names no folder of a note's), and its
/// frontmatter keeps the day's rules.
#[test]
fn a_journal_day_never_moves() {
    let mut f = fixture();
    let rel = "journal/2025-01-01.md";
    let text = "---\ntags:\n  - mine\n---\nA day.\n";
    let id = f.adopt_day(rel, "2025-01-01", text);
    f.pass.mark_pulled(&id);
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert_eq!(f.read(rel), text);
    assert!(
        !f.facts()
            .iter()
            .any(|fact| matches!(fact, Applied::Renamed { .. }))
    );
}

/// Pulled tags reach the block, the file it replaces is kept as a version first (even as the
/// run's own last write), and the tags fact follows.
#[test]
fn a_version_is_kept_before_pulled_tags_rewrite_the_block() {
    let mut f = fixture();
    let text = "---\ntags:\n  - old\n---\nfirst words\n";
    let id = note(&mut f, text);
    f.own_files.wrote_back(&id, &content_hash(text));
    pulled_tags(&f, &id, &["remote"]);
    let outcome = f.run(&id);
    let Outcome::Wrote { version_kept, .. } = outcome else {
        panic!("no write: {outcome:?}");
    };
    assert!(version_kept);
    assert_eq!(f.versions(&id).last().map(String::as_str), Some(text));
    assert_eq!(f.read("n.md"), "---\ntags:\n  - remote\n---\nfirst words\n");
    let facts = f.facts();
    assert!(
        facts.iter().any(|fact| matches!(
            fact,
            Applied::Changed {
                source: ChangeSource::Sync,
                ..
            }
        )),
        "{facts:?}"
    );
    assert!(
        facts
            .iter()
            .any(|fact| matches!(fact, Applied::TagsPulled { .. })),
        "{facts:?}"
    );
}

/// Tags that differ only in case are the same set: the file is not rewritten.
#[test]
fn tags_that_differ_in_case_only_leave_the_file() {
    let mut f = fixture();
    let text = "---\ntags:\n  - Remote\n---\nfirst words\n";
    let id = note(&mut f, text);
    pulled_tags(&f, &id, &["remote"]);
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert_eq!(f.read("n.md"), text);
}

/// A key the record holds as the file does (a nested map the consumer read in) and the cover
/// keys, which the property read never takes, stay as the file holds them when pulled tags
/// rewrite the block.
#[test]
fn keys_the_record_does_not_hold_are_kept() {
    let mut f = fixture();
    let text = "---\nsource:\n  site: web\n  depth: 2\ncover: covers/a.png\n---\nfirst words\n";
    let id = note(&mut f, text);
    let read = text_values(text, &f.pass.property_types()).expect("a block");
    assert!(read.contains_key("source") && !read.contains_key("cover"));
    f.writer.file_properties(&id, Map::new(), read).unwrap();
    pulled_tags(&f, &id, &["remote"]);
    let outcome = f.run(&id);
    assert!(matches!(outcome, Outcome::Wrote { .. }), "{outcome:?}");
    let file = f.read("n.md");
    assert!(
        file.contains("source:\n  site: web\n  depth: 2\n"),
        "{file:?}"
    );
    assert!(file.contains("cover: covers/a.png\n"), "{file:?}");
    assert!(file.contains("tags:\n  - remote\n"), "{file:?}");
}

/// A pulled property value reaches the root of the block.
#[test]
fn a_pulled_property_reaches_the_block() {
    let mut f = fixture();
    let id = note(&mut f, "first words\n");
    f.writer
        .set_property(id.clone(), "status".into(), "\"done\"".into())
        .unwrap();
    f.pass.mark_pulled(&id);
    let outcome = f.run(&id);
    assert!(matches!(outcome, Outcome::Wrote { .. }), "{outcome:?}");
    assert_eq!(f.read("n.md"), "---\nstatus: done\n---\nfirst words\n");
}
