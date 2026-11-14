//! Index migration 0010 (`file_text`) on a real `index.db` an earlier build left at
//! version 9: it opens in place, keeps its rows and gains Electron's tables.

use rusqlite::Connection;

use super::*;
use crate::storage::connection::{Db, Profile};
use crate::storage::index_db::open_or_rebuild;
use crate::storage::test_support::temp_dir;

fn failed(err: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: err.to_string(),
    }
}

/// An `index.db` file at version 9 with a note's stats and property refs in it.
fn index_at_version_nine(path: &std::path::Path, extra: &str) {
    let db = Db::open_with(path, Profile::Index).expect("open");
    db.call_blocking(|conn| {
        run_atomic(conn, &INDEX_MIGRATIONS[..9])?;
        conn.execute_batch(
            "INSERT INTO index_meta (key, value) VALUES ('data.user_version', '30');
             INSERT INTO property_refs (source_id, name, target_type, target_id)
               VALUES ('n1', 'project', 'note', 'n2');",
        )
        .map_err(failed)?;
        conn.execute_batch(extra).map_err(failed)
    })
    .expect("seed version 9");
}

/// `PRAGMA table_info`: (name, type, notnull, default, pk position).
fn columns(conn: &Connection, table: &str) -> Vec<(String, String, bool, Option<String>, i64)> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .expect("table_info");
    stmt.query_map([], |row| {
        Ok((
            row.get(1)?,
            row.get::<_, String>(2)?.to_uppercase(),
            row.get(3)?,
            row.get(4)?,
            row.get(5)?,
        ))
    })
    .expect("query")
    .collect::<Result<_, _>>()
    .expect("rows")
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).expect(sql)
}

fn col(
    name: &str,
    ty: &str,
    not_null: bool,
    default: Option<&str>,
    pk: i64,
) -> (String, String, bool, Option<String>, i64) {
    (
        name.into(),
        ty.into(),
        not_null,
        default.map(Into::into),
        pk,
    )
}

#[test]
fn a_version_9_index_opens_in_place_and_gains_electrons_file_text_tables() {
    let dir = temp_dir("index-file-text");
    let path = dir.path().join("index.db");
    index_at_version_nine(&path, "");

    let opened = open_or_rebuild(&path).expect("open");
    assert!(opened.rebuild_reason.is_none(), "migrated, not rebuilt");

    opened
        .db
        .call_blocking(|conn| {
            assert_eq!(user_version(conn)?, 10);
            assert_eq!(count(conn, "SELECT COUNT(*) FROM property_refs"), 1);
            assert_eq!(count(conn, "SELECT COUNT(*) FROM index_meta"), 1);

            // `0023_extracted_text.sql` and `0024_file_text_ocr_languages.sql`, column for column.
            assert_eq!(
                columns(conn, "extracted_text"),
                vec![
                    col("note_id", "TEXT", true, None, 1),
                    col("source", "TEXT", true, Some("''"), 2),
                    col("part", "INTEGER", true, None, 3),
                    col("method", "TEXT", true, None, 0),
                    col("text", "TEXT", true, None, 0),
                ]
            );
            assert_eq!(
                columns(conn, "file_text_jobs"),
                vec![
                    col("note_id", "TEXT", true, None, 1),
                    col("source", "TEXT", true, Some("''"), 2),
                    col("signature", "TEXT", true, None, 0),
                    col("status", "TEXT", true, None, 0),
                    col("page_count", "INTEGER", false, None, 0),
                    col("error", "TEXT", false, None, 0),
                    col("app_version", "TEXT", true, None, 0),
                    col("updated_at", "TEXT", true, None, 0),
                    col("ocr_languages", "TEXT", false, None, 0),
                ]
            );
            let indexed: String = conn
                .query_row(
                    "SELECT group_concat(name, ',') FROM pragma_index_info('idx_file_text_jobs_status')",
                    [],
                    |row| row.get(0),
                )
                .map_err(failed)?;
            assert_eq!(indexed, "status,updated_at");
            Ok(())
        })
        .expect("read back");
}

#[test]
fn an_index_that_already_holds_the_tables_keeps_their_rows() {
    let dir = temp_dir("index-file-text-held");
    let path = dir.path().join("index.db");
    // A file that holds the tables at version 9, as one copied from Electron's index would.
    index_at_version_nine(
        &path,
        "CREATE TABLE extracted_text (note_id TEXT NOT NULL, source TEXT DEFAULT '' NOT NULL,
           part INTEGER NOT NULL, method TEXT NOT NULL, text TEXT NOT NULL,
           PRIMARY KEY (note_id, source, part));
         INSERT INTO extracted_text VALUES ('n1', '', 1, 'pdf-text', 'kept');",
    );

    let opened = open_or_rebuild(&path).expect("open");
    assert!(opened.rebuild_reason.is_none(), "migrated, not rebuilt");
    opened
        .db
        .call_blocking(|conn| {
            assert_eq!(user_version(conn)?, 10);
            assert_eq!(
                count(
                    conn,
                    "SELECT COUNT(*) FROM extracted_text WHERE text = 'kept'"
                ),
                1
            );
            assert_eq!(count(conn, "SELECT COUNT(*) FROM file_text_jobs"), 0);
            Ok(())
        })
        .expect("read back");
}
