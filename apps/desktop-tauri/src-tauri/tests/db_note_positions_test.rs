use memry_desktop_tauri_lib::db::note_positions::{
    drop_for_note, get_all, get_for_folder, move_for_note, reorder,
};
use memry_desktop_tauri_lib::test_helpers::open_in_memory_with_migrations;

#[test]
fn reorder_writes_positions() {
    let conn = open_in_memory_with_migrations();
    reorder(
        &conn,
        "Inbox",
        &["a.md".into(), "b.md".into(), "c.md".into()],
    )
    .unwrap();

    let pos = get_for_folder(&conn, "Inbox").unwrap();
    assert_eq!(pos.get("a.md").copied(), Some(0));
    assert_eq!(pos.get("b.md").copied(), Some(1));
    assert_eq!(pos.get("c.md").copied(), Some(2));
}

#[test]
fn reorder_replaces_previous_state_for_folder() {
    let conn = open_in_memory_with_migrations();
    reorder(&conn, "Inbox", &["a.md".into(), "b.md".into()]).unwrap();
    reorder(
        &conn,
        "Inbox",
        &["b.md".into(), "a.md".into(), "c.md".into()],
    )
    .unwrap();

    let pos = get_for_folder(&conn, "Inbox").unwrap();
    assert_eq!(pos.get("b.md").copied(), Some(0));
    assert_eq!(pos.get("a.md").copied(), Some(1));
    assert_eq!(pos.get("c.md").copied(), Some(2));
    assert_eq!(pos.len(), 3);
}

#[test]
fn reorder_preserves_other_position_rows_in_same_parent() {
    let conn = open_in_memory_with_migrations();
    reorder(&conn, "", &["notes/root.md".into()]).unwrap();
    reorder(&conn, "", &["Projects".into(), "Archive".into()]).unwrap();

    let pos = get_for_folder(&conn, "").unwrap();
    assert_eq!(pos.get("notes/root.md").copied(), Some(0));
    assert_eq!(pos.get("Projects").copied(), Some(0));
    assert_eq!(pos.get("Archive").copied(), Some(1));
}

#[test]
fn get_all_returns_flat_map_keyed_by_path() {
    let conn = open_in_memory_with_migrations();
    reorder(&conn, "Inbox", &["a.md".into(), "b.md".into()]).unwrap();
    reorder(&conn, "Projects", &["c.md".into()]).unwrap();

    let all = get_all(&conn).unwrap();
    assert_eq!(all.get("a.md").copied(), Some(0));
    assert_eq!(all.get("c.md").copied(), Some(0));
    assert_eq!(all.len(), 3);
}

#[test]
fn drop_for_note_removes_position() {
    let conn = open_in_memory_with_migrations();
    reorder(&conn, "Inbox", &["a.md".into(), "b.md".into()]).unwrap();
    drop_for_note(&conn, "a.md").unwrap();

    let pos = get_for_folder(&conn, "Inbox").unwrap();
    assert!(!pos.contains_key("a.md"));
    assert_eq!(pos.get("b.md").copied(), Some(1));
}

#[test]
fn move_for_note_updates_path_and_folder() {
    let conn = open_in_memory_with_migrations();
    reorder(&conn, "Inbox", &["Inbox/a.md".into()]).unwrap();

    move_for_note(&conn, "Inbox/a.md", "Archive/a.md", "notes").unwrap();

    assert!(get_for_folder(&conn, "Inbox").unwrap().is_empty());
    let archive = get_for_folder(&conn, "Archive").unwrap();
    assert_eq!(archive.get("Archive/a.md").copied(), Some(0));
}

#[test]
fn move_for_note_strips_custom_notes_root_from_folder_path() {
    let conn = open_in_memory_with_migrations();
    reorder(&conn, "Inbox", &["Custom/Inbox/a.md".into()]).unwrap();

    move_for_note(&conn, "Custom/Inbox/a.md", "Custom/Archive/a.md", "Custom").unwrap();

    assert!(get_for_folder(&conn, "Inbox").unwrap().is_empty());
    let archive = get_for_folder(&conn, "Archive").unwrap();
    assert_eq!(archive.get("Custom/Archive/a.md").copied(), Some(0));
}
