//! Data migration 0019, `wiki_name_keys`: kept apart from `tests.rs` for its line ceiling.

use super::*;
use crate::storage::Db;

/// Every existing row is owed its wiki name keys, every later write of a name owes them again,
/// and the lookup seeks the keys by index.
#[test]
fn the_wiki_name_keys_migration_owes_every_row_and_follows_every_name_write() {
    let db = Db::open_in_memory().expect("open");
    db.call_blocking(|conn| run(conn, &DATA_MIGRATIONS[..18]))
        .expect("a database as the last build left it");
    let failed = |err: rusqlite::Error| StorageError::Failed {
        what: err.to_string(),
    };
    db.call_blocking(|conn| {
        conn.execute_batch(
            "INSERT INTO notes (id, title) VALUES ('n1', 'Plan'); \
             INSERT INTO journal_entries (id, date) VALUES ('j2026-01-02', '2026-01-02');",
        )
        .map_err(failed)
    })
    .expect("rows to keep");
    let version = db
        .call_blocking(|conn| run(conn, DATA_MIGRATIONS))
        .expect("step forward");
    assert_eq!(version, 19);
    db.call_blocking(|conn| conn.execute_batch(DATA_MIGRATIONS[18].sql).map_err(failed))
        .expect("idempotent");

    let owed = |conn: &rusqlite::Connection| -> Result<Vec<String>, StorageError> {
        let mut statement = conn
            .prepare("SELECT DISTINCT id FROM wiki_names_owed ORDER BY id")
            .map_err(failed)?;
        let ids = statement
            .query_map([], |row| row.get(0))
            .map_err(failed)?
            .collect::<Result<_, _>>()
            .map_err(failed)?;
        Ok(ids)
    };
    let (before, after_settle, after_writes, plan) = db
        .call_blocking(|conn| {
            let before = owed(conn)?;
            crate::domain::wiki_target::settle_name_keys(conn)?;
            conn.execute("UPDATE notes SET modified_at = 5 WHERE id = 'n1'", [])
                .map_err(failed)?;
            // A write that changes no name owes nothing.
            let after_settle = owed(conn)?;
            conn.execute_batch(
                "INSERT INTO notes (id, title) VALUES ('n2', 'Other'); \
                 UPDATE notes SET aliases = '[\"Q3\"]' WHERE id = 'n1'; \
                 INSERT OR REPLACE INTO journal_aliases (journal_id, aliases) \
                   VALUES ('j2026-01-02', '[\"Kickoff\"]'); \
                 DELETE FROM journal_entries WHERE id = 'j2026-01-02';",
            )
            .map_err(failed)?;
            let after_writes = owed(conn)?;
            let mut statement = conn
                .prepare(&format!(
                    "EXPLAIN QUERY PLAN {}",
                    crate::domain::wiki_target::CANDIDATES
                ))
                .map_err(failed)?;
            let plan: Vec<String> = statement
                .query_map(["[\"plan\"]"], |row| row.get::<_, String>(3))
                .map_err(failed)?
                .collect::<Result<_, _>>()
                .map_err(failed)?;
            Ok((before, after_settle, after_writes, plan))
        })
        .expect("read back");
    assert_eq!(before, ["j2026-01-02", "n1"]);
    assert!(after_settle.is_empty());
    assert_eq!(after_writes, ["j2026-01-02", "n1", "n2"]);
    assert!(
        plan.iter()
            .any(|step| step.starts_with("SEARCH wiki_name_keys USING PRIMARY KEY")),
        "{plan:?}"
    );
}
