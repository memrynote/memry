use super::*;
use crate::storage::migrations::DATA_MIGRATIONS;

#[test]
fn create_migrates_both_files_without_a_journal() {
    let dir = tempfile::tempdir().unwrap();
    let writer = ImportWriter::create(dir.path()).unwrap();
    for (db, expected) in [
        (Staged::Data, migrations::latest_version(DATA_MIGRATIONS)),
        (Staged::Index, migrations::latest_version(INDEX_MIGRATIONS)),
    ] {
        let conn = writer.conn(db);
        assert_eq!(migrations::user_version(conn).unwrap(), expected);
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "off");
    }
    assert!(writer.integrity_problems().unwrap().is_empty());
}

#[test]
fn create_refuses_a_leftover_file() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(INDEX_FILE), b"").unwrap();
    assert!(ImportWriter::create(dir.path()).is_err());
}

#[test]
fn the_marker_reads_back_after_finish() {
    let dir = tempfile::tempdir().unwrap();
    let writer = ImportWriter::create(dir.path()).unwrap();
    writer.finish(r#"{"version":1}"#).unwrap();
    assert_eq!(
        read_marker(&dir.path().join(DATA_FILE)).unwrap().as_deref(),
        Some(r#"{"version":1}"#)
    );
}

#[test]
fn a_native_data_db_has_no_marker_and_is_not_changed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DATA_FILE);
    let db = crate::storage::open_data(&path).unwrap();
    drop(db);
    let before = std::fs::read(&path).unwrap();
    assert_eq!(read_marker(&path).unwrap(), None);
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn an_unreadable_data_db_is_an_error_not_a_missing_marker() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DATA_FILE);
    std::fs::write(&path, vec![7u8; 4096]).unwrap();
    assert!(read_marker(&path).is_err());
}

#[test]
fn row_count_refuses_a_name_that_is_not_a_table() {
    let dir = tempfile::tempdir().unwrap();
    let writer = ImportWriter::create(dir.path()).unwrap();
    assert_eq!(writer.row_count(Staged::Data, "meta").unwrap(), 0);
    assert!(matches!(
        writer.row_count(Staged::Data, "meta\" WHERE 1; --"),
        Err(StorageError::NotFound { .. })
    ));
}

fn folder(id: &str, payload: &str, synced_at: Option<i64>) -> ImportRecord {
    ImportRecord {
        item_type: "folder_config",
        item_id: id.to_owned(),
        payload: payload.to_owned(),
        synced_at,
    }
}

#[test]
fn a_record_is_stored_verbatim_and_projected_with_its_clock_text() {
    let dir = tempfile::tempdir().unwrap();
    let mut writer = ImportWriter::create(dir.path()).unwrap();
    let payload = r#"{"icon":"star","clock":{"dev-b":3,"dev-a":1},"createdAt":"2026-01-02T03:04:05.000Z","modifiedAt":"2026-01-02T03:04:05.000Z"}"#;
    writer
        .put_records(
            &[
                folder("Projects/Äb", payload, Some(42)),
                folder("x", r#"{"icon":null}"#, None),
            ],
            7,
        )
        .unwrap();
    let (stored, clock): (String, Option<String>) = writer
        .data
        .query_row(
            "SELECT payload, clock FROM sync_items WHERE item_type = 'folder_config' AND item_id = 'Projects/Äb'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(stored, payload);
    assert_eq!(clock.as_deref(), Some(r#"{"dev-b":3,"dev-a":1}"#));
    let synced: Vec<(String, i64)> = writer
        .data
        .prepare("SELECT path, synced_at FROM folders ORDER BY path")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        synced,
        vec![("Projects/Äb".to_owned(), 42), ("x".to_owned(), 7)]
    );
    assert_eq!(
        writer.record_clocks("folder_config").unwrap(),
        vec![
            (
                "Projects/Äb".to_owned(),
                Some(r#"{"dev-b":3,"dev-a":1}"#.to_owned())
            ),
            ("x".to_owned(), None)
        ]
    );
}

#[test]
fn an_unreadable_record_fails_the_batch_and_names_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut writer = ImportWriter::create(dir.path()).unwrap();
    let error = writer
        .put_records(
            &[
                folder("ok", r#"{"icon":null}"#, None),
                folder("bad", r#"{"icon":null,"clock":{"d":"one"}}"#, None),
            ],
            7,
        )
        .unwrap_err();
    assert!(error.to_string().contains("folder_config/bad"), "{error}");
    assert_eq!(writer.row_count(Staged::Data, "sync_items").unwrap(), 0);
    assert_eq!(writer.row_count(Staged::Data, "folders").unwrap(), 0);
}

#[test]
fn the_vault_id_is_stored_verbatim_and_must_be_a_uuid() {
    let dir = tempfile::tempdir().unwrap();
    let mut writer = ImportWriter::create(dir.path()).unwrap();
    assert!(writer.put_vault_id("vault-1").is_err());
    assert_eq!(writer.vault_id().unwrap(), None);
    let id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    writer.put_vault_id(id).unwrap();
    assert_eq!(writer.vault_id().unwrap().as_deref(), Some(id));
}
