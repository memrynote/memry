//! The record cases of Electron's `canvas/folder-store.test.ts` on a real
//! `data.db`: what each folder write leaves in `canvas_folders`, `canvases`
//! and the outbox. The directory cases are the shell's
//! (`memry-desktop/tests/canvas_folders.rs`).

use rusqlite::{Connection, params};

use super::{FolderWriteError, create, delete, relocate, set_icon, stored_path};
use crate::domain::canvas::folder_paths::CanvasFolderError;
use crate::domain::canvas::{self, NewCanvas};
use crate::domain::canvas_folder::{self, CanvasFolder, ITEM_TYPE, sync_id};
use crate::domain::desktop_records::testing::{DEVICE, NOW, open};

const VAULT: &str = "vault-1";

fn live_paths(conn: &Connection) -> Vec<String> {
    canvas_folder::list(conn)
        .expect("list")
        .into_iter()
        .map(|folder| folder.path)
        .collect()
}

fn folder(conn: &Connection, path: &str) -> CanvasFolder {
    canvas_folder::get(conn, path)
        .expect("get")
        .expect("live folder")
}

fn new_canvas(conn: &Connection, title: &str, folder: Option<&str>) -> String {
    let canvas = NewCanvas {
        title: Some(title),
        folder,
        ..NewCanvas::default()
    };
    canvas::create(conn, &canvas, VAULT, DEVICE, NOW)
        .expect("create canvas")
        .canvas
        .id
}

fn canvas_folder_of(conn: &Connection, id: &str) -> Option<Option<String>> {
    canvas::get(conn, id)
        .expect("get")
        .map(|canvas| canvas.folder)
}

/// Every outbox op queued for one record, oldest first.
fn ops(conn: &Connection, item_type: &str, id: &str) -> Vec<String> {
    let mut statement = conn
        .prepare("SELECT op FROM outbox WHERE item_type = ?1 AND item_id = ?2 ORDER BY id")
        .expect("prepare");
    statement
        .query_map(params![item_type, id], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("ops")
}

fn clear_outbox(conn: &Connection) {
    conn.execute("DELETE FROM outbox", [])
        .expect("clear outbox");
}

#[test]
fn create_writes_the_folder_and_a_record_for_every_ancestor() {
    let (db, _dir) = open("cf-create");
    db.call_blocking(|conn| {
        let made = create(conn, VAULT, "A/B/C", DEVICE, NOW).expect("create");
        assert_eq!(made.path, "A/B/C");
        assert_eq!(made.id, sync_id("A/B/C"));
        assert_eq!(live_paths(conn), ["A", "A/B", "A/B/C"]);
        for path in ["A", "A/B", "A/B/C"] {
            assert_eq!(ops(conn, ITEM_TYPE, &sync_id(path)), ["upsert"], "{path}");
        }
        Ok(())
    })
    .expect("db");
}

#[test]
fn create_of_an_existing_folder_in_any_case_returns_it_and_queues_nothing() {
    let (db, _dir) = open("cf-create-existing");
    db.call_blocking(|conn| {
        create(conn, VAULT, "Work", DEVICE, NOW).expect("create");
        clear_outbox(conn);
        let again = create(conn, VAULT, "work", DEVICE, NOW + 1).expect("again");
        assert_eq!(again.path, "Work");
        assert_eq!(live_paths(conn), ["Work"]);
        assert!(ops(conn, ITEM_TYPE, &sync_id("Work")).is_empty());
        assert_eq!(
            stored_path(conn, Some("WORK")).expect("stored"),
            Some("Work".to_owned())
        );
        assert_eq!(
            stored_path(conn, Some("Other")).expect("stored"),
            Some("Other".to_owned())
        );
        assert_eq!(stored_path(conn, None).expect("stored"), None);
        Ok(())
    })
    .expect("db");
}

#[test]
fn create_revives_a_deleted_folder_but_leaves_a_deleted_ancestor_deleted() {
    let (db, _dir) = open("cf-revive");
    db.call_blocking(|conn| {
        create(conn, VAULT, "Keep/Gone", DEVICE, NOW).expect("create");
        delete(conn, VAULT, "Keep", DEVICE, NOW + 1).expect("delete");
        assert!(live_paths(conn).is_empty());
        create(conn, VAULT, "Keep/Gone", DEVICE, NOW + 2).expect("revive");
        // Electron's `insertFolderRowIfAbsent`: the user deleted `Keep` on
        // purpose, so only the leaf comes back.
        assert_eq!(live_paths(conn), ["Keep/Gone"]);
        Ok(())
    })
    .expect("db");
}

#[test]
fn a_rename_rewrites_descendants_and_canvases_but_not_a_prefix_lookalike() {
    let (db, _dir) = open("cf-rename");
    db.call_blocking(|conn| {
        create(conn, VAULT, "Work/Q3", DEVICE, NOW).expect("create");
        create(conn, VAULT, "Workshop", DEVICE, NOW).expect("lookalike");
        let inside = new_canvas(conn, "Plan", Some("Work/Q3"));
        let at_root = new_canvas(conn, "Loose", Some("Work"));
        let lookalike = new_canvas(conn, "Tools", Some("Workshop"));
        clear_outbox(conn);

        let from = folder(conn, "Work");
        let moved = relocate(conn, VAULT, &from, "Jobs", DEVICE, NOW + 1).expect("relocate");
        assert_eq!(moved.folder.path, "Jobs");
        assert_eq!(live_paths(conn), ["Jobs", "Jobs/Q3", "Workshop"]);
        assert_eq!(
            canvas_folder_of(conn, &inside),
            Some(Some("Jobs/Q3".into()))
        );
        assert_eq!(canvas_folder_of(conn, &at_root), Some(Some("Jobs".into())));
        assert_eq!(
            canvas_folder_of(conn, &lookalike),
            Some(Some("Workshop".into()))
        );
        let mut carried: Vec<_> = moved.canvases.iter().map(|(id, _)| id.clone()).collect();
        carried.sort();
        let mut expected = vec![inside.clone(), at_root.clone()];
        expected.sort();
        assert_eq!(carried, expected);

        // The old records are deleted, the new ones and the canvases queued.
        assert_eq!(ops(conn, ITEM_TYPE, &sync_id("Work")), ["delete"]);
        assert_eq!(ops(conn, ITEM_TYPE, &sync_id("Work/Q3")), ["delete"]);
        assert_eq!(ops(conn, ITEM_TYPE, &sync_id("Jobs")), ["upsert"]);
        assert_eq!(ops(conn, ITEM_TYPE, &sync_id("Jobs/Q3")), ["upsert"]);
        assert_eq!(ops(conn, canvas::ITEM_TYPE, &inside), ["upsert"]);
        assert!(ops(conn, canvas::ITEM_TYPE, &lookalike).is_empty());
        Ok(())
    })
    .expect("db");
}

#[test]
fn a_case_only_rename_keeps_the_record_and_never_queues_a_delete() {
    let (db, _dir) = open("cf-case");
    db.call_blocking(|conn| {
        create(conn, VAULT, "work/q3", DEVICE, NOW).expect("create");
        clear_outbox(conn);
        let from = folder(conn, "work");
        let moved = relocate(conn, VAULT, &from, "Work", DEVICE, NOW + 1).expect("relocate");
        assert_eq!(moved.folder.id, from.id);
        assert_eq!(moved.folder.path, "Work");
        assert_eq!(live_paths(conn), ["Work", "Work/q3"]);
        assert_eq!(ops(conn, ITEM_TYPE, &sync_id("work")), ["upsert"]);
        assert_eq!(ops(conn, ITEM_TYPE, &sync_id("work/q3")), ["upsert"]);
        Ok(())
    })
    .expect("db");
}

#[test]
fn a_move_carries_the_icon_mints_the_new_parents_and_can_return_to_the_root() {
    let (db, _dir) = open("cf-move");
    db.call_blocking(|conn| {
        create(conn, VAULT, "Inbox", DEVICE, NOW).expect("create");
        set_icon(conn, VAULT, "Inbox", Some("star"), DEVICE, NOW).expect("icon");
        let from = folder(conn, "Inbox");
        let moved = relocate(conn, VAULT, &from, "Archive/2026/Inbox", DEVICE, NOW + 1)
            .expect("move under");
        assert_eq!(moved.folder.icon.as_deref(), Some("star"));
        assert_eq!(
            live_paths(conn),
            ["Archive", "Archive/2026", "Archive/2026/Inbox"]
        );

        let back = relocate(conn, VAULT, &moved.folder, "Inbox", DEVICE, NOW + 2).expect("back");
        assert_eq!(back.folder.path, "Inbox");
        assert_eq!(back.folder.icon.as_deref(), Some("star"));
        assert_eq!(live_paths(conn), ["Archive", "Archive/2026", "Inbox"]);
        Ok(())
    })
    .expect("db");
}

#[test]
fn a_move_into_its_own_subtree_or_onto_a_live_folder_is_refused_and_moves_nothing() {
    let (db, _dir) = open("cf-refuse");
    db.call_blocking(|conn| {
        create(conn, VAULT, "A/B", DEVICE, NOW).expect("create");
        create(conn, VAULT, "Taken", DEVICE, NOW).expect("create");
        let canvas = new_canvas(conn, "Plan", Some("A"));
        clear_outbox(conn);
        let from = folder(conn, "A");
        let descendant = relocate(conn, VAULT, &from, "A/B/A", DEVICE, NOW + 1);
        assert!(matches!(
            descendant,
            Err(FolderWriteError::Refused(CanvasFolderError::Descendant))
        ));
        let taken = relocate(conn, VAULT, &from, "taken", DEVICE, NOW + 1);
        assert!(matches!(
            taken,
            Err(FolderWriteError::Refused(CanvasFolderError::Exists))
        ));
        assert_eq!(live_paths(conn), ["A", "A/B", "Taken"]);
        assert_eq!(canvas_folder_of(conn, &canvas), Some(Some("A".into())));
        let queued: i64 = conn
            .query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))
            .expect("count");
        assert_eq!(queued, 0);
        Ok(())
    })
    .expect("db");
}

#[test]
fn a_move_that_pushes_a_child_past_the_depth_cap_is_refused_and_moves_nothing() {
    let (db, _dir) = open("cf-depth");
    db.call_blocking(|conn| {
        create(conn, VAULT, "A/B/C/D/E", DEVICE, NOW).expect("create");
        let from = folder(conn, "A");
        let deep = relocate(conn, VAULT, &from, "X/Y/Z/W/A", DEVICE, NOW + 1);
        assert!(matches!(
            deep,
            Err(FolderWriteError::Refused(CanvasFolderError::Depth))
        ));
        assert_eq!(
            live_paths(conn),
            ["A", "A/B", "A/B/C", "A/B/C/D", "A/B/C/D/E"]
        );
        Ok(())
    })
    .expect("db");
}

#[test]
fn set_icon_sets_and_clears_and_answers_none_for_no_live_folder() {
    let (db, _dir) = open("cf-icon");
    db.call_blocking(|conn| {
        create(conn, VAULT, "Work", DEVICE, NOW).expect("create");
        clear_outbox(conn);
        let set = set_icon(conn, VAULT, "work", Some("star"), DEVICE, NOW + 1).expect("set");
        assert_eq!(set.and_then(|folder| folder.icon).as_deref(), Some("star"));
        assert_eq!(ops(conn, ITEM_TYPE, &sync_id("Work")), ["upsert"]);
        let cleared = set_icon(conn, VAULT, "Work", None, DEVICE, NOW + 2).expect("clear");
        assert_eq!(cleared.and_then(|folder| folder.icon), None);
        assert_eq!(
            set_icon(conn, VAULT, "Nope", Some("x"), DEVICE, NOW).expect("none"),
            None
        );
        Ok(())
    })
    .expect("db");
}

#[test]
fn delete_tombstones_the_folder_its_descendants_and_canvases_and_spares_a_lookalike() {
    let (db, _dir) = open("cf-delete");
    db.call_blocking(|conn| {
        create(conn, VAULT, "Work/Q3", DEVICE, NOW).expect("create");
        create(conn, VAULT, "Workshop", DEVICE, NOW).expect("lookalike");
        let inside = new_canvas(conn, "Plan", Some("Work/Q3"));
        let kept = new_canvas(conn, "Tools", Some("Workshop"));
        clear_outbox(conn);
        let deleted = delete(conn, VAULT, "Work", DEVICE, NOW + 1).expect("delete");
        assert_eq!(deleted, std::slice::from_ref(&inside));
        assert_eq!(live_paths(conn), ["Workshop"]);
        assert_eq!(canvas_folder_of(conn, &inside), None);
        assert_eq!(canvas_folder_of(conn, &kept), Some(Some("Workshop".into())));
        assert_eq!(ops(conn, ITEM_TYPE, &sync_id("Work")), ["delete"]);
        assert_eq!(ops(conn, ITEM_TYPE, &sync_id("Work/Q3")), ["delete"]);
        assert_eq!(ops(conn, canvas::ITEM_TYPE, &inside), ["delete"]);
        Ok(())
    })
    .expect("db");
}

#[test]
fn delete_writes_a_deleted_record_for_every_level_that_had_none() {
    let (db, _dir) = open("cf-implied");
    db.call_blocking(|conn| {
        // Directories a peer knows only from where its canvases sit.
        let deep = new_canvas(conn, "Deep", Some("Root/Mid/Leaf"));
        create(conn, VAULT, "Root/Mid/Leaf/Below", DEVICE, NOW).expect("create");
        // `Root` and `Root/Mid` were minted as ancestors; drop them so only
        // the canvas implies them.
        for path in ["Root", "Root/Mid", "Root/Mid/Leaf"] {
            conn.execute(
                "DELETE FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
                params![ITEM_TYPE, sync_id(path)],
            )
            .expect("drop record");
            conn.execute(
                "DELETE FROM canvas_folders WHERE id = ?1",
                params![sync_id(path)],
            )
            .expect("drop row");
        }
        clear_outbox(conn);
        let deleted = delete(conn, VAULT, "Root", DEVICE, NOW + 1).expect("delete");
        assert_eq!(deleted, [deep]);
        assert!(live_paths(conn).is_empty());
        for path in ["Root", "Root/Mid", "Root/Mid/Leaf", "Root/Mid/Leaf/Below"] {
            assert_eq!(ops(conn, ITEM_TYPE, &sync_id(path)), ["delete"], "{path}");
            let deleted_at: Option<i64> = conn
                .query_row(
                    "SELECT deleted_at FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
                    params![ITEM_TYPE, sync_id(path)],
                    |row| row.get(0),
                )
                .expect("record");
            assert!(deleted_at.is_some(), "{path}");
        }
        Ok(())
    })
    .expect("db");
}
