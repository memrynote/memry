//! New files the open walk applies together (#3530 13q-7): what each file ends as when the
//! identity creates their notes together, when the batch fails, when their rows cannot be
//! written together, when one is too large for a note, and when one changes after it was read.

use super::*;

const PATHS: [&str; 3] = ["a.md", "b.md", "c.md"];

fn text(rel: &str) -> String {
    format!("# {rel}\n\nThe text of {rel}.\n")
}

fn batch_of(f: &Fixture, batch: Batch) {
    for rel in PATHS {
        f.write(rel, &text(rel));
    }
    *f.identity.batch.lock().unwrap() = batch;
}

fn steps_done() -> Vec<(String, Step)> {
    PATHS
        .iter()
        .map(|p| ((*p).to_owned(), Step::Done))
        .collect()
}

fn note_count(f: &Fixture) -> i64 {
    f.vault
        .db_handle()
        .call_blocking(|conn| {
            Ok(conn
                .query_row("SELECT count(*) FROM notes", [], |row| row.get(0))
                .unwrap())
        })
        .unwrap()
}

#[test]
fn files_created_together_get_their_notes_bodies_and_rows() {
    let mut f = fixture();
    batch_of(&f, Batch::Create);
    assert_eq!(f.walk_together(&PATHS), steps_done());
    assert!(
        f.adopted().is_empty(),
        "a file went alone: {:?}",
        f.adopted()
    );
    for rel in PATHS {
        let row = f.row(rel).expect("a row");
        let hash = Some(content_hash(&text(rel)));
        assert_eq!(
            (row.content_hash.clone(), row.file_hash),
            (hash.clone(), hash)
        );
        assert_eq!(f.body(&row.note_id), text(rel).trim_end());
    }
    let added = f
        .facts()
        .into_iter()
        .filter(|fact| {
            matches!(
                fact,
                Applied::Added {
                    created: true,
                    source: ChangeSource::Walk,
                    ..
                }
            )
        })
        .count();
    assert_eq!(added, PATHS.len());
}

/// The batch's error writes nothing, and every file is asked about alone.
#[test]
fn a_batch_that_fails_leaves_each_file_to_the_one_file_path() {
    let f = fixture();
    batch_of(&f, Batch::Fail);
    assert_eq!(f.walk_together(&PATHS), steps_done());
    let mut adopted = f.adopted();
    adopted.sort();
    assert_eq!(adopted, PATHS);
    assert_eq!(note_count(&f), 3);
    for rel in PATHS {
        let row = f.row(rel).expect("a row");
        assert_eq!(f.body(&row.note_id), text(rel).trim_end());
    }
}

/// Rows written all or none: when one cannot be, none is, and each file is offered again,
/// to find its note, which no row names.
#[test]
fn rows_that_cannot_be_written_together_are_retried_file_by_file() {
    let f = fixture();
    batch_of(&f, Batch::CreateThenTake("c.md".into()));
    let retried: Vec<(String, Step)> = PATHS
        .iter()
        .map(|p| ((*p).to_owned(), Step::Retry((*p).to_owned())))
        .collect();
    assert_eq!(f.walk_together(&PATHS), retried);
    assert!(f.row("a.md").is_none() && f.row("b.md").is_none());
    assert!(f.adopted().is_empty());
    // The three notes and the one holding `c.md`.
    assert_eq!(note_count(&f), 4);
}

/// A file whose size makes it large-file class goes alone, among new files the identity
/// would create together.
#[test]
fn a_large_file_goes_alone() {
    let f = fixture();
    batch_of(&f, Batch::Create);
    let large = "x".repeat(1024 * 1024 + 1);
    f.write("big.md", &large);
    let mut paths = PATHS.to_vec();
    paths.push("big.md");
    let mut want = steps_done();
    want.insert(2, ("big.md".to_owned(), Step::Done));
    assert_eq!(f.walk_together(&paths), want);
    assert_eq!(f.adopted(), ["big.md"]);
}

fn outbox_items(f: &Fixture) -> Vec<String> {
    f.vault
        .db_handle()
        .call_blocking(|conn| {
            let mut statement = conn.prepare("SELECT item_id FROM outbox").unwrap();
            Ok(statement
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<Vec<String>, _>>()
                .unwrap())
        })
        .unwrap()
}

/// A file deleted after the batch read it, which no row names and so no fact reports, gets no
/// note, no row and nothing queued for sync; the others are created together.
#[test]
fn a_file_deleted_after_the_batch_read_it_gets_no_note() {
    let f = fixture();
    batch_of(&f, Batch::Create);
    let mut steps = f.walk_together_with(&PATHS, || {
        std::fs::remove_file(f.root.join("b.md")).unwrap();
    });
    steps.retain(|(path, _)| path != "b.md");
    let mut want = steps_done();
    want.retain(|(path, _)| path != "b.md");
    assert_eq!(steps, want);
    assert!(f.row("b.md").is_none());
    assert_eq!(note_count(&f), 2);
    let notes: Vec<String> = ["a.md", "c.md"]
        .iter()
        .map(|rel| f.row(rel).expect("a row").note_id)
        .collect();
    let queued = outbox_items(&f);
    assert!(
        queued.iter().all(|item| notes.contains(item)),
        "{queued:?} beyond {notes:?}"
    );
}

/// A file edited after the batch read it goes alone, so its note takes the bytes the file has.
#[test]
fn a_file_edited_after_the_batch_read_it_goes_alone() {
    let f = fixture();
    batch_of(&f, Batch::Create);
    let edited = "# b.md\n\nThe text of b.md, edited after the read.\n";
    assert_eq!(
        f.walk_together_with(&PATHS, || f.write("b.md", edited)),
        steps_done()
    );
    assert_eq!(f.adopted(), ["b.md"]);
    let row = f.row("b.md").expect("a row");
    assert_eq!(f.body(&row.note_id), edited.trim_end());
}
