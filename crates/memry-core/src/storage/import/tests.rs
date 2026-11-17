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
