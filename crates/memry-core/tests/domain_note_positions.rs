//! Manual sidebar order on a real SQLite file (desktop Step 13).
//!
//! | Test                                                     | Rule                                      |
//! | -------------------------------------------------------- | ----------------------------------------- |
//! | a reorder is the order of the folder, all or nothing      | `reorderNotesInFolder`                    |
//! | a new item takes the slot above every ordered sibling     | `placeNewItemAtTop`, #1646                |
//! | a folder nobody ordered gets no row for a new item         | the implicit order is not frozen          |
//! | a rename carries the slot, a move does not                 | `carryPositionToPath`                     |
//! | a folder rename re-keys its subtree, not a sibling prefix  | `carryFolderPositions`                    |
//! | a folder named with `%` or `_` matches only itself         | no `LIKE`                                 |
//! | a deleted folder drops its rows and a new one inherits none| `dropFolderPositions`                     |
//! | the rows survive a reopen                                  | device-local, durable                     |

use memry_core::api::errors::StorageError;
use memry_core::domain::note_positions::{self as positions, NotePosition};
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;

fn open(dir: &std::path::Path) -> Db {
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn scratch(label: &str) -> std::path::PathBuf {
    tempfile::Builder::new()
        .prefix(&format!("memry-positions-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep()
}

fn run<T: Send + 'static>(
    db: &Db,
    f: impl FnOnce(&mut Connection) -> Result<T, StorageError> + Send + 'static,
) -> T {
    db.call_blocking(f).expect("a database call")
}

fn order(db: &Db, folder: &'static str) -> Vec<(String, i64)> {
    run(db, move |conn| {
        Ok(positions::for_folder(conn, folder)?
            .into_iter()
            .map(|row| (row.path, row.position))
            .collect())
    })
}

fn all(db: &Db) -> Vec<NotePosition> {
    run(db, |conn| positions::all(conn))
}

fn reorder(db: &Db, folder: &'static str, paths: &[&str]) {
    let paths: Vec<String> = paths.iter().map(|p| (*p).to_owned()).collect();
    run(db, move |conn| positions::reorder(conn, folder, &paths));
}

fn pairs(rows: &[(&str, i64)]) -> Vec<(String, i64)> {
    rows.iter().map(|(p, n)| ((*p).to_owned(), *n)).collect()
}

fn place(db: &Db, item: &'static str, folder: &'static str) {
    run(db, move |conn| positions::place_at_top(conn, item, folder));
}

fn carry(db: &Db, old: &'static str, new: &'static str) {
    run(db, move |conn| positions::carry(conn, old, new));
}

fn carry_folder(db: &Db, old: &'static str, new: &'static str) {
    run(db, move |conn| positions::carry_folder(conn, old, new));
}

fn paths_of(rows: Vec<NotePosition>) -> Vec<(String, String, i64)> {
    rows.into_iter()
        .map(|row| (row.path, row.folder_path, row.position))
        .collect()
}

fn triples(rows: &[(&str, &str, i64)]) -> Vec<(String, String, i64)> {
    rows.iter()
        .map(|(p, f, n)| ((*p).to_owned(), (*f).to_owned(), *n))
        .collect()
}

#[test]
fn a_reorder_is_the_order_of_the_folder() {
    let db = open(&scratch("reorder"));
    reorder(&db, "Notes", &["Notes/b.md", "Notes/a.md", "Notes/c.md"]);
    assert_eq!(
        order(&db, "Notes"),
        pairs(&[("Notes/b.md", 0), ("Notes/a.md", 1), ("Notes/c.md", 2)])
    );
    reorder(&db, "Notes", &["Notes/c.md", "Notes/b.md", "Notes/a.md"]);
    assert_eq!(
        order(&db, "Notes"),
        pairs(&[("Notes/c.md", 0), ("Notes/b.md", 1), ("Notes/a.md", 2)])
    );
    assert!(order(&db, "").is_empty(), "another folder is untouched");
}

#[test]
fn a_new_item_takes_the_slot_above_every_ordered_sibling() {
    let db = open(&scratch("top"));
    reorder(&db, "Notes", &["Notes/b.md", "Notes/a.md"]);

    place(&db, "Notes/new.md", "Notes");

    assert_eq!(
        order(&db, "Notes"),
        pairs(&[("Notes/new.md", -1), ("Notes/b.md", 0), ("Notes/a.md", 1)])
    );
    place(&db, "Notes/newer.md", "Notes");
    assert_eq!(order(&db, "Notes")[0], ("Notes/newer.md".to_owned(), -2));
}

#[test]
fn a_folder_nobody_ordered_gets_no_row_and_a_stale_row_is_cleared() {
    let db = open(&scratch("implicit"));
    reorder(&db, "Old", &["Old/x.md"]);

    place(&db, "Fresh/n.md", "Fresh");
    assert!(order(&db, "Fresh").is_empty(), "the implicit order stays");

    // An earlier item left a row at the path a new item now takes.
    place(&db, "Old/x.md", "Old");
    assert!(
        order(&db, "Old").is_empty(),
        "the only ordered item was the one being placed: nothing to sit above"
    );
}

#[test]
fn a_rename_carries_the_slot_and_nothing_else_moves() {
    let db = open(&scratch("carry"));
    reorder(&db, "Notes", &["Notes/a.md", "Notes/b.md", "Notes/c.md"]);

    carry(&db, "Notes/b.md", "Notes/renamed.md");

    assert_eq!(
        order(&db, "Notes"),
        pairs(&[
            ("Notes/a.md", 0),
            ("Notes/renamed.md", 1),
            ("Notes/c.md", 2)
        ])
    );
    carry(&db, "Notes/never-ordered.md", "Notes/x.md");
    assert_eq!(order(&db, "Notes").len(), 3, "no row appears from nothing");
}

#[test]
fn a_folder_rename_rekeys_the_subtree_and_not_a_sibling_sharing_the_prefix() {
    let db = open(&scratch("folder"));
    reorder(&db, "", &["a", "ab", "z"]);
    reorder(&db, "a", &["a/n1.md", "a/sub"]);
    reorder(&db, "a/sub", &["a/sub/deep.md"]);
    reorder(&db, "ab", &["ab/keep.md"]);

    carry_folder(&db, "a", "moved/b");

    assert_eq!(
        paths_of(all(&db)),
        triples(&[
            ("ab", "", 1),
            ("ab/keep.md", "ab", 0),
            ("moved/b", "moved", 0),
            ("moved/b/n1.md", "moved/b", 0),
            ("moved/b/sub", "moved/b", 1),
            ("moved/b/sub/deep.md", "moved/b/sub", 0),
            ("z", "", 2),
        ])
    );
}

#[test]
fn a_folder_with_percent_and_underscore_in_its_name_matches_only_itself() {
    let db = open(&scratch("like"));
    reorder(&db, "50%_off", &["50%_off/a.md"]);
    reorder(&db, "50xxoff", &["50xxoff/b.md"]);

    run(&db, |conn| {
        positions::drop_folder(conn, "50%_off").map(drop)
    });

    assert_eq!(
        paths_of(all(&db)),
        triples(&[("50xxoff/b.md", "50xxoff", 0)])
    );
}

#[test]
fn a_deleted_folder_drops_its_rows_so_a_new_one_inherits_no_order() {
    let db = open(&scratch("drop"));
    reorder(&db, "", &["Notes", "Other"]);
    reorder(&db, "Notes", &["Notes/a.md"]);
    reorder(&db, "Notes/sub", &["Notes/sub/b.md"]);

    let dropped = run(&db, |conn| positions::drop_folder(conn, "Notes"));

    assert_eq!(dropped, 3);
    assert_eq!(paths_of(all(&db)), triples(&[("Other", "", 1)]));
}

#[test]
fn the_rows_survive_a_reopen() {
    let dir = scratch("reopen");
    let db = open(&dir);
    reorder(&db, "Notes", &["Notes/a.md", "Notes/b.md"]);
    drop(db);

    let again = open(&dir);
    assert_eq!(
        order(&again, "Notes"),
        pairs(&[("Notes/a.md", 0), ("Notes/b.md", 1)])
    );
}
