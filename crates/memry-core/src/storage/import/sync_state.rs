//! Electron's sync progress (Step 36c3): its `sync_state` keys and `sync_history` rows, each
//! written into the core owner of the same state, in the owner's own format.
//!
//! - `lastCursor`: the record cursor ([`store::RECORD_CURSOR_SCOPE`]), with the declaration it
//!   was advanced under ([`META_RECORD_DECLARATION`]) and [`META_FIRST_SYNC_COMPLETED`]: Electron
//!   treats a device holding a cursor as past its first sync (`isFreshDevice`), so the core does.
//! - `cursorSkipRepair`: [`META_CURSOR_SKIP_REPAIR`], whose three states are Electron's.
//! - `syncPaused`: [`pause`]. `packsAppliedThroughCursor`: [`META_PACKS_APPLIED_THROUGH`].
//! - `quarantinedItems`: `sync_quarantine`. `schemaInvalidItems`: `sync_refused_items`.
//! - `crdtUnmergedDebt` not yet converted (36c5): a [`body_debt`] for every live markdown note
//!   and journal day, as Electron's engine start converts it (`convertUnmergedDebtMirror`).
//! - `journalDayMerge:<id>`: [`journal_day_merge`]'s owed merge of the same foreign id.
//! - `sync_history`: `sync_history`, which keeps the newest [`history::KEEP`] rows.

use rusqlite::{Connection, params};

use super::{ImportWriter, failed};
use crate::api::errors::StorageError;
use crate::sync::body_debt;
use crate::sync::first_sync::META_FIRST_SYNC_COMPLETED;
use crate::sync::first_sync_store::{read_meta, write_meta};
use crate::sync::hardening::history;
use crate::sync::journal_day_merge::{self, OwedMerge};
use crate::sync::pack_bootstrap::META_PACKS_APPLIED_THROUGH;
use crate::sync::pause;
use crate::sync::pull::{META_CURSOR_SKIP_REPAIR, META_RECORD_DECLARATION};
use crate::sync::store::{self, RECORD_CURSOR_SCOPE};

/// The record cursor and the declaration header value the feed was read under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportRecordCursor {
    pub cursor: String,
    pub declaration: String,
}

/// One permanent quarantine entry, Electron's `QuarantineEntry`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportQuarantined {
    pub item_type: String,
    pub item_id: String,
    pub signer_device_id: String,
    pub failed_at: i64,
    pub attempt_count: i64,
    pub last_error: String,
}

/// One refused item. `refused_by_version` is never the running core build, so the first pull
/// refetches the item, as Electron does once another app version runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportRefused {
    pub item_type: String,
    pub item_id: String,
    pub refused_by_version: String,
    pub refused_at: i64,
}

/// The sync state of one vault. Ledgers are ordered by `(item_type, item_id)`, the order
/// [`ImportWriter::staged_sync_state`] reads them back in.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportSyncState {
    pub record_cursor: Option<ImportRecordCursor>,
    pub cursor_skip_repair: Option<String>,
    pub paused: bool,
    pub packs_applied_through: Option<i64>,
    pub quarantined: Vec<ImportQuarantined>,
    pub refused: Vec<ImportRefused>,
    /// Every live markdown note and journal day owes a body pull. Read back as "none is
    /// unowed", which also holds for a vault whose every body was owed by another table.
    pub owe_every_body: bool,
    /// Ordered by foreign id, the order [`journal_day_merge::owed`] reads them in.
    pub journal_merges: Vec<OwedMerge>,
}

/// One `sync_history` row in the core's shape: `kind` is Electron's `type`, `created_at` ms.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportHistory {
    pub id: String,
    pub kind: String,
    pub item_count: i64,
    pub direction: Option<String>,
    pub details: Option<String>,
    pub duration_ms: Option<i64>,
    pub created_at: i64,
}

impl ImportWriter {
    /// Writes `state` in one transaction.
    pub fn put_sync_state(
        &mut self,
        state: &ImportSyncState,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        let tx = self.data.transaction().map_err(failed)?;
        if let Some(record) = &state.record_cursor {
            store::write_cursor(&tx, RECORD_CURSOR_SCOPE, Some(&record.cursor), now_ms)?;
            write_meta(&tx, META_RECORD_DECLARATION, &record.declaration)?;
            write_meta(&tx, META_FIRST_SYNC_COMPLETED, &now_ms.to_string())?;
        }
        if let Some(repair) = &state.cursor_skip_repair {
            write_meta(&tx, META_CURSOR_SKIP_REPAIR, repair)?;
        }
        pause::write(&tx, state.paused)?;
        if let Some(watermark) = state.packs_applied_through {
            write_meta(&tx, META_PACKS_APPLIED_THROUGH, &watermark.to_string())?;
        }
        for entry in &state.quarantined {
            tx.execute(
                "INSERT INTO sync_quarantine
                   (item_type, item_id, signer_device_id, failed_at, attempt_count, last_error)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    entry.item_type,
                    entry.item_id,
                    entry.signer_device_id,
                    entry.failed_at,
                    entry.attempt_count,
                    entry.last_error
                ],
            )
            .map_err(failed)?;
        }
        for entry in &state.refused {
            tx.execute(
                "INSERT INTO sync_refused_items
                   (item_type, item_id, refused_by_version, refused_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    entry.item_type,
                    entry.item_id,
                    entry.refused_by_version,
                    entry.refused_at
                ],
            )
            .map_err(failed)?;
        }
        if state.owe_every_body {
            for doc_id in live_bodies(&tx)? {
                body_debt::owe(&tx, &doc_id)?;
            }
        }
        for merge in &state.journal_merges {
            journal_day_merge::write_owed(&tx, merge)?;
        }
        tx.commit().map_err(failed)
    }

    /// The staged sync state, for stage check 5 against the source.
    pub fn staged_sync_state(&self) -> Result<ImportSyncState, StorageError> {
        let conn = &self.data;
        let record_cursor = match store::read_cursor(conn, RECORD_CURSOR_SCOPE)? {
            Some(cursor) => Some(ImportRecordCursor {
                cursor,
                declaration: read_meta(conn, META_RECORD_DECLARATION)?.unwrap_or_default(),
            }),
            None => None,
        };
        Ok(ImportSyncState {
            record_cursor,
            cursor_skip_repair: read_meta(conn, META_CURSOR_SKIP_REPAIR)?,
            paused: pause::read(conn)?,
            packs_applied_through: read_meta(conn, META_PACKS_APPLIED_THROUGH)?
                .and_then(|text| text.parse().ok()),
            quarantined: quarantined(conn)?,
            refused: refused(conn)?,
            owe_every_body: {
                let owed = body_debt::owed(conn)?;
                live_bodies(conn)?.iter().all(|id| owed.contains(id))
            },
            journal_merges: journal_day_merge::owed(conn)?,
        })
    }

    /// Writes `rows` oldest first, so a tie on `created_at` reads back newest first by rowid as
    /// Electron's rows did. The caller passes at most [`history::KEEP`] rows.
    pub fn put_history(&mut self, rows: &[ImportHistory]) -> Result<(), StorageError> {
        if rows.len() as i64 > history::KEEP {
            return Err(StorageError::Failed {
                what: format!("{} history rows, over {}", rows.len(), history::KEEP),
            });
        }
        let tx = self.data.transaction().map_err(failed)?;
        for row in rows {
            tx.execute(
                "INSERT INTO sync_history
                   (id, kind, item_count, direction, details, duration_ms, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    row.id,
                    row.kind,
                    row.item_count,
                    row.direction,
                    row.details,
                    row.duration_ms,
                    row.created_at
                ],
            )
            .map_err(failed)?;
        }
        tx.commit().map_err(failed)
    }
}

/// Every live markdown note and journal day: the documents Electron's conversion owes
/// (`sweepNoteIds`, every markdown row of the index and data databases).
fn live_bodies(conn: &Connection) -> Result<Vec<String>, StorageError> {
    let mut stmt = conn
        .prepare(
            "SELECT id FROM notes WHERE deleted_at IS NULL AND file_type = 'markdown'
             UNION SELECT id FROM journal_entries WHERE deleted_at IS NULL
             ORDER BY id",
        )
        .map_err(failed)?;
    stmt.query_map([], |row| row.get(0))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

fn quarantined(conn: &Connection) -> Result<Vec<ImportQuarantined>, StorageError> {
    let mut stmt = conn
        .prepare(
            "SELECT item_type, item_id, signer_device_id, failed_at, attempt_count, last_error
             FROM sync_quarantine ORDER BY item_type, item_id",
        )
        .map_err(failed)?;
    stmt.query_map([], |row| {
        Ok(ImportQuarantined {
            item_type: row.get(0)?,
            item_id: row.get(1)?,
            signer_device_id: row.get(2)?,
            failed_at: row.get(3)?,
            attempt_count: row.get(4)?,
            last_error: row.get(5)?,
        })
    })
    .map_err(failed)?
    .collect::<Result<_, _>>()
    .map_err(failed)
}

fn refused(conn: &Connection) -> Result<Vec<ImportRefused>, StorageError> {
    let mut stmt = conn
        .prepare(
            "SELECT item_type, item_id, refused_by_version, refused_at
             FROM sync_refused_items ORDER BY item_type, item_id",
        )
        .map_err(failed)?;
    stmt.query_map([], |row| {
        Ok(ImportRefused {
            item_type: row.get(0)?,
            item_id: row.get(1)?,
            refused_by_version: row.get(2)?,
            refused_at: row.get(3)?,
        })
    })
    .map_err(failed)?
    .collect::<Result<_, _>>()
    .map_err(failed)
}
