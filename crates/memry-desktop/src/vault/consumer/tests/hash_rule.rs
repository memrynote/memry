//! A row's hash names text the note's document holds, the whole file included, and a row
//! without one is never replaced from its file.

use super::*;

const WRITING: &str = "---\nwriting:\n  alternatives:\n    k3x9q2:\n      versions:\n        - text: two\n        - text: zwei\n---\none <!--alt:k3x9q2-->two<!--/alt:k3x9q2--> three\n";

/// The feed is told the `writing` frontmatter, so its answer covers the whole file and the
/// row records the hash: the write-back writes the alternatives back with the body. A
/// frontmatter that does not parse may hold some, so that file is not taken as read.
#[test]
fn a_file_is_taken_as_read_with_its_writing_frontmatter_and_not_when_that_does_not_parse() {
    let f = fixture();
    f.write("w.md", WRITING);
    assert_eq!(f.added("w.md"), Step::Done);
    assert_eq!(f.hash_of("w.md"), Some(content_hash(WRITING)));
    let id = only_note(&f, "w.md");
    let body = f
        .vault
        .write_back()
        .body(
            &super::super::converter_for(None),
            &id,
            "w.md",
            "",
            &memry_core::markdown::convert::NoEmbeds,
        )
        .unwrap();
    let memry_core::domain::write_back::BodyRead::Body(body) = body else {
        panic!("{body:?}");
    };
    assert_eq!(body.writing.alternatives.len(), 1, "{body:?}");

    let broken = "---\nwriting: [unclosed\n---\nplain body\n";
    f.write("b.md", broken);
    assert_eq!(f.added("b.md"), Step::Done);
    assert_eq!(f.hash_of("b.md"), None, "a frontmatter that does not parse");
    assert_eq!(f.walked("b.md"), Step::Done);
    assert_eq!(f.hash_of("b.md"), None);

    f.write("t.md", "---\ntitle: Kept apart\n---\nplain body\n");
    assert_eq!(f.added("t.md"), Step::Done);
    assert_eq!(
        f.hash_of("t.md"),
        Some(content_hash("---\ntitle: Kept apart\n---\nplain body\n")),
        "other frontmatter is the record's, and the body was taken"
    );
}

/// A synced body that the file did not seed, and an older file with feeding on: the file never
/// replaces the body. A row without a hash gets a seed, which leaves a body alone.
#[test]
fn a_row_without_a_hash_never_has_its_body_replaced_by_the_file() {
    let f = fixture();
    let id = f.note();
    f.give_body(&id, "the synced body");
    *f.identity.next.lock().unwrap() = Some(Adoption::Existing(id.clone()));
    f.write("synced.md", "an older file\n");
    assert_eq!(f.added("synced.md"), Step::Done);
    assert_eq!(f.hash_of("synced.md"), None);

    assert_eq!(f.walked("synced.md"), Step::Done);
    assert_eq!(f.changed(&id, "synced.md"), Step::Done);
    f.write("synced.md", "an older file, edited\n");
    assert_eq!(f.changed(&id, "synced.md"), Step::Done);
    let body = f.body(&id);
    assert!(
        body.contains("the synced body") && !body.contains("older file"),
        "{body}"
    );
    assert_eq!(f.hash_of("synced.md"), None);
}

/// A note the identity kept when its file went keeps its row, which no longer names a file.
/// Another file that shows up at that path is not that note's text.
#[test]
fn a_new_file_where_a_kept_note_lost_its_file_does_not_replace_its_body() {
    let f = fixture();
    f.write("a.md", "the kept note\n");
    f.added("a.md");
    let id = only_note(&f, "a.md");
    *f.identity.removal.lock().unwrap() = Removal::Kept;
    std::fs::remove_file(f.root.join("a.md")).unwrap();
    let removed = VaultEvent::Removed {
        note_id: id.clone(),
        path: "a.md".into(),
    };
    assert_eq!(f.applier.apply(removed), Step::Done);
    assert!(f.row("a.md").is_some(), "a kept note lost its row");

    f.write("a.md", "someone else's file\n");
    assert_eq!(f.added("a.md"), Step::Done);
    let body = f.body(&id);
    assert!(
        body.contains("the kept note") && !body.contains("someone else"),
        "{body}"
    );
}

/// The walk reads a markdown file again when its time is newer than the row. When the text is
/// the one the row names, the row's time moves on, so the next walk does not read it again.
#[test]
fn a_file_read_back_unchanged_refreshes_its_row() {
    let f = fixture();
    f.write("a.md", "same text\n");
    f.added("a.md");
    let id = only_note(&f, "a.md");
    let before = f.row("a.md").unwrap().indexed_at;
    std::thread::sleep(std::time::Duration::from_millis(20));
    assert_eq!(f.changed(&id, "a.md"), Step::Done);
    let after = f.row("a.md").unwrap();
    assert!(after.indexed_at > before, "the row was not refreshed");
    assert_eq!(after.content_hash, Some(content_hash("same text\n")));
}

/// A row without a hash (here: the device had no key when the file was found) is seeded once
/// it can be.
#[test]
fn a_row_without_a_hash_is_seeded_once_the_device_has_a_key() {
    let mut f = fixture();
    f.applier.feed = None;
    f.write("a.md", "found without a key\n");
    assert_eq!(f.added("a.md"), Step::Done);
    let id = only_note(&f, "a.md");
    assert_eq!(f.hash_of("a.md"), None);
    f.applier.feed = f.vault.external_feed(f.store.clone()).ok();
    assert_eq!(f.walked("a.md"), Step::Done);
    assert!(
        f.body(&id).contains("found without a key"),
        "{}",
        f.body(&id)
    );
    assert_eq!(
        f.hash_of("a.md"),
        Some(content_hash("found without a key\n"))
    );
}
