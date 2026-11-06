//! The size class of a note's file, recorded at every read the consumer makes of it (#3531
//! 14c-2): a watcher's `Added` or `Changed` and the open walk. The editor opens the note
//! read-only from it and refuses a window's edit, with nothing stored or queued.

use memry_core::api::editor::{EditorError, ReadOnly};
use memry_core::markdown::shared::markdown_class::{NOTE_MAX_BLOCK_BYTES, NOTE_MAX_BYTES};

use super::*;

fn large(f: &Fixture, id: &str) -> bool {
    f.vault.note_files().is_large_file(id).unwrap()
}

/// Short paragraphs past the byte ceiling: large by size, every block small.
fn past_the_ceiling() -> String {
    "word\n\n".repeat(NOTE_MAX_BYTES / 6 + 1)
}

/// One block past the block bound in a file far under the ceiling: large by its blocks only.
fn one_huge_block() -> String {
    format!("{}\n", "x".repeat(NOTE_MAX_BLOCK_BYTES + 1))
}

/// A window's edit of the document whose state is `state`: one more text in its body.
fn typed(state: &[u8]) -> Vec<u8> {
    use yrs::updates::decoder::Decode as _;
    use yrs::{ReadTxn as _, Transact as _, XmlFragment as _};
    let doc = yrs::Doc::with_client_id(1);
    let body = doc.get_or_insert_xml_fragment(BODY_FRAGMENT);
    let state = yrs::Update::decode_v1(state).unwrap();
    doc.transact_mut().apply_update(state).unwrap();
    let before = doc.transact().state_vector();
    body.push_back(&mut doc.transact_mut(), yrs::XmlTextPrelim::new("typed"));
    doc.transact().encode_diff_v1(&before)
}

fn outbox_rows(f: &Fixture, id: &str) -> i64 {
    let id = id.to_owned();
    f.vault
        .db_handle()
        .read_blocking(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT COUNT(*) FROM outbox WHERE item_id = ?1",
                    [id],
                    |r| r.get(0),
                )
                .unwrap())
        })
        .unwrap()
}

#[test]
fn a_file_that_grows_past_the_class_and_shrinks_back_turns_the_editor_off_and_on() {
    let f = fixture();
    f.write("a.md", "small\n");
    f.added("a.md");
    let id = only_note(&f, "a.md");
    let editor = f.vault.editor(f.store.clone()).unwrap();
    assert_eq!(editor.open(&id, "main").unwrap().read_only, None);

    f.write("a.md", &past_the_ceiling());
    assert_eq!(f.changed(&id, "a.md"), Step::Done);
    assert!(large(&f, &id), "grown past the byte ceiling");
    let opened = editor.open(&id, "main").unwrap();
    assert_eq!(opened.read_only, Some(ReadOnly::LargeFile));
    let queued = outbox_rows(&f, &id);
    let edit = typed(&opened.state);
    assert_eq!(
        editor.apply_update(&id, &edit, "main"),
        Err(EditorError::LargeFile {
            note_id: id.clone()
        })
    );
    assert_eq!(outbox_rows(&f, &id), queued, "nothing queued");

    f.write("a.md", "small again\n");
    assert_eq!(f.changed(&id, "a.md"), Step::Done);
    assert!(!large(&f, &id), "shrunk back");
    assert_eq!(editor.open(&id, "main").unwrap().read_only, None);
    assert!(editor.apply_update(&id, &edit, "main").unwrap().is_some());

    f.write("a.md", &one_huge_block());
    assert_eq!(f.changed(&id, "a.md"), Step::Done);
    assert!(large(&f, &id), "one block past the bound");
}

/// A file that grew while the app was closed is read by the next open's walk, which records
/// its class before any window opens the note.
#[test]
fn the_open_walk_records_the_class_of_a_file_that_grew_while_closed() {
    let f = fixture();
    f.write("a.md", "small\n");
    f.added("a.md");
    let id = only_note(&f, "a.md");

    f.write("a.md", &past_the_ceiling());
    assert_eq!(f.walked("a.md"), Step::Done);
    assert!(large(&f, &id));
}

#[test]
fn a_new_file_past_the_class_is_recorded_large() {
    let f = fixture();
    f.write("big.md", &past_the_ceiling());
    assert_eq!(f.added("big.md"), Step::Done);
    assert!(large(&f, &only_note(&f, "big.md")));
}

/// A file the consumer cannot read whole (past the read cap, not UTF-8) is large by its size.
#[test]
fn a_file_too_large_to_read_is_recorded_large_by_its_size() {
    let f = fixture();
    f.write("a.md", "small\n");
    f.added("a.md");
    let id = only_note(&f, "a.md");

    std::fs::write(f.root.join("a.md"), vec![0xff; NOTE_MAX_BYTES + 1]).unwrap();
    assert_eq!(f.changed(&id, "a.md"), Step::Retry("a.md".into()));
    assert!(large(&f, &id));
}

/// A new file large by its frontmatter alone takes a note in the walk's batch (its body is
/// small), and its row names its bytes, so no later walk reads it again: the batch records it.
#[test]
fn a_file_large_by_its_frontmatter_created_in_the_walks_batch_is_recorded_large() {
    let f = fixture();
    *f.identity.batch.lock().unwrap() = Batch::Create;
    let big = format!(
        "---\nnotes: {}\n---\nsmall\n",
        "a".repeat(NOTE_MAX_BLOCK_BYTES + 1)
    );
    f.write("big.md", &big);
    f.write("small.md", "small\n");

    let steps = f.walk_together(&["big.md", "small.md"]);
    assert!(
        steps.iter().all(|(_, step)| *step == Step::Done),
        "{steps:?}"
    );
    assert!(large(&f, &only_note(&f, "big.md")));
    assert!(!large(&f, &only_note(&f, "small.md")));
}
