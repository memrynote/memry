//! Desktop's bookmark handlers over real SQLite: every write queues its push,
//! positions follow desktop's rules, and the list resolves as
//! `resolveBookmarkItem` does.

use rusqlite::{Connection, params};
use serde_json::Value;

use super::*;
use crate::storage::Db;
use crate::storage::migrations::{DATA_MIGRATIONS, run};

const DEVICE: &str = "device-a";

fn with_db(test: impl FnOnce(&Connection) -> Result<(), StorageError>) {
    let db = Db::open_in_memory().expect("open");
    db.call_blocking(|conn| run(conn, DATA_MIGRATIONS))
        .expect("migrate");
    db.call_blocking(|conn| test(conn)).expect("test");
}

fn created(conn: &Connection, item_type: &str, item_id: &str, now: i64) -> Bookmark {
    match create(conn, item_type, item_id, DEVICE, now).expect("create") {
        Created::Created(bookmark) => bookmark,
        Created::AlreadyBookmarked => panic!("{item_type} {item_id} was already bookmarked"),
    }
}

/// `(item_id, op)` of every queued push, in order.
fn outbox(conn: &Connection) -> Vec<(String, String)> {
    let mut statement = conn
        .prepare("SELECT item_id, op FROM outbox WHERE item_type = 'bookmark' ORDER BY id")
        .expect("prepare");
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

fn positions(conn: &Connection) -> Vec<(String, i64)> {
    let mut statement = conn
        .prepare("SELECT item_id, position FROM bookmarks WHERE deleted_at IS NULL ORDER BY position, id")
        .expect("prepare");
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

fn clock(conn: &Connection, id: &str) -> Value {
    let payload: String = conn
        .query_row(
            "SELECT payload FROM sync_items WHERE item_type = 'bookmark' AND item_id = ?1",
            params![id],
            |row| row.get(0),
        )
        .expect("payload");
    serde_json::from_str::<Value>(&payload).expect("json")["clock"].clone()
}

fn all(conn: &Connection) -> Page {
    page(
        conn,
        &PageQuery {
            item_type: None,
            sort_by: SortBy::Position,
            descending: false,
            limit: 100,
            offset: 0,
        },
    )
    .expect("page")
}

#[test]
fn create_appends_queues_and_answers_an_already_bookmarked_item_as_a_result() {
    with_db(|conn| {
        let first = created(conn, "note", "n1", 1);
        assert_eq!(first.id, "bmk_note_n1");
        assert_eq!(first.position, 0);
        assert_eq!(first.created_at, Some(1));
        assert_eq!(created(conn, "folder", "a/b", 2).position, 1);
        assert_eq!(
            create(conn, "note", "n1", DEVICE, 3)?,
            Created::AlreadyBookmarked
        );
        assert!(matches!(
            create(conn, "note", "", DEVICE, 3),
            Err(StorageError::Invalid { .. })
        ));
        assert_eq!(
            outbox(conn),
            [
                ("bmk_note_n1".to_owned(), "upsert".to_owned()),
                ("bmk_folder_a/b".to_owned(), "upsert".to_owned()),
            ]
        );
        Ok(())
    });
}

/// A legacy desktop row under a random id counts as the item's bookmark.
#[test]
fn an_item_bookmarked_under_an_older_id_is_already_bookmarked_and_toggles_off_entirely() {
    with_db(|conn| {
        created(conn, "note", "n1", 1);
        conn.execute(
            "UPDATE sync_items SET item_id = 'legacy' WHERE item_id = 'bmk_note_n1'",
            [],
        )
        .map_err(failed)?;
        conn.execute(
            "UPDATE bookmarks SET id = 'legacy' WHERE id = 'bmk_note_n1'",
            [],
        )
        .map_err(failed)?;
        assert_eq!(
            create(conn, "note", "n1", DEVICE, 2)?,
            Created::AlreadyBookmarked
        );
        assert_eq!(
            get_by_item(conn, "note", "n1")?.map(|b| b.id),
            Some("legacy".to_owned())
        );
        let Toggled::Removed(removed) = toggle_rows(conn, "note", "n1", DEVICE, 3)? else {
            panic!("the toggle bookmarked the item again");
        };
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].id, "legacy");
        assert!(!is_bookmarked(conn, "note", "n1")?);
        Ok(())
    });
}

#[test]
fn delete_tombstones_once_and_a_later_create_revives_the_same_id() {
    with_db(|conn| {
        created(conn, "tag", "ideas", 1);
        let clock_before = clock(conn, "bmk_tag_ideas");
        let deleted = delete(conn, "bmk_tag_ideas", DEVICE, 2)?;
        assert_eq!(deleted.map(|b| b.item_id), Some("ideas".to_owned()));
        // The outbox keeps one row per item, holding the latest operation.
        assert_eq!(
            outbox(conn),
            [("bmk_tag_ideas".to_owned(), "delete".to_owned())]
        );
        assert_eq!(delete(conn, "bmk_tag_ideas", DEVICE, 3)?, None);
        assert_eq!(delete(conn, "nope", DEVICE, 3)?, None);
        assert_ne!(clock(conn, "bmk_tag_ideas"), clock_before);
        assert_eq!(get(conn, "bmk_tag_ideas")?, None);

        let revived = created(conn, "tag", "ideas", 4);
        assert_eq!(revived.id, "bmk_tag_ideas");
        assert_eq!(revived.created_at, Some(4));
        assert_eq!(
            outbox(conn),
            [("bmk_tag_ideas".to_owned(), "upsert".to_owned())]
        );
        Ok(())
    });
}

/// `reorderBookmarks`: the position is the index in the input, and an
/// unknown id leaves a gap instead of shifting the rest.
#[test]
fn reorder_sets_each_position_to_its_input_index_and_skips_unknown_ids() {
    with_db(|conn| {
        for (index, id) in ["a", "b", "c"].iter().enumerate() {
            created(conn, "tag", id, index as i64);
        }
        let clock_before = clock(conn, "bmk_tag_a");
        conn.execute("DELETE FROM outbox", []).map_err(failed)?;
        let order: Vec<String> = ["bmk_tag_c", "gone", "bmk_tag_a", "bmk_tag_b"]
            .iter()
            .map(|id| (*id).to_owned())
            .collect();
        reorder(conn, &order, DEVICE, 10)?;
        assert_eq!(
            positions(conn),
            [
                ("c".to_owned(), 0),
                ("a".to_owned(), 2),
                ("b".to_owned(), 3)
            ]
        );
        assert_ne!(clock(conn, "bmk_tag_a"), clock_before);
        let queued: Vec<String> = outbox(conn).into_iter().map(|(id, _)| id).collect();
        assert_eq!(queued, ["bmk_tag_c", "bmk_tag_a", "bmk_tag_b"]);
        Ok(())
    });
}

#[test]
fn bulk_create_skips_bookmarked_and_repeated_items_and_bulk_delete_skips_unknown_ids() {
    with_db(|conn| {
        created(conn, "note", "n1", 1);
        let items: Vec<(String, String)> = [
            ("note", "n1"),
            ("note", "n2"),
            ("folder", "f"),
            ("note", "n2"),
        ]
        .iter()
        .map(|(t, i)| ((*t).to_owned(), (*i).to_owned()))
        .collect();
        let made = bulk_create(conn, &items, DEVICE, 2)?;
        let made: Vec<(String, i64)> = made.into_iter().map(|b| (b.item_id, b.position)).collect();
        assert_eq!(made, [("n2".to_owned(), 1), ("f".to_owned(), 2)]);

        let bad = [("note".to_owned(), String::new())];
        assert!(matches!(
            bulk_create(conn, &bad, DEVICE, 3),
            Err(StorageError::Invalid { .. })
        ));

        let ids = [
            "bmk_note_n1".to_owned(),
            "nope".to_owned(),
            "bmk_folder_f".to_owned(),
        ];
        let deleted = bulk_delete(conn, &ids, DEVICE, 4)?;
        assert_eq!(deleted.len(), 2);
        assert_eq!(positions(conn), [("n2".to_owned(), 1)]);
        Ok(())
    });
}

#[test]
fn the_page_resolves_each_type_and_answers_orphans_unresolved() {
    with_db(|conn| {
        conn.execute_batch(
            "INSERT INTO notes (id, title, emoji) VALUES ('n1', 'Roadmap', '🌱');
             INSERT INTO notes (id, title, deleted_at) VALUES ('gone', 'Gone', 5);
             INSERT INTO note_files (note_id, path, indexed_at) VALUES ('n1', 'notes/Roadmap.md', 1);
             INSERT INTO note_tags (note_id, tag, position) VALUES ('n1', 'work', 0);
             INSERT INTO journal_entries (id, date) VALUES ('j2026-01-13', '2026-01-13');
             INSERT INTO tasks (id, title, project_id, tags) VALUES ('t1', 'Call', 'p', '[\"home\"]');",
        )
        .map_err(failed)?;
        for (index, (item_type, item_id)) in [
            ("note", "n1"),
            ("journal", "j2026-01-13"),
            ("task", "t1"),
            ("folder", "a/b"),
            ("tag", "ideas"),
            ("note", "gone"),
            ("canvas", "c1"),
        ]
        .iter()
        .enumerate()
        {
            created(conn, item_type, item_id, index as i64);
        }
        let listed = all(conn);
        assert_eq!(listed.total, 7);
        let resolved: Vec<Option<Resolved>> =
            listed.bookmarks.into_iter().map(|(_, r)| r).collect();
        assert_eq!(
            resolved[0],
            Some(Resolved {
                title: "Roadmap".to_owned(),
                path: Some("notes/Roadmap.md".to_owned()),
                emoji: Some("🌱".to_owned()),
                tags: vec!["work".to_owned()],
            })
        );
        assert_eq!(
            resolved[1].as_ref().map(|r| r.title.as_str()),
            Some("2026-01-13")
        );
        assert_eq!(
            resolved[2].as_ref().map(|r| r.tags.clone()),
            Some(vec!["home".to_owned()])
        );
        assert_eq!(
            resolved[3],
            Some(Resolved {
                title: "b".to_owned(),
                path: Some("a/b".to_owned()),
                ..Resolved::default()
            })
        );
        assert_eq!(
            resolved[4].as_ref().map(|r| r.title.as_str()),
            Some("ideas")
        );
        assert_eq!(resolved[5], None);
        assert_eq!(resolved[6], None);
        // The phone's list hides what does not resolve.
        assert_eq!(list(conn)?.len(), 5);
        Ok(())
    });
}

#[test]
fn the_page_filters_sorts_and_pages() {
    with_db(|conn| {
        created(conn, "tag", "a", 30);
        created(conn, "folder", "f", 10);
        created(conn, "tag", "b", 20);
        let query = |item_type: Option<&str>, sort_by, descending, limit, offset| {
            let page = page(
                conn,
                &PageQuery {
                    item_type: item_type.map(str::to_owned),
                    sort_by,
                    descending,
                    limit,
                    offset,
                },
            )
            .expect("page");
            let ids: Vec<String> = page.bookmarks.into_iter().map(|(b, _)| b.item_id).collect();
            (ids, page.total)
        };
        assert_eq!(
            query(Some("tag"), SortBy::Position, false, 100, 0),
            (vec!["a".to_owned(), "b".to_owned()], 2)
        );
        assert_eq!(
            query(None, SortBy::CreatedAt, true, 100, 0).0,
            ["a", "b", "f"]
        );
        assert_eq!(
            query(None, SortBy::Position, false, 1, 1),
            (vec!["f".to_owned()], 3)
        );
        Ok(())
    });
}
