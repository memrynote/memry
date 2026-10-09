//! One journal item per day, `j<YYYY-MM-DD>` (protocol §1.9.1, #2939).
//!
//! A journal id other than `j<D>` carrying date `D` is *foreign*. It is never
//! projected as a row: `journal_entries.date` is `UNIQUE`, and before this
//! module a foreign record for a day this device already held failed that
//! constraint and was recorded corrupt.
//!
//! Two halves, both keyed by one `meta` row per foreign id:
//!
//! - [`owed`] runs inside the page apply ([`plan_inbound`],
//!   [`hold_for_merge`], [`mark_deleted`]): it records each owed merge,
//!   removes a foreign local holder's projection when the canonical day
//!   arrives, and answers `Skipped` for a foreign record.
//! - [`drain`] runs after the pass's body step. Per owed merge it asks
//!   [`plan_journal_day_merge`] what to do: wait, forget, drop, or make sure
//!   `j<D>` exists, relink tasks, fold the foreign Yjs state into `j<D>` as a
//!   local edit, queue the foreign id's tombstone and purge its body. Only a
//!   merge tombstones the foreign id. Every step converges on a re-run.

mod owed;

use owed::owe_holder;
pub use owed::owed;
pub(crate) use owed::{hold_for_merge, mark_deleted, plan_inbound};

use rusqlite::{Connection, params};
use serde_json::json;

use crate::api::errors::StorageError;
use crate::crdt::errors::CrdtError;
use crate::crdt::registry::UpdateSink;
use crate::crdt::{DocumentRegistry, markdown_seed, update_log};
use crate::domain::journal::{self, ITEM_TYPE};
use crate::domain::journal_rules::{
    JournalDayMergeAction, JournalDayMergeState, canonical_journal_id, plan_journal_day_apply,
    plan_journal_day_merge,
};
use crate::domain::{body_write, tasks};
use crate::storage::Db;
use crate::storage::repositories::projectors;
use crate::storage::repositories::sync_items;

use super::body_debt;
use super::body_pull::BodyPull;
use super::clock::{self, VectorClock};
use super::{outbox, store};

const OWED_PREFIX: &str = "journal.day_merge:";

/// One owed merge: the foreign id's body goes into `j<date>`, then the
/// foreign id is tombstoned under `clock` ticked by this device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwedMerge {
    pub foreign_id: String,
    pub date: String,
    pub clock: VectorClock,
    /// A tombstone for the foreign id already arrived: another device merged
    /// it. The body is still merged when there is one; no tombstone is queued.
    pub deleted: bool,
    /// The foreign record's `content`. A live foreign id whose doc holds no
    /// Yjs state gets its body built from it (§1.9.1).
    pub record_markdown: Option<String>,
}

/// What one [`drain`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DrainReport {
    /// Foreign ids merged and tombstoned (or settled with no clock to tombstone).
    pub settled: Vec<String>,
    /// Foreign ids still owed: body not fully fetched, or a failure.
    pub owed: Vec<String>,
}

/// Settles every owed merge it can. Runs after the pass's body step.
///
/// A merge stays owed when the foreign body did not fully arrive or a step
/// failed. Only a local storage failure propagates.
pub async fn drain(
    db: &Db,
    bodies: &BodyPull,
    device_id: &str,
) -> Result<DrainReport, StorageError> {
    let mut report = DrainReport::default();
    for merge in db.call(|conn| owed(conn)).await? {
        let foreign_id = merge.foreign_id.clone();
        let settled = match drain_one(db, bodies, device_id, merge).await {
            Ok(settled) => settled,
            Err(DrainError::Storage(error)) => return Err(error),
            Err(DrainError::Step(what)) => {
                eprintln!("memry-core: journal day merge of {foreign_id} stays owed: {what}");
                false
            }
        };
        if settled {
            report.settled.push(foreign_id);
        } else {
            report.owed.push(foreign_id);
        }
    }
    Ok(report)
}

enum DrainError {
    Storage(StorageError),
    Step(String),
}

impl From<StorageError> for DrainError {
    fn from(error: StorageError) -> Self {
        DrainError::Storage(error)
    }
}

async fn drain_one(
    db: &Db,
    bodies: &BodyPull,
    device_id: &str,
    merge: OwedMerge,
) -> Result<bool, DrainError> {
    // A deleted id's server body is already in the day, merged by the device
    // that deleted it: only what this device holds is left to fold in.
    let body_pulled = merge.deleted
        || bodies
            .pull_document(&merge.foreign_id)
            .await
            .map_err(|error| DrainError::Step(error.to_string()))?
            .merged();
    let canonical = canonical_journal_id(&merge.date);
    let (foreign, day, date) = (
        merge.foreign_id.clone(),
        canonical.clone(),
        merge.date.clone(),
    );
    let has_text = build_text(&merge).is_some();
    let (has_body, day_deleted) = db
        .call(move |conn| {
            let has_body = has_text
                || !update_log::load_plan(conn, &foreign)
                    .map_err(crdt_failed)?
                    .is_empty();
            let day_deleted = journal::live_entry(conn, &date)?.as_deref() != Some(day.as_str())
                && sync_items::load(conn, ITEM_TYPE, &day)?
                    .is_some_and(|row| row.deleted_at.is_some());
            Ok((has_body, day_deleted))
        })
        .await?;
    let (action, tombstone) = plan_journal_day_merge(JournalDayMergeState {
        deleted: merge.deleted,
        body_pulled,
        has_body,
        day_deleted,
        clocked: !merge.clock.is_empty(),
    });
    match action {
        JournalDayMergeAction::Wait => return Ok(false),
        // Neither tombstones `F` (§1.9.1): a device that holds its text may
        // not have pushed it.
        JournalDayMergeAction::Forget => {
            db.call(move |conn| {
                let tx = conn.unchecked_transaction().map_err(failed)?;
                forget(&tx, &merge.foreign_id, now_ms())?;
                tx.commit().map_err(failed)
            })
            .await?;
            return Ok(true);
        }
        // A deleted day is not re-created (#2986). `F` stays live with its
        // row and body: only the owed merge goes.
        JournalDayMergeAction::Drop => {
            db.call(move |conn| drop_owed(conn, &merge.foreign_id))
                .await?;
            return Ok(true);
        }
        JournalDayMergeAction::Merge => {}
    }

    // The canonical day, created empty if missing. A foreign live holder is
    // swept in the same transaction, as an incoming canonical record would.
    let (date, device) = (merge.date.clone(), device_id.to_owned());
    let opened = db
        .call(move |conn| ensure_canonical(conn, &date, &device, now_ms()))
        .await
        .map_err(|error| DrainError::Step(error.to_string()))?;
    if opened != canonical {
        return Err(DrainError::Step(format!(
            "day {} is held by {opened}, not {canonical}",
            merge.date
        )));
    }

    let foreign = merge.foreign_id.clone();
    let device = device_id.to_owned();
    db.call(move |conn| settle(conn, &merge, &canonical, &device, tombstone, now_ms()))
        .await
        .map_err(|error| match error {
            StorageError::Failed { what } => DrainError::Step(format!("{foreign}: {what}")),
            other => DrainError::Storage(other),
        })
}

fn ensure_canonical(
    conn: &Connection,
    date: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    let canonical = canonical_journal_id(date);
    let holder = journal::live_entry(conn, date)?;
    let plan = plan_journal_day_apply(&canonical, date, holder.as_deref());
    let tx = conn.unchecked_transaction().map_err(failed)?;
    if let (true, Some(holder)) = (plan.remove_holder, holder.as_deref()) {
        owe_holder(&tx, holder, date)?;
        tx.execute("DELETE FROM journal_entries WHERE id = ?1", params![holder])
            .map_err(failed)?;
        tx.execute("DELETE FROM note_tags WHERE note_id = ?1", params![holder])
            .map_err(failed)?;
    }
    let opened = journal::open_day_in(&tx, date, device_id, now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(opened.id)
}

/// Relink, fold and tombstone for a foreign body already local. `Ok(false)`
/// leaves it owed.
fn settle(
    conn: &Connection,
    merge: &OwedMerge,
    canonical: &str,
    device_id: &str,
    tombstone: bool,
    now_ms: i64,
) -> Result<bool, StorageError> {
    let foreign = &merge.foreign_id;
    let plan = update_log::load_plan(conn, foreign).map_err(crdt_failed)?;
    let state = match (plan.is_empty(), build_text(merge)) {
        (false, _) => folded_state(foreign, &plan.blobs()).map_err(crdt_failed)?,
        (true, Some(markdown)) => built_state(foreign, device_id, markdown).map_err(crdt_failed)?,
        (true, None) => return Ok(false),
    };

    // Tasks linked to the foreign day follow it, each through the task
    // edit path so the change syncs. Each edit commits on its own; a re-run
    // finds nothing left to relink.
    for (task_id, linked) in tasks_linking(conn, foreign)? {
        let mut relinked: Vec<String> = Vec::with_capacity(linked.len());
        for id in linked {
            let id = if id == *foreign {
                canonical.to_owned()
            } else {
                id
            };
            if !relinked.contains(&id) {
                relinked.push(id);
            }
        }
        tasks::fields::set_linked_note_ids(conn, &task_id, &relinked, device_id, now_ms)?;
    }

    // The foreign state as a local edit of the canonical day: what it
    // authors is exactly the part the day does not hold yet, so a repeat
    // authors nothing and queues nothing.
    let update = body_write::author_with(conn, canonical, device_id, |document| {
        document.apply_local_update(&state)
    })
    .map_err(crdt_failed)?;

    let tx = conn.unchecked_transaction().map_err(failed)?;
    if let Some(update) = update {
        body_write::append_in(&tx, ITEM_TYPE, canonical, &update, now_ms).map_err(crdt_failed)?;
    }
    // The foreign id's tombstone when it is live and clocked, then its body
    // and its debts, in one transaction.
    if tombstone {
        tombstone_foreign(
            &tx,
            foreign,
            &clock::increment(&merge.clock, device_id),
            now_ms,
        )?;
    }
    forget(&tx, foreign, now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(true)
}

fn drop_owed(conn: &Connection, foreign: &str) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM meta WHERE key = ?1",
        params![format!("{OWED_PREFIX}{foreign}")],
    )
    .map_err(failed)?;
    Ok(())
}

/// The foreign id's projection, local body, body debt and owed-merge row.
fn forget(tx: &Connection, foreign: &str, now_ms: i64) -> Result<(), StorageError> {
    projectors::delete(tx, ITEM_TYPE, foreign, now_ms)?;
    update_log::purge_in(tx, foreign).map_err(crdt_failed)?;
    body_debt::settle(tx, foreign)?;
    drop_owed(tx, foreign)
}

/// The record text a live foreign id with no Yjs history is built from. A
/// deleted one was merged by the device that deleted it, which built any body
/// it lacked; building it here too would mint a second copy. The core keeps
/// no day file, so a holder's unpushed text is only ever its local Yjs
/// state, which `settle` folds whether or not `F` is deleted.
fn build_text(merge: &OwedMerge) -> Option<&str> {
    merge
        .record_markdown
        .as_deref()
        .filter(|markdown| !merge.deleted && !markdown.trim().is_empty())
}

/// The foreign doc built from its record text, as one v1 update. Its client
/// id is fixed per (foreign id, device): a retry mints the same Yjs items,
/// which the day already holds, so nothing folds twice. Two devices build
/// different items, so a concurrent build shows the text twice (§1.9.1).
fn built_state(foreign_id: &str, device_id: &str, markdown: &str) -> Result<Vec<u8>, CrdtError> {
    let sink: UpdateSink = std::sync::Arc::new(|_, _| {});
    let author = format!("{foreign_id}\0{device_id}");
    let document = DocumentRegistry::new(&author, sink).get_or_open(foreign_id)?;
    markdown_seed::seed_document(&document, markdown)?;
    document.encode_state()
}

/// Every update of the foreign doc, server then local, as one v1 update.
fn folded_state(doc_id: &str, blobs: &[&[u8]]) -> Result<Vec<u8>, CrdtError> {
    let sink: UpdateSink = std::sync::Arc::new(|_, _| {});
    let document = DocumentRegistry::new("journal-day-merge", sink).get_or_open(doc_id)?;
    for blob in blobs {
        document.apply_durable_update(blob)?;
    }
    document.encode_state()
}

fn tasks_linking(
    conn: &Connection,
    foreign_id: &str,
) -> Result<Vec<(String, Vec<String>)>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT id, linked_note_ids FROM tasks
             WHERE deleted_at IS NULL AND instr(linked_note_ids, ?1) > 0",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![foreign_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, linked)| {
            let linked: Vec<String> = serde_json::from_str(&linked).ok()?;
            linked
                .iter()
                .any(|linked| linked == foreign_id)
                .then_some((id, linked))
        })
        .collect())
}

/// Writes the foreign id's tombstone row and queues its delete. The push
/// rebuilds the envelope from this row (§6.5.2 P2), so the row carries the
/// ticked clock and `deleted_at`. The payload is `{clock}` on every client,
/// which a delete never decodes (§5.12).
fn tombstone_foreign(
    tx: &Connection,
    foreign_id: &str,
    clock: &VectorClock,
    now_ms: i64,
) -> Result<(), StorageError> {
    let clock_value = serde_json::to_value(clock).map_err(|error| StorageError::Failed {
        what: error.to_string(),
    })?;
    let payload = json!({ "clock": clock_value }).to_string();
    tx.execute(
        "INSERT INTO sync_items (
             item_type, item_id, payload, payload_state, clock, updated_at, deleted_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(item_type, item_id) DO UPDATE SET
             payload = excluded.payload,
             payload_state = excluded.payload_state,
             clock = excluded.clock,
             updated_at = excluded.updated_at,
             deleted_at = excluded.deleted_at,
             corrupt_reason = NULL,
             corrupt_at = NULL",
        params![
            ITEM_TYPE,
            foreign_id,
            payload,
            sync_items::PAYLOAD_STATE_FULL,
            clock_value.to_string(),
            now_ms,
        ],
    )
    .map_err(failed)?;
    store::record_tombstone_clock(tx, ITEM_TYPE, foreign_id, clock, now_ms)?;
    outbox::enqueue(tx, &outbox::Change::delete(ITEM_TYPE, foreign_id), now_ms)?;
    Ok(())
}

fn crdt_failed(error: CrdtError) -> StorageError {
    match error {
        CrdtError::Storage { source } => source,
        other => StorageError::Failed {
            what: other.to_string(),
        },
    }
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}
