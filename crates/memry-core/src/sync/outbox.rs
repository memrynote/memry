//! The durable write queue, data-model §A.2 and §C.4 (T116, FR-030).
//!
//! `outbox` is the one table whose loss loses a user's work, and three rules
//! shape every function below.
//!
//! **Durable before acknowledged.** The outbox row and its source row commit
//! **together or not at all**, and the acknowledgement is minted only after
//! the commit returns. [`enqueue`] refuses to run in autocommit mode, so an
//! outbox row written outside its source row's transaction is a runtime
//! error rather than a divergence discovered a week later; [`commit`] is the
//! ergonomic form that opens the transaction, writes the source first and the
//! outbox row second, and hands back a [`Durable`] that cannot be built any
//! other way.
//!
//! **A record row carries no payload — chapter 06 §6.5.2's P2.** The wire
//! payload is rebuilt from the live `sync_items` row at send time by
//! [`crate::storage::repositories::sync_items::push_payload`]. An outbox that
//! froze the payload at enqueue reintroduces §6.5.1's case-3c divergence
//! *deterministically, not as a race*, so [`Change::Record`] has no payload
//! field to freeze one into and [`enqueue`] binds `payload` to `NULL` for
//! every record row. A CRDT row is the other case and the opposite rule: the
//! Yjs update bytes **are** the change, there is no live row to rebuild them
//! from, and losing them loses the edit.
//!
//! **Collapse is for records only.** A record enqueue supersedes every earlier
//! non-CRDT row for the same `(item_type, item_id)`, because the payload is
//! the whole item and a row sitting in backoff would otherwise re-push a stale
//! one. A CRDT enqueue never coalesces: a merged update cannot be re-sent
//! individually if the batch is rejected, and the server acks CRDT rows
//! against the sequence it assigned to each specific update.

use std::collections::HashMap;

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;

/// The three `op` spellings data-model §A.2 defines.
pub const OP_UPSERT: &str = "upsert";
pub const OP_DELETE: &str = "delete";
pub const OP_CRDT_UPDATE: &str = "crdt-update";

/// §A.2 calls `last_error` truncated without naming a length. This is the
/// core's ceiling: long enough to carry a server reason, short enough that a
/// pathological error body cannot grow the one table whose loss loses work.
pub const MAX_LAST_ERROR_CHARS: usize = 500;

/// §7.3: at most 100 updates ride one `POST /sync/crdt/updates`.
pub const MAX_CRDT_UPDATES_PER_BATCH: usize = 100;

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// The two record operations. **`crdt-update` is deliberately not one of
/// them**: it is a different variant of [`Change`] with different rules, and
/// widening this enum is how the two sets of rules get confused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordOp {
    Upsert,
    Delete,
}

impl RecordOp {
    pub fn as_str(self) -> &'static str {
        match self {
            RecordOp::Upsert => OP_UPSERT,
            RecordOp::Delete => OP_DELETE,
        }
    }
}

/// One change to make durable.
///
/// **There is no payload field on `Record`.** That is the structural half of
/// chapter 06 §6.5.2's P2: a caller cannot freeze a push payload at enqueue
/// because there is nowhere to put one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    /// A record change, identified by `(item_type, item_id)` and nothing else.
    Record {
        item_type: String,
        item_id: String,
        op: RecordOp,
    },
    /// One Yjs update for one document. The bytes are the change.
    CrdtUpdate {
        item_type: String,
        doc_id: String,
        update: Vec<u8>,
    },
}

impl Change {
    pub fn upsert(item_type: &str, item_id: &str) -> Self {
        Change::Record {
            item_type: item_type.to_owned(),
            item_id: item_id.to_owned(),
            op: RecordOp::Upsert,
        }
    }

    pub fn delete(item_type: &str, item_id: &str) -> Self {
        Change::Record {
            item_type: item_type.to_owned(),
            item_id: item_id.to_owned(),
            op: RecordOp::Delete,
        }
    }

    pub fn crdt_update(item_type: &str, doc_id: &str, update: Vec<u8>) -> Self {
        Change::CrdtUpdate {
            item_type: item_type.to_owned(),
            doc_id: doc_id.to_owned(),
            update,
        }
    }

    pub fn item_type(&self) -> &str {
        match self {
            Change::Record { item_type, .. } | Change::CrdtUpdate { item_type, .. } => item_type,
        }
    }

    pub fn item_id(&self) -> &str {
        match self {
            Change::Record { item_id, .. } => item_id,
            Change::CrdtUpdate { doc_id, .. } => doc_id,
        }
    }

    pub fn op(&self) -> &'static str {
        match self {
            Change::Record { op, .. } => op.as_str(),
            Change::CrdtUpdate { .. } => OP_CRDT_UPDATE,
        }
    }
}

/// A row of `outbox`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxRow {
    pub id: i64,
    pub item_type: String,
    pub item_id: String,
    pub op: String,
    /// The Yjs update bytes for a CRDT row; **always `None` for a record
    /// row** (§6.5.2 P2).
    pub payload: Option<Vec<u8>>,
    pub enqueued_at: i64,
    pub attempt_count: i64,
    pub last_error: Option<String>,
    pub next_attempt_at: Option<i64>,
}

impl OutboxRow {
    pub fn is_crdt(&self) -> bool {
        self.op == OP_CRDT_UPDATE
    }
}

/// Proof that a change is on disk.
///
/// The only constructor is [`commit`], and it runs after `COMMIT` returned.
/// A caller that holds one of these may acknowledge the change to the shell,
/// the editor surface or the user; a caller that does not, may not. §C.4's
/// "durable before acknowledged" is this type.
#[derive(Debug)]
pub struct Durable<T> {
    value: T,
    outbox_id: i64,
}

impl<T> Durable<T> {
    /// The `outbox.id` the change was queued under.
    pub fn outbox_id(&self) -> i64 {
        self.outbox_id
    }

    /// Takes the source write's own result. Consuming is the point: the
    /// acknowledgement happens once, here, after the commit.
    pub fn acknowledge(self) -> T {
        self.value
    }
}

/// Writes the source row and the outbox row in **one** transaction and
/// acknowledges only after it commits (FR-030, §C.4).
///
/// `source` runs **first** and receives the open transaction; the outbox
/// insert follows it. The order is load-bearing in one direction only — a
/// failing source write must leave no outbox row — but it is also what lets a
/// caller's source write read back what it just wrote.
pub fn commit<T, F>(
    conn: &Connection,
    change: &Change,
    now_ms: i64,
    source: F,
) -> Result<Durable<T>, StorageError>
where
    F: FnOnce(&Connection) -> Result<T, StorageError>,
{
    let transaction = conn.unchecked_transaction().map_err(failed)?;
    let value = source(&transaction)?;
    let outbox_id = enqueue(&transaction, change, now_ms)?;
    transaction.commit().map_err(failed)?;
    Ok(Durable { value, outbox_id })
}

/// Inserts one outbox row **inside a transaction the caller already holds**.
///
/// Refusing autocommit is the structural guarantee: an outbox row written on
/// its own is a change acknowledged before its source row is durable, which
/// is the edge FR-030 exists to close. Use [`commit`] when there is no
/// transaction yet.
pub fn enqueue(tx: &Connection, change: &Change, now_ms: i64) -> Result<i64, StorageError> {
    if tx.is_autocommit() {
        return Err(StorageError::Failed {
            what: "an outbox row must be written in the same transaction as its source row \
                   (FR-030, data-model §A.2, §C.4)"
                .to_owned(),
        });
    }

    // A record enqueue supersedes: the payload is the whole item, so an older
    // row says nothing new, and a row sitting in backoff is invisible to a
    // per-id collapse and later re-pushes a stale payload. Scoped to
    // `op != 'crdt-update'` — collapsing CRDT rows drops updates a peer has
    // not seen.
    if let Change::Record {
        item_type, item_id, ..
    } = change
    {
        tx.execute(
            "DELETE FROM outbox
              WHERE item_type = ?1 AND item_id = ?2 AND op <> ?3",
            params![item_type, item_id, OP_CRDT_UPDATE],
        )
        .map_err(failed)?;
    }

    // `payload` is `NULL` for every record row and there is no code path that
    // can make it anything else: §6.5.2 P2.
    let payload: Option<&[u8]> = match change {
        Change::Record { .. } => None,
        Change::CrdtUpdate { update, .. } => Some(update),
    };

    tx.execute(
        "INSERT INTO outbox (item_type, item_id, op, payload, enqueued_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            change.item_type(),
            change.item_id(),
            change.op(),
            payload,
            now_ms
        ],
    )
    .map_err(failed)?;
    Ok(tx.last_insert_rowid())
}

/// How many rows are claimable now. Never removes one.
///
/// Rows parked in backoff are excluded: `next_attempt_at` NULL means
/// claimable now (§A.2), and a pass that entered `Pushing` for a row it
/// cannot yet send would report a push that never happened.
pub fn pending(conn: &Connection, now_ms: i64) -> Result<usize, StorageError> {
    conn.query_row(
        "SELECT count(*) FROM outbox
          WHERE next_attempt_at IS NULL OR next_attempt_at <= ?1",
        params![now_ms],
        |row| row.get::<_, i64>(0),
    )
    .map_err(failed)
    .map(|count| count as usize)
}

/// Every row, claimable or not. The queue depth a UI would show.
pub fn depth(conn: &Connection) -> Result<usize, StorageError> {
    conn.query_row("SELECT count(*) FROM outbox", [], |row| {
        row.get::<_, i64>(0)
    })
    .map_err(failed)
    .map(|count| count as usize)
}

/// One record row to send, plus the older rows it stands for.
///
/// The push response is per item id, so two rows sharing an id cannot be told
/// apart in a mixed accept-and-reject response (§A.2). The newest row is sent
/// and the rest ride its verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Collapsed {
    pub row: OutboxRow,
    /// Older rows for the same `(item_type, item_id)`. Acked with `row`,
    /// never sent.
    pub superseded: Vec<i64>,
}

impl Collapsed {
    /// Every outbox id this push item accounts for.
    pub fn ids(&self) -> Vec<i64> {
        let mut ids = vec![self.row.id];
        ids.extend_from_slice(&self.superseded);
        ids
    }
}

/// The next wave of work, already ordered and grouped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Batch {
    /// One document's updates, oldest first. **Never coalesced**: each row is
    /// acked against the sequence the server assigned to that update, which
    /// is what lets many rows for one document ride one wave.
    Crdt {
        item_type: String,
        doc_id: String,
        rows: Vec<OutboxRow>,
    },
    /// Record rows, collapsed to one push item per `(item_type, item_id)`.
    Records { items: Vec<Collapsed> },
}

impl Batch {
    /// Every outbox id in the batch, including superseded rows.
    pub fn ids(&self) -> Vec<i64> {
        match self {
            Batch::Crdt { rows, .. } => rows.iter().map(|row| row.id).collect(),
            Batch::Records { items } => items.iter().flat_map(Collapsed::ids).collect(),
        }
    }

    pub fn len(&self) -> usize {
        match self {
            Batch::Crdt { rows, .. } => rows.len(),
            Batch::Records { items } => items.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Reads the claimable rows in send order: **CRDT rows first, grouped by
/// document, then record rows** (§A.2).
///
/// The order is what stops a body edit landing after its own note's delete.
/// It is expressed in SQL rather than sorted afterwards so that `limit`
/// truncates the tail of the wave and never its head.
pub fn claim(conn: &Connection, now_ms: i64, limit: usize) -> Result<Vec<OutboxRow>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT id, item_type, item_id, op, payload, enqueued_at,
                    attempt_count, last_error, next_attempt_at
               FROM outbox
              WHERE next_attempt_at IS NULL OR next_attempt_at <= ?1
              ORDER BY (op <> ?2),
                       CASE WHEN op = ?2 THEN item_id ELSE '' END,
                       id
              LIMIT ?3",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![now_ms, OP_CRDT_UPDATE, limit as i64], |row| {
            Ok(OutboxRow {
                id: row.get(0)?,
                item_type: row.get(1)?,
                item_id: row.get(2)?,
                op: row.get(3)?,
                payload: row.get(4)?,
                enqueued_at: row.get(5)?,
                attempt_count: row.get(6)?,
                last_error: row.get(7)?,
                next_attempt_at: row.get(8)?,
            })
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    Ok(rows)
}

/// The next batch to send, or `None` when nothing is claimable.
///
/// One batch is either one document's CRDT updates or a run of record rows,
/// never both: they go to different routes, and §A.2's ordering puts every
/// CRDT row ahead of every record row within a pass.
pub fn next_batch(
    conn: &Connection,
    now_ms: i64,
    limit: usize,
) -> Result<Option<Batch>, StorageError> {
    let limit = limit.max(1);
    let rows = claim(conn, now_ms, limit)?;
    let Some(head) = rows.first() else {
        return Ok(None);
    };

    if head.is_crdt() {
        let item_type = head.item_type.clone();
        let doc_id = head.item_id.clone();
        let rows: Vec<OutboxRow> = rows
            .into_iter()
            .take_while(|row| row.is_crdt() && row.item_id == doc_id)
            .take(MAX_CRDT_UPDATES_PER_BATCH)
            .collect();
        return Ok(Some(Batch::Crdt {
            item_type,
            doc_id,
            rows,
        }));
    }

    Ok(Some(Batch::Records {
        items: collapse_records(rows),
    }))
}

/// Collapses record rows to one per `(item_type, item_id)`, keeping the
/// newest — the highest `id`, which is the insertion order (§A.2).
///
/// CRDT rows are returned untouched and uncollapsed; collapsing them would
/// drop updates a peer has not seen.
pub fn collapse_records(rows: Vec<OutboxRow>) -> Vec<Collapsed> {
    let mut order: Vec<(String, String)> = Vec::new();
    let mut grouped: HashMap<(String, String), Vec<OutboxRow>> = HashMap::new();
    for row in rows {
        if row.is_crdt() {
            continue;
        }
        let key = (row.item_type.clone(), row.item_id.clone());
        if !grouped.contains_key(&key) {
            order.push(key.clone());
        }
        grouped.entry(key).or_default().push(row);
    }

    order
        .into_iter()
        .filter_map(|key| {
            let mut rows = grouped.remove(&key)?;
            rows.sort_by_key(|row| row.id);
            let newest = rows.pop()?;
            Ok::<_, ()>(Collapsed {
                row: newest,
                superseded: rows.into_iter().map(|row| row.id).collect(),
            })
            .ok()
        })
        .collect()
}

/// Ack is delete, per id, and **only for ids the server accepted** (§A.2).
pub fn ack(conn: &Connection, ids: &[i64]) -> Result<usize, StorageError> {
    let mut removed = 0;
    for id in ids {
        removed += conn
            .execute("DELETE FROM outbox WHERE id = ?1", params![id])
            .map_err(failed)?;
    }
    Ok(removed)
}

/// Records a rejection against rows that stay queued: one attempt, the
/// truncated reason, and the earliest time to try again.
///
/// **Never called on the parked path.** A `403 PLATFORM_WRITES_DISABLED` or a
/// `426 CLIENT_UPGRADE_REQUIRED` stops the pass without touching
/// `attempt_count`, so no backoff accrues against a condition the user cannot
/// fix (§11.9, §A.2) and a parked queue drains at full speed the moment the
/// policy clears.
pub fn defer(
    conn: &Connection,
    ids: &[i64],
    reason: &str,
    next_attempt_at: Option<i64>,
) -> Result<(), StorageError> {
    let reason = truncate(reason);
    for id in ids {
        conn.execute(
            "UPDATE outbox
                SET attempt_count = attempt_count + 1,
                    last_error = ?2,
                    next_attempt_at = ?3
              WHERE id = ?1",
            params![id, reason, next_attempt_at],
        )
        .map_err(failed)?;
    }
    Ok(())
}

/// Retires rows that will never succeed: an unparseable payload, and a row
/// rejected as too large (§A.2). Acked locally, with the reason recorded on
/// the row first so a crash inside the window leaves the reason behind rather
/// than a silent disappearance.
pub fn retire(conn: &Connection, ids: &[i64], reason: &str) -> Result<(), StorageError> {
    let transaction = conn.unchecked_transaction().map_err(failed)?;
    let truncated = truncate(reason);
    for id in ids {
        transaction
            .execute(
                "UPDATE outbox SET last_error = ?2 WHERE id = ?1",
                params![id, truncated],
            )
            .map_err(failed)?;
        transaction
            .execute("DELETE FROM outbox WHERE id = ?1", params![id])
            .map_err(failed)?;
    }
    transaction.commit().map_err(failed)?;
    Ok(())
}

fn truncate(reason: &str) -> String {
    reason.chars().take(MAX_LAST_ERROR_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: i64, item_type: &str, item_id: &str, op: &str) -> OutboxRow {
        OutboxRow {
            id,
            item_type: item_type.to_owned(),
            item_id: item_id.to_owned(),
            op: op.to_owned(),
            payload: None,
            enqueued_at: 0,
            attempt_count: 0,
            last_error: None,
            next_attempt_at: None,
        }
    }

    #[test]
    fn collapse_keeps_the_newest_row_per_key_and_drops_no_id() {
        let collapsed = collapse_records(vec![
            row(1, "task", "t1", OP_UPSERT),
            row(2, "task", "t2", OP_UPSERT),
            row(3, "task", "t1", OP_DELETE),
        ]);
        assert_eq!(collapsed.len(), 2);
        assert_eq!(collapsed[0].row.id, 3);
        assert_eq!(collapsed[0].row.op, OP_DELETE);
        assert_eq!(collapsed[0].superseded, vec![1]);
        assert_eq!(collapsed[0].ids(), vec![3, 1]);
        assert_eq!(collapsed[1].row.id, 2);
        assert!(collapsed[1].superseded.is_empty());
    }

    #[test]
    fn collapse_never_touches_a_crdt_row() {
        let collapsed = collapse_records(vec![
            row(1, "note", "n1", OP_CRDT_UPDATE),
            row(2, "note", "n1", OP_CRDT_UPDATE),
        ]);
        assert!(
            collapsed.is_empty(),
            "collapsing CRDT rows drops updates a peer has not seen"
        );
    }

    #[test]
    fn the_same_id_under_two_types_is_two_push_items() {
        // §5.15: the bookkeeping key is `(type, id)` and never `id` alone.
        let collapsed = collapse_records(vec![
            row(1, "project", "inbox", OP_UPSERT),
            row(2, "tag_definition", "inbox", OP_UPSERT),
        ]);
        assert_eq!(collapsed.len(), 2);
    }

    #[test]
    fn last_error_is_truncated() {
        let long = "x".repeat(MAX_LAST_ERROR_CHARS * 2);
        assert_eq!(truncate(&long).chars().count(), MAX_LAST_ERROR_CHARS);
    }
}
