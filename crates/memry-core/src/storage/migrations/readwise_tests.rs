//! Data migration 0038, `readwise`, and the store over its tables (`domain::readwise`), on a
//! real SQLite database.

use super::*;
use crate::domain::readwise::{
    self, LinkKey, LinkState, ReadwiseItem, UpsertLink, parse_readwise_url,
};
use crate::domain::readwise_highlights::{self, IndexRow, Record};
use crate::storage::Db;

fn failed(err: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: err.to_string(),
    }
}

fn migrated() -> Db {
    let db = Db::open_in_memory().expect("open");
    db.call_blocking(|conn| run(conn, DATA_MIGRATIONS))
        .expect("migrate");
    db
}

fn upsert(db: &Db, book: Option<i64>, document: Option<&str>, note: &str) -> readwise::Link {
    let (document, note) = (document.map(str::to_owned), note.to_owned());
    db.call_blocking(move |conn| {
        let input = UpsertLink {
            book_id: book,
            document_id: document.as_deref(),
            note_id: &note,
            state: LinkState::Linked,
        };
        readwise::upsert_link(conn, &input, 7)
    })
    .expect("upsert")
}

/// A database the last build left gains the three tables with its rows kept, a re-run after a
/// crash before the `user_version` write changes nothing, and the build before reads the file.
#[test]
fn the_readwise_migration_keeps_rows_reruns_and_leaves_the_file_readable() {
    let db = Db::open_in_memory().expect("open");
    let before = DATA_MIGRATIONS
        .iter()
        .position(|m| m.name == "readwise")
        .expect("the readwise migration");
    db.call_blocking(|conn| run(conn, &DATA_MIGRATIONS[..before]))
        .expect("a database as the last build left it");
    db.call_blocking(|conn| {
        conn.execute_batch(
            "INSERT INTO note_files (note_id, path, indexed_at) VALUES ('n1', 'a.md', 1);",
        )
        .map_err(failed)
    })
    .expect("a row to keep");
    assert_eq!(
        db.call_blocking(|conn| run(conn, DATA_MIGRATIONS)).unwrap(),
        latest_version(DATA_MIGRATIONS)
    );
    upsert(&db, Some(1), None, "n1");
    // A crash between the commit and the `user_version` write runs the SQL again.
    db.call_blocking(|conn| {
        conn.execute_batch(DATA_MIGRATIONS[before].sql)
            .map_err(failed)
    })
    .expect("re-run");
    let counts = db
        .read_blocking(|conn| {
            let count = |table: &str| -> Result<i64, StorageError> {
                conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                    .map_err(failed)
            };
            Ok((count("note_files")?, count("readwise_links")?))
        })
        .unwrap();
    assert_eq!(counts, (1, 1));
    // The build before knows only the tables it made: nothing it reads changed shape.
    let older = db
        .read_blocking(|conn| {
            conn.query_row(
                "SELECT path FROM note_files WHERE note_id = 'n1'",
                [],
                |r| r.get::<_, String>(0),
            )
            .map_err(failed)
        })
        .unwrap();
    assert_eq!(older, "a.md");
}

#[test]
fn a_link_found_by_either_id_keeps_its_row_and_gains_the_other() {
    let db = migrated();
    let reader = upsert(&db, None, Some("doc"), "reader-note");
    let book = upsert(&db, Some(5), Some("doc"), "reader-note");
    assert_eq!(book.id, reader.id);
    assert_eq!(book.readwise_book_id, Some(5));
    assert_eq!(book.updated_at, 7);

    // Another row holds `other`: this one keeps its own document and the index holds.
    let other = upsert(&db, None, Some("other"), "second");
    let kept = upsert(&db, Some(5), Some("other"), "reader-note");
    assert_eq!(kept.id, book.id);
    assert_eq!(kept.reader_document_id.as_deref(), Some("doc"));
    assert_ne!(other.id, kept.id);

    let found = db
        .read_blocking(|conn| readwise::link_for_book(conn, 9, Some("other")))
        .unwrap();
    assert_eq!(found.map(|l| l.note_id).as_deref(), Some("second"));
    let neither = db.call_blocking(|conn| {
        let input = UpsertLink {
            book_id: None,
            document_id: None,
            note_id: "n",
            state: LinkState::Linked,
        };
        readwise::upsert_link(conn, &input, 1)
    });
    assert!(neither.is_err());
}

#[test]
fn completing_a_link_skips_an_id_another_row_holds() {
    let db = migrated();
    let reader = upsert(&db, None, Some("doc"), "a");
    upsert(&db, Some(3), None, "b");
    db.call_blocking(|conn| readwise::complete_link(conn, &reader, 3, None, 9))
        .unwrap();
    let still = db
        .read_blocking(|conn| readwise::link_by_note(conn, "a"))
        .unwrap()
        .unwrap();
    assert_eq!(still.readwise_book_id, None);
    db.call_blocking(|conn| readwise::complete_link(conn, &reader, 4, None, 9))
        .unwrap();
    let done = db
        .read_blocking(|conn| readwise::link_by_note(conn, "a"))
        .unwrap()
        .unwrap();
    assert_eq!(done.readwise_book_id, Some(4));
    assert_eq!(done.updated_at, 9);
}

#[test]
fn a_state_change_names_its_row_and_an_unknown_state_is_kept() {
    let db = migrated();
    upsert(&db, Some(1), None, "a");
    let marked = db
        .call_blocking(|conn| {
            readwise::mark_link_state(conn, &LinkKey::Book(1), &LinkState::NoteDeleted, 2)
        })
        .unwrap();
    assert_eq!(marked.map(|l| l.state), Some(LinkState::NoteDeleted));
    let none = db
        .call_blocking(|conn| {
            readwise::mark_link_state(conn, &LinkKey::Book(2), &LinkState::Linked, 2)
        })
        .unwrap();
    assert_eq!(none, None);
    db.call_blocking(|conn| {
        conn.execute("UPDATE readwise_links SET state = 'future'", [])
            .map_err(failed)
    })
    .unwrap();
    let listed = db
        .read_blocking(|conn| readwise::links(conn, Some(&LinkState::Linked)))
        .unwrap();
    assert!(listed.is_empty());
    let all = db
        .read_blocking(|conn| readwise::links(conn, None))
        .unwrap();
    assert_eq!(all[0].state, LinkState::Other("future".into()));
}

#[test]
fn a_rebuild_links_the_lowest_note_and_keeps_a_deleted_source() {
    let db = migrated();
    upsert(&db, Some(1), None, "old");
    db.call_blocking(|conn| {
        readwise::mark_link_state(conn, &LinkKey::Book(1), &LinkState::SourceDeleted, 1)?;
        upsert_note_deleted(conn)
    })
    .unwrap();
    let urls = vec![
        ("n3".into(), "https://readwise.io/bookreview/1".into()),
        (
            "n2".into(),
            " https://www.readwise.io/bookreview/2/ ".into(),
        ),
        ("n1".into(), "https://readwise.io/bookreview/2".into()),
        ("n4".into(), "https://read.readwise.io/read/abc_D-1".into()),
        ("n5".into(), "not a url".into()),
    ];
    let linked = db
        .call_blocking(move |conn| readwise::rebuild_links(conn, urls, 5))
        .unwrap();
    assert_eq!(linked, 3);
    let all = db
        .read_blocking(|conn| readwise::links(conn, None))
        .unwrap();
    let view: Vec<_> = all
        .iter()
        .map(|l| {
            (
                l.readwise_book_id,
                l.reader_document_id.clone(),
                l.note_id.as_str(),
                l.state.clone(),
            )
        })
        .collect();
    assert_eq!(
        view,
        [
            (Some(1), None, "n3", LinkState::SourceDeleted),
            (Some(2), None, "n1", LinkState::Linked),
            (None, Some("abc_D-1".into()), "n4", LinkState::Linked),
        ]
    );
}

fn upsert_note_deleted(conn: &mut rusqlite::Connection) -> Result<(), StorageError> {
    let input = UpsertLink {
        book_id: Some(2),
        document_id: None,
        note_id: "gone",
        state: LinkState::NoteDeleted,
    };
    readwise::upsert_link(conn, &input, 1).map(drop)
}

#[test]
fn a_readwise_url_names_a_book_or_a_reader_document_and_nothing_else() {
    for (url, item) in [
        (
            "https://readwise.io/bookreview/12",
            Some(ReadwiseItem::Book(12)),
        ),
        (
            "http://www.readwise.io/bookreview/12/",
            Some(ReadwiseItem::Book(12)),
        ),
        (
            "\u{feff} https://read.readwise.io/read/a_B-9\n",
            Some(ReadwiseItem::ReaderDocument("a_B-9".into())),
        ),
        ("https://readwise.io/bookreview/", None),
        ("https://readwise.io/bookreview/1x", None),
        ("https://readwise.io/bookreview/99999999999999999999", None),
        ("https://READWISE.io/bookreview/1", None),
        ("https://read.readwise.io/read/a b", None),
        ("https://read.readwise.io/read/a//", None),
        ("ftp://readwise.io/bookreview/1", None),
        ("https://evil.test/readwise.io/bookreview/1", None),
    ] {
        assert_eq!(parse_readwise_url(url), item, "{url:?}");
    }
    let long = format!("https://read.readwise.io/read/{}", "a".repeat(600));
    assert_eq!(parse_readwise_url(&long), None);
}

#[test]
fn run_state_keeps_the_text_it_was_given_until_deleted() {
    let db = migrated();
    let get = |db: &Db| {
        db.read_blocking(|conn| readwise::run_state(conn, "cursor"))
            .unwrap()
    };
    assert_eq!(get(&db), None);
    db.call_blocking(|conn| {
        readwise::set_run_state(conn, "cursor", Some("2024-01-01T00:00:00.000Z"), 1)
    })
    .unwrap();
    db.call_blocking(|conn| readwise::set_run_state(conn, "cursor", Some("b"), 2))
        .unwrap();
    assert_eq!(get(&db).as_deref(), Some("b"));
    db.call_blocking(|conn| readwise::set_run_state(conn, "cursor", None, 3))
        .unwrap();
    assert_eq!(get(&db), None);
}

fn row(id: i64, book: i64, at: Option<&str>, created: Option<&str>, deleted: bool) -> IndexRow {
    IndexRow {
        highlight_id: id,
        book_id: book,
        highlighted_at: at.map(str::to_owned),
        created_at: created.map(str::to_owned),
        deleted,
    }
}

fn record(db: &Db, rows: &[IndexRow], rebuild: bool, deleted_books: &[i64]) -> Vec<i64> {
    let record = Record {
        rows,
        rebuild,
        deleted_books,
        ready_key: "highlightIndex",
        pending_key: "journalPending",
    };
    let mut seen = Vec::new();
    db.call_blocking(|conn| {
        readwise_highlights::record(conn, &record, 5, |known, stored| {
            seen = known.iter().copied().collect();
            seen.sort_unstable();
            Some(format!("{}+", stored.unwrap_or_default()))
        })
    })
    .unwrap();
    seen
}

fn live(db: &Db, from: &str, to: &str) -> Vec<(i64, i64, String)> {
    db.read_blocking(|conn| readwise_highlights::between(conn, from, to))
        .unwrap()
        .into_iter()
        .map(|h| (h.highlight_id, h.book_id, h.at))
        .collect()
}

fn state(db: &Db, key: &str) -> Option<String> {
    db.read_blocking(|conn| readwise::run_state(conn, key))
        .unwrap()
}

#[test]
fn the_highlight_index_tells_known_ids_and_keeps_the_pending_days_beside_it() {
    let db = migrated();
    let first = [
        row(1, 10, Some("2026-01-02T10:00:00.000Z"), None, false),
        row(2, 10, None, Some("2026-01-02T11:00:00.000Z"), false),
    ];
    assert_eq!(record(&db, &first, false, &[]), Vec::<i64>::new());
    assert_eq!(state(&db, "journalPending").as_deref(), Some("+"));
    assert_eq!(state(&db, "highlightIndex"), None);
    let second = [row(2, 10, None, None, false), row(3, 11, None, None, false)];
    assert_eq!(record(&db, &second, false, &[]), vec![2]);
    assert_eq!(state(&db, "journalPending").as_deref(), Some("++"));
    // An upsert overwrote 2's dates; 1 is kept.
    assert_eq!(
        live(&db, "2026-01-01", "2026-01-03"),
        vec![(1, 10, "2026-01-02T10:00:00.000Z".to_owned())]
    );
}

#[test]
fn a_full_export_replaces_the_index_and_a_deleted_book_hides_every_highlight() {
    let db = migrated();
    let old = [
        row(1, 10, Some("2026-01-02T10:00:00.000Z"), None, false),
        row(9, 12, Some("2026-01-02T12:00:00.000Z"), None, false),
    ];
    record(&db, &old, false, &[]);
    let full = [
        row(1, 10, Some("2026-01-02T10:00:00.000Z"), None, false),
        row(4, 11, None, Some("2026-01-02T09:00:00.000Z"), false),
        row(5, 11, Some("2026-01-02T08:00:00.000Z"), None, true),
    ];
    record(&db, &full, true, &[]);
    assert_eq!(state(&db, "highlightIndex").as_deref(), Some("ready"));
    assert_eq!(
        live(&db, "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z"),
        vec![
            (1, 10, "2026-01-02T10:00:00.000Z".to_owned()),
            (4, 11, "2026-01-02T09:00:00.000Z".to_owned()),
        ]
    );
    // The book's highlight the payload did not list goes with it; the window end is exclusive.
    record(&db, &[], false, &[10]);
    assert_eq!(
        live(&db, "2026-01-02T00:00:00.000Z", "2026-01-02T09:00:00.000Z"),
        Vec::new()
    );
    assert_eq!(
        live(&db, "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z"),
        vec![(4, 11, "2026-01-02T09:00:00.000Z".to_owned())]
    );
}

#[test]
fn an_empty_pending_list_deletes_its_key() {
    let db = migrated();
    record(&db, &[], false, &[]);
    let record_none = Record {
        rows: &[],
        rebuild: false,
        deleted_books: &[],
        ready_key: "highlightIndex",
        pending_key: "journalPending",
    };
    db.call_blocking(|conn| readwise_highlights::record(conn, &record_none, 6, |_, _| None))
        .unwrap();
    assert_eq!(state(&db, "journalPending"), None);
}
