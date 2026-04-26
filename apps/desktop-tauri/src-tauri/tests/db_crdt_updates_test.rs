use memry_desktop_tauri_lib::db::crdt_updates::{
    append, drop_through, list_for_note, max_seq, MAX_BLOB_BYTES,
};
use memry_desktop_tauri_lib::test_helpers::open_in_memory_with_migrations;

#[test]
fn append_and_list_in_seq_order_with_origin() {
    let conn = open_in_memory_with_migrations();

    assert_eq!(append(&conn, "n", &[1, 2], 7).unwrap(), 1);
    assert_eq!(append(&conn, "n", &[3, 4], 9).unwrap(), 2);
    append(&conn, "other", &[5], 11).unwrap();

    let rows = list_for_note(&conn, "n").unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].note_id, "n");
    assert_eq!(rows[0].seq, 1);
    assert_eq!(rows[0].update_bytes, vec![1, 2]);
    assert_eq!(rows[0].origin, 7);
    assert_eq!(rows[1].seq, 2);
    assert_eq!(rows[1].update_bytes, vec![3, 4]);
    assert_eq!(rows[1].origin, 9);
    assert!(!rows[0].created_at.is_empty());
}

#[test]
fn max_seq_returns_zero_for_empty_and_tracks_note_scope() {
    let conn = open_in_memory_with_migrations();

    assert_eq!(max_seq(&conn, "missing").unwrap(), 0);
    append(&conn, "n", &[1], 1).unwrap();
    append(&conn, "n", &[2], 1).unwrap();
    append(&conn, "other", &[3], 1).unwrap();

    assert_eq!(max_seq(&conn, "n").unwrap(), 2);
    assert_eq!(max_seq(&conn, "other").unwrap(), 1);
}

#[test]
fn drop_through_removes_inclusive_range_for_one_note() {
    let conn = open_in_memory_with_migrations();
    for i in 0..5 {
        append(&conn, "n", &[i as u8], 1).unwrap();
    }
    append(&conn, "other", &[9], 1).unwrap();

    drop_through(&conn, "n", 3).unwrap();

    let rows = list_for_note(&conn, "n").unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].seq, 4);
    assert_eq!(rows[1].seq, 5);
    assert_eq!(max_seq(&conn, "other").unwrap(), 1);
}

#[test]
fn rejects_oversized_payload() {
    let conn = open_in_memory_with_migrations();
    let too_big = vec![0u8; MAX_BLOB_BYTES + 1];

    let err = append(&conn, "n", &too_big, 1).unwrap_err();
    let msg = format!("{err:?}");

    assert!(msg.to_lowercase().contains("validation"));
    assert_eq!(max_seq(&conn, "n").unwrap(), 0);
}
