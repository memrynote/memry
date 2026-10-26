//! `e2e::debug::run` against the real core databases of an opened vault.

use std::sync::Arc;

use memry_desktop::e2e::debug::{DebugQueryError, MAX_ROWS, run};
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, Session};

struct Opened {
    _dir: tempfile::TempDir,
    session: Session,
}

fn open_vault() -> Opened {
    let dir = tempfile::tempdir().expect("dir");
    let app = dir.path().join("app");
    std::fs::create_dir_all(&app).expect("app dir");
    let session = Session::new(VaultRegistry::new(Arc::new(AppConfig::load(
        app.join("memry-config.json"),
    ))));
    let vault = dir.path().join("vault");
    std::fs::create_dir_all(&vault).expect("vault");
    session.open(&vault, OpenSource::Select).expect("open");
    Opened { _dir: dir, session }
}

fn data(opened: &Opened) -> memry_core::storage::Db {
    opened.session.current().expect("open").vault.db_handle()
}

fn index(opened: &Opened) -> memry_core::storage::Db {
    opened
        .session
        .current()
        .expect("open")
        .search
        .index_handle()
}

fn count(db: &memry_core::storage::Db, sql: &str) -> i64 {
    let rows = run(db, sql).expect("count");
    rows[0]["n"].as_i64().expect("n")
}

fn seed(db: &memry_core::storage::Db, rows: usize) {
    db.call_blocking(move |conn| {
        for i in 0..rows {
            conn.execute(
                "INSERT INTO meta (key, value) VALUES (?1, 'v')",
                [format!("debug-{i}")],
            )
            .map_err(|e| memry_core::api::errors::StorageError::Failed {
                what: e.to_string(),
            })?;
        }
        Ok(())
    })
    .expect("seed");
}

#[test]
fn reads_come_back_as_json_rows_on_both_databases() {
    let opened = open_vault();
    seed(&data(&opened), 1);
    let rows = run(
        &data(&opened),
        "SELECT value FROM meta WHERE key = 'debug-0'",
    )
    .expect("rows");
    assert_eq!(rows, vec![serde_json::json!({ "value": "v" })]);
    let tables = run(&index(&opened), "SELECT count(*) AS n FROM sqlite_master").expect("index");
    assert!(tables[0]["n"].as_i64().expect("n") > 0);
    let info = run(&data(&opened), "PRAGMA table_info(meta)").expect("pragma");
    assert!(info.iter().any(|row| row["name"] == "key"));
    run(&data(&opened), "WITH x(a) AS (SELECT 1) SELECT a FROM x").expect("cte");
    run(&data(&opened), "EXPLAIN SELECT 1").expect("explain");
}

#[test]
fn writes_are_refused_with_read_only_and_leave_the_rows_alone() {
    let opened = open_vault();
    let db = data(&opened);
    seed(&db, 3);
    let before = count(&db, "SELECT count(*) AS n FROM meta");
    for sql in [
        "UPDATE meta SET value = 'x'",
        "DELETE FROM meta RETURNING key",
        "INSERT INTO meta (key, value) VALUES ('z', 'z')",
        "SELECT 1; DELETE FROM meta",
        "WITH gone AS (SELECT key FROM meta) DELETE FROM meta WHERE key IN gone",
        "PRAGMA user_version = 99",
        "ATTACH DATABASE ':memory:' AS other",
        "DROP TABLE meta",
    ] {
        match run(&db, sql) {
            Err(DebugQueryError::ReadOnly(_)) => {}
            other => panic!("`{sql}` was not refused as read-only: {other:?}"),
        }
    }
    assert!(
        run(&db, "UPDATE meta SET value = 'x'")
            .expect_err("refused")
            .to_string()
            .contains("read-only")
    );
    assert_eq!(count(&db, "SELECT count(*) AS n FROM meta"), before);
    let index_db = index(&opened);
    assert!(matches!(
        run(&index_db, "DELETE FROM sqlite_master"),
        Err(DebugQueryError::ReadOnly(_))
    ));
}

#[test]
fn a_result_is_capped_at_one_thousand_rows() {
    let opened = open_vault();
    let db = data(&opened);
    seed(&db, MAX_ROWS + 50);
    let rows = run(&db, "SELECT key FROM meta").expect("rows");
    assert_eq!(rows.len(), MAX_ROWS);
}
