use proptest::prelude::*;
use rusqlite::types::Value;

use super::source::copy_sources;
use super::tables::SourceDb;
use super::*;

/// The probe over a profile directory with no LevelDB store in it.
fn no_electron(dir: &Path) -> ProfileLock {
    use crate::electron_import::{AppNameCandidates, ElectronProfile, HostOs};
    ProfileLock::probe(&ElectronProfile {
        dir: dir.join("electron-profile"),
        host: HostOs::current(),
        pin: None,
        app_names: AppNameCandidates(Vec::new()),
        has_config: false,
        has_secure_store: false,
        has_local_state: false,
        has_local_storage: false,
        has_legacy_crdt_store: false,
        has_custom_dictionary: false,
        crdt_store_dirs: Vec::new(),
        other_candidates: Vec::new(),
    })
    .unwrap()
}

fn input<'a>(
    vault: &Path,
    pair: &electron_db::ElectronPair,
    lock: &'a ProfileLock,
) -> VaultImportInput<'a> {
    VaultImportInput {
        electron_closed: lock,
        vault_dir: vault.to_owned(),
        vault_id: "vault-1".into(),
        electron_data_db: pair.data.clone(),
        electron_index_db: pair.index.clone(),
        docs: Vec::new(),
        extra_owed_docs: Vec::new(),
        vault_key: None,
        now_ms: 1_800_000_000_000,
        progress: None,
    }
}

/// Copies the pair the way a run does and reads `note_metadata.id` back from the copy.
fn ids_through_the_copy(pair: &electron_db::ElectronPair, staging: &Path) -> Vec<String> {
    let sources = copy_sources(&pair.data, &pair.index, staging).unwrap();
    let conn = sources.conn(SourceDb::Data);
    let mut stmt = conn
        .prepare("SELECT rowid, id FROM note_metadata ORDER BY rowid")
        .unwrap();
    let mut rows = stmt.query([]).unwrap();
    let mut ids = Vec::new();
    while let Some(row) = rows.next().unwrap() {
        ids.push(read_source_id(row, SourceDb::Data, "note_metadata", "id").unwrap());
    }
    ids
}

#[test]
fn a_fresh_electron_pair_passes_the_preflight() {
    let dir = tempfile::tempdir().unwrap();
    let pair = electron_db::create_pair(&dir.path().join(".memry"));
    let staging = dir.path().join("staging");
    let sources = copy_sources(&pair.data, &pair.index, &staging).unwrap();
    let lock = no_electron(dir.path());
    let preflight = preflight::run(&sources, &input(dir.path(), &pair, &lock)).unwrap();
    // Every mapped table and nothing else: the fts5 and vec0 shadow tables are recognised.
    assert_eq!(preflight.tables.len(), tables::TABLE_MAP.len());
    assert!(preflight.dropped_keys.is_empty());
}

/// Ids are read as the exact bytes Electron stored, uppercase, `_`, `-`, NUL and combining
/// marks included, from a database whose last commit is still only in its WAL.
#[test]
fn ids_survive_the_copy_byte_for_byte() {
    let dir = tempfile::tempdir().unwrap();
    let pair = electron_db::create_pair(&dir.path().join(".memry"));
    let ids = [
        "-0QKFMSbJ-18",
        "NvXCU8_x4cv9",
        "V1StGXR8_Z5jdHi6B-myT",
        "nul\0inside",
        "cafe\u{301}",
        "caf\u{e9}",
        " padded ",
        "v1stgxr8_z5jdhi6b-myt",
        "j2026-11-17",
    ];
    assert_eq!(ids[2].len(), 21);
    let writer = electron_db::open_without_checkpoints(&pair.data);
    for id in ids {
        electron_db::seed(&writer, "note_metadata", &[("id", Value::Text(id.into()))]);
    }
    assert!(
        std::fs::metadata(format!("{}-wal", pair.data.display()))
            .unwrap()
            .len()
            > 0
    );
    let read = ids_through_the_copy(&pair, &dir.path().join("staging"));
    assert_eq!(read, ids.map(String::from));
    drop(writer);
}

#[test]
fn an_id_that_is_not_text_fails_with_its_table_and_rowid() {
    // A number bound to the TEXT `id` column is stored as text by its affinity, so a BLOB is
    // the one non-text value the column can hold.
    let bad = Value::Blob(b"-0QKFMSbJ-18".to_vec());
    let dir = tempfile::tempdir().unwrap();
    let pair = electron_db::create_pair(&dir.path().join(".memry"));
    let conn = rusqlite::Connection::open(&pair.data).unwrap();
    electron_db::seed(&conn, "note_metadata", &[("id", bad)]);
    drop(conn);
    let sources = copy_sources(&pair.data, &pair.index, &dir.path().join("s")).unwrap();
    let conn = sources.conn(SourceDb::Data);
    let error = conn
        .query_row("SELECT rowid, id FROM note_metadata", [], |row| {
            Ok(read_source_id(row, SourceDb::Data, "note_metadata", "id"))
        })
        .unwrap()
        .unwrap_err();
    assert!(
        matches!(&error, ImportError::NonTextId { table, rowid: 1 } if table == "note_metadata"),
        "{error}"
    );
}

/// A TEXT value that is not UTF-8 (Electron's driver never writes one, a damaged file can hold
/// one) and a NULL id both fail: neither is lossily repaired into an id.
#[test]
fn an_id_that_is_not_utf8_or_null_fails() {
    for value in ["CAST(x'ff2d30' AS TEXT)", "NULL"] {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE ids (id TEXT); INSERT INTO ids VALUES ({value})"
        ))
        .unwrap();
        let error = conn
            .query_row("SELECT rowid, id FROM ids", [], |row| {
                Ok(read_source_id(row, SourceDb::Data, "ids", "id"))
            })
            .unwrap()
            .unwrap_err();
        assert!(
            matches!(&error, ImportError::NonTextId { table, rowid: 1 } if table == "ids"),
            "{error}"
        );
    }
}

#[test]
fn check_1_fails_when_a_table_wrote_fewer_rows_than_it_read() {
    let mut report = VaultStageReport::default();
    report.tables.insert(
        "data.db/tasks".into(),
        TableReport {
            class: "convert",
            source_count: 3,
            target_count: 2,
            dropped: 0,
        },
    );
    assert!(matches!(
        checks::row_counts(&report),
        Err(ImportError::CheckFailed { check: 1, .. })
    ));
    report.tables.get_mut("data.db/tasks").unwrap().dropped = 1;
    checks::row_counts(&report).unwrap();
}

proptest! {
    #![proptest_config(memry_test_kit::proptest_config(32))]

    /// The `sqlite_master` text the preflight reads is the source's: any string, multibyte
    /// included, is classified without a panic.
    #[test]
    fn the_virtual_table_scan_takes_any_sql(sql in "(?s).{0,80}", tail in "\\PC{0,8}") {
        let _ = preflight::virtual_module(&sql);
        let _ = preflight::virtual_module(&format!("create virtual table x using {tail}{sql}"));
    }
}

/// Any UTF-8 id comes back unchanged through copy, WAL replay and backup. The Electron pair is
/// built once, not per case: replaying its migrations is 580 commits, one fsync each, which took
/// 3 to 9 s per case on the Windows runners and put 32 cases at the 300 s test limit.
#[test]
fn any_text_id_round_trips() {
    let dir = tempfile::tempdir().unwrap();
    let pair = electron_db::create_pair(&dir.path().join(".memry"));
    proptest!(
        memry_test_kit::proptest_config(32),
        |(ids in prop::collection::btree_set("\\PC{1,24}", 1..8))| {
            let conn = rusqlite::Connection::open(&pair.data).unwrap();
            conn.execute("DELETE FROM note_metadata", []).unwrap();
            for id in &ids {
                electron_db::seed(&conn, "note_metadata", &[("id", Value::Text(id.clone()))]);
            }
            drop(conn);
            let staging = tempfile::tempdir_in(dir.path()).unwrap();
            let read = ids_through_the_copy(&pair, staging.path());
            prop_assert_eq!(read, ids.into_iter().collect::<Vec<_>>());
        }
    );
}
