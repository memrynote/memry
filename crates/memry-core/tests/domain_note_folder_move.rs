//! A folder the desktop app renames or moves, against real SQLite (Step 13h, #3530): every
//! note in it recorded first, then records, rows, folder records and manual order in one
//! transaction.
//!
//! | Test                                                         | Rule                               |
//! | ------------------------------------------------------------ | ---------------------------------- |
//! | a folder move moves its notes, rows, records and order       | `renameFolderCommand`, one step    |
//! | a folder move whose transaction fails changes nothing        | the tier moves the folder back     |
//! | the moves of a folder are recorded all or none               | one move per note                  |
//! | a note the move makes another kind of file is left owed      | Step 13m, as a note's own move     |

#![cfg(feature = "markdown")]

#[allow(unused_imports)]
use crate::note_identity_support;

use memry_core::domain::folders;
use memry_core::domain::note_files;
use memry_core::domain::notes::app_move::{self, AppMoved, BeginError};
use memry_core::domain::notes::identity;
use note_identity_support::{
    DEVICE, NOW, clear_outbox, create, give_row, open, outbox, payload, place, position, run,
};
use serde_json::json;

fn row_path(db: &memry_core::storage::Db, id: &str) -> Option<String> {
    run(db, |conn| note_files::by_id(conn, id)).map(|row| row.path)
}

fn live_folders(db: &memry_core::storage::Db) -> Vec<(String, Option<String>)> {
    run(db, |conn| {
        let mut statement = conn
            .prepare("SELECT path, icon FROM folders WHERE deleted_at IS NULL ORDER BY path")
            .unwrap();
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap();
        Ok(rows.map(Result::unwrap).collect())
    })
}

fn pending(db: &memry_core::storage::Db) -> Vec<String> {
    run(db, |conn| app_move::pending(conn))
        .into_iter()
        .map(|(id, _)| id)
        .collect()
}

fn moved<'a>(old_path: &'a str, new_path: &'a str) -> AppMoved<'a> {
    AppMoved {
        old_path,
        new_path,
        title: None,
        keeps_kind: true,
    }
}

/// `Work` holding `Plan.md` and `Sub/Deep.md`, both folders recorded, `Work` with an icon, and
/// the root and `Work` ordered by hand.
fn work(label: &str) -> memry_core::storage::Db {
    let db = open(label);
    create(&db, "n1", "Plan", Some("Work"));
    create(&db, "n2", "Deep", Some("Work/Sub"));
    give_row(&db, "n1", "Work/Plan.md");
    give_row(&db, "n2", "Work/Sub/Deep.md");
    run(&db, |conn| {
        folders::create(conn, "Work", Some("book"), DEVICE, NOW)?.acknowledge();
        folders::create(conn, "Work/Sub", None, DEVICE, NOW)?.acknowledge();
        Ok(())
    });
    place(&db, "", &["Other", "Work"]);
    place(&db, "Work", &["Work/Sub", "Work/Plan.md"]);
    clear_outbox(&db);
    db
}

#[test]
fn a_folder_move_moves_its_notes_rows_records_and_order() {
    let db = work("folder-move");
    let moves = [
        ("n1", moved("Work/Plan.md", "Projects/Plan.md")),
        ("n2", moved("Work/Sub/Deep.md", "Projects/Sub/Deep.md")),
    ];
    run(&db, |conn| Ok(app_move::begin_all(conn, &moves))).unwrap();
    assert_eq!(pending(&db), ["n1", "n2"]);

    run(&db, |conn| {
        app_move::folder_moved_by_app(conn, "Work", "Projects", &moves, DEVICE, NOW + 1)
    });

    assert_eq!(payload(&db, "n1")["folderPath"], json!("Projects"));
    assert_eq!(payload(&db, "n2")["folderPath"], json!("Projects/Sub"));
    assert_eq!(payload(&db, "n1")["title"], json!("Plan"));
    assert_eq!(row_path(&db, "n1").as_deref(), Some("Projects/Plan.md"));
    assert_eq!(row_path(&db, "n2").as_deref(), Some("Projects/Sub/Deep.md"));
    assert_eq!(pending(&db), Vec::<String>::new());
    assert_eq!(
        live_folders(&db),
        [
            ("Projects".to_owned(), Some("book".to_owned())),
            ("Projects/Sub".to_owned(), None)
        ]
    );
    let mut pushed = outbox(&db);
    pushed.sort();
    let expected = [
        ("delete", "Work"),
        ("delete", "Work/Sub"),
        ("upsert", "Projects"),
        ("upsert", "Projects/Sub"),
        ("upsert", "n1"),
        ("upsert", "n2"),
    ]
    .map(|(op, id)| (op.to_owned(), id.to_owned()));
    assert_eq!(pushed, expected);
    assert_eq!(position(&db, "Projects"), Some((String::new(), 1)));
    assert_eq!(position(&db, "Projects/Sub"), Some(("Projects".into(), 0)));
    assert_eq!(
        position(&db, "Projects/Plan.md"),
        Some(("Projects".into(), 1))
    );
    assert_eq!(position(&db, "Work/Plan.md"), None);
}

#[test]
fn a_folder_move_whose_transaction_fails_changes_nothing() {
    let db = work("folder-move-refused");
    create(&db, "n3", "Squatter", None);
    give_row(&db, "n3", "Projects/Sub/Deep.md");
    let moves = [
        ("n1", moved("Work/Plan.md", "Projects/Plan.md")),
        ("n2", moved("Work/Sub/Deep.md", "Projects/Sub/Deep.md")),
    ];
    run(&db, |conn| Ok(app_move::begin_all(conn, &moves))).unwrap();

    let refused = db.call_blocking(|conn| {
        app_move::folder_moved_by_app(conn, "Work", "Projects", &moves, DEVICE, NOW + 1)
    });
    assert!(refused.is_err());
    assert_eq!(payload(&db, "n1")["folderPath"], json!("Work"));
    assert_eq!(row_path(&db, "n1").as_deref(), Some("Work/Plan.md"));
    assert_eq!(
        pending(&db),
        ["n1", "n2"],
        "the tier forgets them after the put-back"
    );
    assert_eq!(live_folders(&db)[0].0, "Work");
    assert_eq!(position(&db, "Work/Plan.md"), Some(("Work".into(), 1)));
}

#[test]
fn the_moves_of_a_folder_are_recorded_all_or_none() {
    let db = work("folder-move-begin");
    run(&db, |conn| {
        Ok(app_move::begin(
            conn,
            "n2",
            &moved("Work/Sub/Deep.md", "Elsewhere.md"),
        ))
    })
    .unwrap();
    let moves = [
        ("n1", moved("Work/Plan.md", "Projects/Plan.md")),
        ("n2", moved("Work/Sub/Deep.md", "Projects/Sub/Deep.md")),
    ];
    let refused = run(&db, |conn| Ok(app_move::begin_all(conn, &moves)));
    assert!(matches!(refused, Err(BeginError::Unsettled)), "{refused:?}");
    assert_eq!(pending(&db), ["n2"]);
}

#[test]
fn a_note_the_move_makes_another_kind_of_file_is_left_owed() {
    let db = work("folder-move-owed");
    let moves = [
        ("n1", moved("Work/Plan.md", "Projects/Plan.md")),
        (
            "n2",
            AppMoved {
                keeps_kind: false,
                ..moved("Work/Sub/Deep.md", "Projects/Sub/Deep.md")
            },
        ),
    ];
    run(&db, |conn| Ok(app_move::begin_all(conn, &moves))).unwrap();
    run(&db, |conn| {
        app_move::folder_moved_by_app(conn, "Work", "Projects", &moves, DEVICE, NOW + 1)
    });
    assert_eq!(payload(&db, "n2")["folderPath"], json!("Work/Sub"));
    assert_eq!(row_path(&db, "n2").as_deref(), Some("Projects/Sub/Deep.md"));
    let owed: Vec<(String, String)> = run(&db, |conn| identity::owed_places(conn))
        .into_iter()
        .map(|owed| (owed.note_id, owed.from_path))
        .collect();
    assert_eq!(owed, [("n2".to_owned(), "Work/Sub/Deep.md".to_owned())]);
}
