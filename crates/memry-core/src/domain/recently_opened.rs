//! The "recently opened" trail of notes and canvases: desktop's `recents:*`
//! (`apps/desktop/src/main/ipc/recents-handlers.ts`,
//! `main/database/queries/recently-opened.ts`).
//!
//! Device-local UI state in `data.db` (migration 0033): never synced, gone
//! with the vault on sign-out. A row names an item and stores no title, so
//! [`list`] resolves each item when it reads and skips one that is gone.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::domain::canvas;
use crate::domain::inbox::filing::note_path;
use crate::storage::repositories::{StoredPayload, sync_items};

/// Rows kept per device (`RECENTLY_OPENED_LIMIT`, `recents-api.ts:50`).
pub const LIMIT: u32 = 50;

/// The item types the trail resolves (`RECENTLY_OPENED_ITEM_TYPES`).
pub const ITEM_TYPES: [&str; 2] = ["note", "canvas"];

/// One opened item, resolved (`RecentlyOpenedItem`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opened {
    pub item_type: String,
    pub item_id: String,
    /// Epoch milliseconds.
    pub opened_at: i64,
    pub title: String,
    /// Vault-relative path.
    pub path: String,
    /// A bare emoji, or an `icon:` or `custom:` reference.
    pub emoji: Option<String>,
    /// The note's file type (`markdown`, `pdf`, ...), or `canvas`.
    pub file_type: String,
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// Records that the item was opened (`recordRecentlyOpened`): one row per
/// item, bumped to the top on every open, the oldest past [`LIMIT`] dropped.
/// The stamp is kept above every stored one, so two opens in one millisecond
/// still list newest first.
pub fn record(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    if !ITEM_TYPES.contains(&item_type) || item_id.is_empty() {
        return Err(StorageError::Invalid {
            what: format!("not a recently opened item: {item_type}"),
        });
    }
    let tx = conn.unchecked_transaction().map_err(failed)?;
    tx.execute(
        "INSERT INTO recently_opened (item_type, item_id, opened_at)
         VALUES (?1, ?2, max(?3, COALESCE((SELECT max(opened_at) + 1 FROM recently_opened), ?3)))
         ON CONFLICT (item_type, item_id) DO UPDATE SET opened_at = excluded.opened_at",
        params![item_type, item_id, now_ms],
    )
    .map_err(failed)?;
    tx.execute(
        "DELETE FROM recently_opened WHERE rowid NOT IN (
           SELECT rowid FROM recently_opened ORDER BY opened_at DESC LIMIT ?1)",
        params![LIMIT],
    )
    .map_err(failed)?;
    tx.commit().map_err(failed)
}

/// The newest opened items that still exist, at most `limit` (capped at
/// [`LIMIT`]): `listRecentlyOpened`. Notes resolve against `notes` and
/// `note_files`, canvases against their record; a deleted one is skipped.
pub fn list(conn: &Connection, limit: u32) -> Result<Vec<Opened>, StorageError> {
    let limit = usize::try_from(limit.min(LIMIT)).unwrap_or(0);
    let mut statement = conn
        .prepare(
            "SELECT item_type, item_id, opened_at FROM recently_opened
             ORDER BY opened_at DESC LIMIT ?1",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![LIMIT], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    let mut items = Vec::new();
    for (item_type, item_id, opened_at) in rows {
        if items.len() >= limit {
            break;
        }
        let resolved = match item_type.as_str() {
            "canvas" => resolve_canvas(conn, &item_id)?,
            _ => resolve_note(conn, &item_id)?,
        };
        if let Some((title, path, emoji, file_type)) = resolved {
            items.push(Opened {
                item_type,
                item_id,
                opened_at,
                title,
                path,
                emoji,
                file_type,
            });
        }
    }
    Ok(items)
}

type Resolution = (String, String, Option<String>, String);

fn resolve_note(conn: &Connection, id: &str) -> Result<Option<Resolution>, StorageError> {
    let found = conn
        .query_row(
            "SELECT n.title, n.folder_path, n.emoji, f.path, COALESCE(f.file_type, n.file_type)
               FROM notes n LEFT JOIN note_files f ON f.note_id = n.id
              WHERE n.id = ?1 AND n.deleted_at IS NULL",
            params![id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()
        .map_err(failed)?;
    Ok(found.map(|(title, folder, emoji, path, file_type)| {
        // A note this device has not written a file for yet shows where its
        // file will go.
        let path = path.unwrap_or_else(|| note_path(folder.as_deref(), &title));
        (
            title,
            path,
            emoji.filter(|emoji| !emoji.is_empty()),
            file_type.unwrap_or_else(|| "markdown".to_owned()),
        )
    }))
}

/// A live canvas's title, its `icon`, and the path Electron's `canvasPath`
/// falls back to without a file path: `canvases/<folder>/<title>`. Desktop
/// writes canvas files from Step 30e on, which gives the file path.
fn resolve_canvas(conn: &Connection, id: &str) -> Result<Option<Resolution>, StorageError> {
    let Some(found) = canvas::get(conn, id)? else {
        return Ok(None);
    };
    let payload = sync_items::load(conn, canvas::ITEM_TYPE, id)?
        .and_then(|row| row.payload)
        .and_then(|raw| StoredPayload::parse(&raw).ok());
    let text = |key: &str| {
        payload
            .as_ref()
            .and_then(|payload| payload.object().get(key).and_then(Value::as_str))
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let title = found.title.unwrap_or_default();
    let path = ["canvases", text("folder").as_deref().unwrap_or(""), &title]
        .iter()
        .filter(|segment| !segment.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("/");
    Ok(Some((title, path, text("icon"), "canvas".to_owned())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Db;
    use crate::storage::migrations::{DATA_MIGRATIONS, run};

    fn with_db(test: impl FnOnce(&Connection) -> Result<(), StorageError>) {
        let db = Db::open_in_memory().expect("open");
        db.call_blocking(|conn| run(conn, DATA_MIGRATIONS))
            .expect("migrate");
        db.call_blocking(|conn| test(conn)).expect("test");
    }

    fn note(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO notes (id, title, folder_path) VALUES (?1, ?2, 'work')",
            params![id, format!("Note {id}")],
        )
        .expect("note");
    }

    fn ids(conn: &Connection, limit: u32) -> Vec<String> {
        list(conn, limit)
            .expect("list")
            .into_iter()
            .map(|item| item.item_id)
            .collect()
    }

    #[test]
    fn reopening_bumps_one_row_and_two_opens_in_one_millisecond_list_newest_first() {
        with_db(|conn| {
            note(conn, "a");
            note(conn, "b");
            record(conn, "note", "a", 5)?;
            record(conn, "note", "b", 5)?;
            assert_eq!(ids(conn, 50), ["b", "a"]);
            record(conn, "note", "a", 6)?;
            assert_eq!(ids(conn, 50), ["a", "b"]);
            let rows: i64 = conn
                .query_row("SELECT count(*) FROM recently_opened", [], |row| row.get(0))
                .map_err(failed)?;
            assert_eq!(rows, 2);
            Ok(())
        });
    }

    #[test]
    fn only_the_fifty_newest_are_kept_and_the_limit_is_capped_at_fifty() {
        with_db(|conn| {
            for index in 0..55 {
                let id = format!("n{index:02}");
                note(conn, &id);
                record(conn, "note", &id, index)?;
            }
            let rows: i64 = conn
                .query_row("SELECT count(*) FROM recently_opened", [], |row| row.get(0))
                .map_err(failed)?;
            assert_eq!(rows, 50);
            assert_eq!(ids(conn, 500).len(), 50);
            assert_eq!(ids(conn, 3), ["n54", "n53", "n52"]);
            Ok(())
        });
    }

    #[test]
    fn a_note_resolves_with_its_file_and_a_deleted_one_is_skipped() {
        with_db(|conn| {
            conn.execute_batch(
                "INSERT INTO notes (id, title, emoji, file_type) VALUES ('p', 'Scan', '📄', 'pdf');
                 INSERT INTO note_files (note_id, path, file_type, indexed_at)
                   VALUES ('p', 'files/Scan.pdf', 'pdf', 1);
                 INSERT INTO notes (id, title, deleted_at) VALUES ('gone', 'Gone', 3);",
            )
            .map_err(failed)?;
            note(conn, "fresh");
            record(conn, "note", "p", 1)?;
            record(conn, "note", "gone", 2)?;
            record(conn, "note", "fresh", 3)?;
            let items = list(conn, 50)?;
            assert_eq!(items.len(), 2);
            assert_eq!(items[0].path, "work/Note fresh.md");
            assert_eq!(items[0].file_type, "markdown");
            assert_eq!(
                items[1],
                Opened {
                    item_type: "note".to_owned(),
                    item_id: "p".to_owned(),
                    opened_at: 1,
                    title: "Scan".to_owned(),
                    path: "files/Scan.pdf".to_owned(),
                    emoji: Some("📄".to_owned()),
                    file_type: "pdf".to_owned(),
                }
            );
            Ok(())
        });
    }

    #[test]
    fn a_canvas_resolves_from_its_record_and_a_tombstoned_one_is_skipped() {
        with_db(|conn| {
            for (id, deleted) in [("c1", "NULL"), ("c2", "9")] {
                conn.execute(
                    &format!(
                        "INSERT INTO sync_items (item_type, item_id, payload, payload_state, updated_at, deleted_at)
                         VALUES ('canvas', ?1, ?2, 'full', 1, {deleted})"
                    ),
                    params![
                        id,
                        r#"{"title":"Board","folder":"plans","icon":"icon:shapes","scene":""}"#
                    ],
                )
                .map_err(failed)?;
                record(conn, "canvas", id, 1)?;
            }
            let items = list(conn, 50)?;
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].item_id, "c1");
            assert_eq!(items[0].path, "canvases/plans/Board");
            assert_eq!(items[0].emoji.as_deref(), Some("icon:shapes"));
            assert_eq!(items[0].file_type, "canvas");
            Ok(())
        });
    }

    #[test]
    fn an_unknown_type_or_blank_id_is_refused() {
        with_db(|conn| {
            assert!(record(conn, "journal", "j1", 1).is_err());
            assert!(record(conn, "note", "", 1).is_err());
            Ok(())
        });
    }

    /// 0033 adds the trail to a `data.db` an older build wrote, and it works
    /// on it straight away.
    #[test]
    fn an_older_data_database_gains_an_empty_trail() {
        let db = Db::open_in_memory().expect("open");
        db.call_blocking(|conn| {
            run(conn, &DATA_MIGRATIONS[..32])?;
            note(conn, "a");
            assert_eq!(run(conn, DATA_MIGRATIONS)?, 33);
            assert!(list(conn, 50)?.is_empty());
            record(conn, "note", "a", 1)?;
            assert_eq!(ids(conn, 50), ["a"]);
            Ok(())
        })
        .expect("migrate");
    }
}
