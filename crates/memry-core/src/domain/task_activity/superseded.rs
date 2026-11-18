//! `superseded`: a local task edit that lost a concurrent merge
//! (`apps/desktop/src/main/tasks/activity-log.ts` `recordTaskSuperseded`,
//! called from `task-handler.ts` for each merge conflict).
//!
//! A lost merge has no other trace: ordinary changes arrive as the peer's own
//! `task_activity` rows, but the peer never saw this device's edit. So the
//! losing device writes it, from the applied-record feed after the page
//! commits ([`SupersededObserver`]), in its own transaction.
//!
//! Both sides of one conflict mint the same id, from the field's **merged**
//! clock, which is the same on both devices (merge is commutative). When both
//! lose (chapter 06 §6.6.2's mirrored state), insert-if-absent collapses the
//! two rows into one.

use std::sync::Arc;

use rusqlite::Connection;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::api::errors::StorageError;
use crate::domain::tasks::{self, valid_item_id};
use crate::storage::Db;
use crate::storage::repositories::sync_items;
use crate::sync::driver::observer::{AppliedRecord, ApplyObserver};
use crate::sync::field_merge::canonical_json;

use super::{
    ACTION_SUPERSEDED, ACTOR_SYNC, IGNORED_FIELDS, ITEM_TYPE, LENGTH_ONLY_FIELD, NewActivity,
    encode, in_transaction, insert_row, prune_in, text_length,
};

/// One field this device lost: its own value, the value that replaced it, and
/// the field's merged clock.
#[derive(Debug, Clone, Copy)]
pub struct LostField<'a> {
    pub task_id: &'a str,
    pub field: &'a str,
    pub losing: &'a Value,
    pub winning: &'a Value,
    pub merged_clock: &'a Value,
}

/// `taskSupersededActivityId`: `tac_` and the first 20 hex characters of
/// sha256 over `<taskId> <field> <canonical merged clock>`.
pub fn superseded_id(task_id: &str, field: &str, merged_clock: &Value) -> String {
    let digest = Sha256::digest(format!(
        "{task_id} {field} {}",
        canonical_json(merged_clock)
    ));
    format!("tac_{}", &hex::encode(digest)[..20])
}

/// Writes the `superseded` row of `lost` unless a row with its id exists,
/// with its outbox row, and prunes expired rows alongside. Returns the id
/// written, `None` when nothing was.
///
/// Nothing is written for `position` and `modifiedAt` (desktop's noise list)
/// or for a task that is not live here: desktop deletes the row, so the remote
/// edit re-creates it rather than merging and no conflict exists.
pub fn record_superseded(
    conn: &Connection,
    lost: &LostField<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<Option<String>, StorageError> {
    if IGNORED_FIELDS.contains(&lost.field) {
        return Ok(None);
    }
    valid_item_id(lost.task_id)?;
    let id = superseded_id(lost.task_id, lost.field, lost.merged_clock);
    let row = if lost.field == LENGTH_ONLY_FIELD {
        // A losing description is still a description: only its length
        // travels.
        let delta = text_length(lost.winning) - text_length(lost.losing);
        NewActivity {
            action: ACTION_SUPERSEDED,
            field: Some(lost.field.to_owned()),
            old_value: None,
            new_value: Some(json!({ "delta": delta }).to_string()),
        }
    } else {
        NewActivity {
            action: ACTION_SUPERSEDED,
            field: Some(lost.field.to_owned()),
            old_value: encode(lost.losing),
            new_value: encode(lost.winning),
        }
    };
    in_transaction(conn, |tx| {
        let live = sync_items::load(tx, tasks::ITEM_TYPE, lost.task_id)?
            .is_some_and(|task| task.deleted_at.is_none() && task.payload.is_some());
        // A row with this id is the peer's copy of the same conflict: queueing
        // it again would push a row this device did not author.
        if !live || sync_items::load(tx, ITEM_TYPE, &id)?.is_some() {
            return Ok(None);
        }
        insert_row(tx, &id, lost.task_id, &row, ACTOR_SYNC, device_id, now_ms)?;
        prune_in(tx, now_ms)?;
        Ok(Some(id))
    })
}

/// Records a `superseded` row for every task field this device lost in a
/// committed page. Registered by the desktop sync driver.
pub struct SupersededObserver {
    db: Db,
    device_id: String,
}

impl SupersededObserver {
    pub fn new(db: Db, device_id: String) -> Arc<Self> {
        Arc::new(Self { db, device_id })
    }
}

impl ApplyObserver for SupersededObserver {
    fn name(&self) -> &str {
        "task-superseded"
    }

    fn records_applied(&self, batch: &[AppliedRecord]) {
        let lost: Vec<&AppliedRecord> = batch
            .iter()
            .filter(|record| record.item_type == tasks::ITEM_TYPE)
            .filter(|record| record.conflicts.iter().any(|c| c.local_lost))
            .collect();
        if lost.is_empty() {
            return;
        }
        let now_ms = now_ms();
        let written = self.db.call_blocking(|conn| {
            for record in lost {
                for conflict in record.conflicts.iter().filter(|c| c.local_lost) {
                    let field = LostField {
                        task_id: &record.item_id,
                        field: &conflict.field,
                        losing: &conflict.losing,
                        winning: &conflict.winning,
                        merged_clock: &conflict.merged_clock,
                    };
                    // One bad row must not drop the rest of the page's.
                    if let Err(error) = record_superseded(conn, &field, &self.device_id, now_ms) {
                        eprintln!(
                            "memry-core: could not record that task {} lost its `{}` edit: {error}",
                            record.item_id, conflict.field
                        );
                    }
                }
            }
            Ok(())
        });
        if let Err(error) = written {
            eprintln!("memry-core: could not record the superseded task edits: {error}");
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}
