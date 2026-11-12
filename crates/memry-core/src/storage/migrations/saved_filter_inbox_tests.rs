//! main's data migrations 15 `saved_filter_expressions` and 16 `inbox_attachments`.

use super::*;
use crate::storage::Db;

/// 0015 recovers the rules an older build stored in the verbatim payload
/// but never projected; only an object counts.
#[test]
fn saved_filter_expressions_backfill_from_stored_payloads() {
    let db = Db::open_in_memory().expect("open");
    let rows = db
        .call_blocking(|conn| {
            run(conn, &DATA_MIGRATIONS[..14])?;
            conn.execute_batch(
                "INSERT INTO sync_items (item_type, item_id, payload, payload_state, updated_at) VALUES
                   ('filter', 'f1', '{\"name\":\"a\",\"expression\":{\"match\":\"all\",\"rules\":[]}}', 'full', 1),
                   ('filter', 'f2', '{\"name\":\"b\",\"expression\":null}', 'full', 1),
                   ('filter', 'f3', NULL, 'metadata', 1),
                   ('note', 'n1', '{\"expression\":{}}', 'full', 1);",
            )
            .map_err(|err| StorageError::Failed {
                what: err.to_string(),
            })?;
            run(conn, DATA_MIGRATIONS)?;
            let mut statement = conn
                .prepare("SELECT filter_id, expression FROM saved_filter_expressions")
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })?;
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .and_then(Iterator::collect::<rusqlite::Result<Vec<(String, String)>>>)
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })?;
            Ok(rows)
        })
        .expect("migrate");
    assert_eq!(
        rows,
        [("f1".to_owned(), r#"{"match":"all","rules":[]}"#.to_owned())]
    );
}

/// 0016 recreates `inbox_view` with `attachment_id`: rows an older build
/// stored keep their data, a payload that carries the key exposes it, and
/// nothing is backfilled into the upload-pending or release tables, so a
/// capture from before the build never uploads.
#[test]
fn an_older_inbox_database_gains_the_attachment_id_view_column() {
    let db = Db::open_in_memory().expect("open");
    let rows = db
        .call_blocking(|conn| {
            run(conn, &DATA_MIGRATIONS[..15])?;
            conn.execute_batch(
                "INSERT INTO sync_items (item_type, item_id, payload, payload_state, updated_at) VALUES
                   ('inbox', 'i1', '{\"type\":\"image\",\"attachmentPath\":\"attachments/inbox/i1/a.png\"}', 'full', 1),
                   ('inbox', 'i2', '{\"type\":\"image\",\"attachmentId\":\"att-2\"}', 'full', 1);
                 INSERT INTO inbox_items (id, type, title) VALUES ('i1', 'image', 'a'), ('i2', 'image', 'b');",
            )
            .map_err(|err| StorageError::Failed {
                what: err.to_string(),
            })?;
            assert_eq!(run(conn, DATA_MIGRATIONS)?, latest_version(DATA_MIGRATIONS));
            let mut statement = conn
                .prepare("SELECT id, attachment_path, attachment_id FROM inbox_view ORDER BY id")
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })?;
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .and_then(
                    Iterator::collect::<rusqlite::Result<Vec<(String, Option<String>, Option<String>)>>>,
                )
                .map_err(|err| StorageError::Failed {
                    what: err.to_string(),
                })?;
            for table in ["inbox_attachment_uploads", "inbox_attachment_releases"] {
                let count: i64 = conn
                    .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row.get(0))
                    .map_err(|err| StorageError::Failed {
                        what: err.to_string(),
                    })?;
                assert_eq!(count, 0, "{table} is not backfilled");
            }
            Ok(rows)
        })
        .expect("migrate");
    assert_eq!(
        rows,
        [
            (
                "i1".to_owned(),
                Some("attachments/inbox/i1/a.png".to_owned()),
                None
            ),
            ("i2".to_owned(), None, Some("att-2".to_owned())),
        ]
    );
}
