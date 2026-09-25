//! The two-namespace CRDT update log (data-model §A.2, chapter 07).
//!
//! One document has **two independent sequence spaces** in the same two tables,
//! told apart by the `doc_id` written into the row:
//!
//! | Namespace | `doc_id`              | Sequence source                                     |
//! | --------- | --------------------- | --------------------------------------------------- |
//! | server    | the bare document id  | the server's `sequence_num`, never proposed locally |
//! | local     | `local.<documentId>`  | `MAX(seq) + 1` read inside the writing transaction  |
//!
//! **They must not share a space.** A local append that took a sequence a later
//! server row also claims would silently drop one of the two under an upsert.
//! Document ids are bare — a note id is twelve lowercase alphanumerics, a
//! journal id is `j` followed by an ISO date — so the `local.` prefix cannot
//! collide with either.
//!
//! Two rules are easy to implement wrongly and both cost data:
//!
//! - **A read of "updates since N" must also consult the snapshot row.** A fold
//!   deletes the update rows it absorbed, so an updates-only read answers empty
//!   for a document that certainly did change. [`load_plan`] is the read that
//!   gets this right, and it is the one the loader should use.
//! - **A local fold folds at a sequence read inside the transaction**, not at a
//!   count handed in. A count used as a sequence prunes nothing after the first
//!   fold. [`fold_local`] reads `MAX(seq)` itself, inside its own transaction,
//!   and callers cannot pass one.
//!
//! Nothing here decodes an update. The blobs are opaque bytes to this module;
//! [`super::registry`] is the only place that knows what they mean.

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;

use super::errors::CrdtError;

/// The prefix that separates the local sequence space from the server's.
pub const LOCAL_NAMESPACE_PREFIX: &str = "local.";

/// Which of a document's two sequence spaces a row belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Namespace {
    /// Rows the server numbered. `server_revision` on a snapshot is the
    /// server's opaque token (chapter 07 §7.5).
    Server,
    /// Rows this device numbered. A snapshot here carries no server revision:
    /// inventing one can collide with a real token and suppress a baseline the
    /// client needed (chapter 07 §7.13.4, until #2187).
    Local,
}

impl Namespace {
    /// The `doc_id` a row of this namespace is written under.
    pub fn row_id(self, doc_id: &str) -> String {
        match self {
            Self::Server => doc_id.to_owned(),
            Self::Local => format!("{LOCAL_NAMESPACE_PREFIX}{doc_id}"),
        }
    }
}

/// One row of `yjs_updates`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateRow {
    pub seq: i64,
    pub update_blob: Vec<u8>,
    pub created_at: i64,
}

/// One row of `yjs_snapshots`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotRow {
    pub snapshot: Vec<u8>,
    /// The fold point: every update at or below it is inside `snapshot`.
    pub last_seq: i64,
    pub server_revision: Option<String>,
    pub compacted_at: i64,
}

/// Everything needed to bring a document up to date, in the order it must be
/// applied: **server snapshot, server updates, local snapshot, local updates**
/// (data-model §A.2).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LoadPlan {
    pub server_snapshot: Option<SnapshotRow>,
    pub server_updates: Vec<UpdateRow>,
    pub local_snapshot: Option<SnapshotRow>,
    pub local_updates: Vec<UpdateRow>,
}

impl LoadPlan {
    /// The blobs to apply, already in order.
    pub fn blobs(&self) -> Vec<&[u8]> {
        let mut out: Vec<&[u8]> = Vec::new();
        if let Some(snapshot) = &self.server_snapshot {
            out.push(&snapshot.snapshot);
        }
        out.extend(
            self.server_updates
                .iter()
                .map(|row| row.update_blob.as_slice()),
        );
        if let Some(snapshot) = &self.local_snapshot {
            out.push(&snapshot.snapshot);
        }
        out.extend(
            self.local_updates
                .iter()
                .map(|row| row.update_blob.as_slice()),
        );
        out
    }

    /// Whether this document has anything on disk at all.
    pub fn is_empty(&self) -> bool {
        self.server_snapshot.is_none()
            && self.local_snapshot.is_none()
            && self.server_updates.is_empty()
            && self.local_updates.is_empty()
    }
}

/// Records an update the server numbered.
///
/// `sequence_num` comes from the server and from nowhere else: a client never
/// proposes one (chapter 07 §7.4). `INSERT OR IGNORE`, because a replayed pull
/// answering the same sequence twice is a duplicate delivery, not new data.
pub fn append_server_update(
    conn: &Connection,
    doc_id: &str,
    sequence_num: i64,
    update_blob: &[u8],
    created_at: i64,
) -> Result<(), CrdtError> {
    conn.execute(
        "INSERT OR IGNORE INTO yjs_updates (doc_id, seq, update_blob, created_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            Namespace::Server.row_id(doc_id),
            sequence_num,
            update_blob,
            created_at
        ],
    )
    .map_err(failed("append a server update"))?;
    Ok(())
}

/// Records an update this device authored, taking the next local sequence.
///
/// The `MAX(seq) + 1` read and the insert are **one** transaction, which is
/// what makes two concurrent appends take two sequences rather than one.
pub fn append_local_update(
    conn: &mut Connection,
    doc_id: &str,
    update_blob: &[u8],
    created_at: i64,
) -> Result<i64, CrdtError> {
    let txn = conn
        .transaction()
        .map_err(failed("open the append transaction"))?;
    let next = append_local_update_in(&txn, doc_id, update_blob, created_at)?;
    txn.commit().map_err(failed("commit the append"))?;
    Ok(next)
}

/// The same append, **inside a transaction the caller already holds**.
///
/// This is the form a local *edit* takes: FR-030 and data-model §A.2 require
/// the update row and its `outbox` row to commit together or not at all, and
/// [`crate::sync::outbox::commit`] owns that transaction. Refusing autocommit
/// is the same structural guarantee [`crate::sync::outbox::enqueue`] makes
/// from the other side — an update row written on its own is an edit that is
/// durable locally and that no peer will ever be sent.
pub fn append_local_update_in(
    tx: &Connection,
    doc_id: &str,
    update_blob: &[u8],
    created_at: i64,
) -> Result<i64, CrdtError> {
    if tx.is_autocommit() {
        return Err(CrdtError::Storage {
            source: StorageError::Failed {
                what: "a local update must be written in the same transaction as its outbox row \
                       (FR-030, data-model §A.2)"
                    .to_owned(),
            },
        });
    }
    let row_id = Namespace::Local.row_id(doc_id);
    let next = next_local_seq(tx, &row_id)?;
    tx.execute(
        "INSERT INTO yjs_updates (doc_id, seq, update_blob, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![row_id, next, update_blob, created_at],
    )
    .map_err(failed("append a local update"))?;
    Ok(next)
}

/// The next local sequence: one past the highest the update log **or** the
/// snapshot fold point has claimed.
///
/// The snapshot half matters. A fold deletes the rows it absorbed, so
/// `MAX(seq)` over `yjs_updates` alone walks backwards after a compaction and
/// hands out a sequence that was already used.
fn next_local_seq(conn: &Connection, row_id: &str) -> Result<i64, CrdtError> {
    let high: i64 = conn
        .query_row(
            "SELECT MAX(high) FROM (
               SELECT COALESCE(MAX(seq), 0) AS high FROM yjs_updates WHERE doc_id = ?1
               UNION ALL
               SELECT COALESCE(MAX(last_seq), 0) AS high FROM yjs_snapshots WHERE doc_id = ?1
             )",
            params![row_id],
            |row| row.get(0),
        )
        .map_err(failed("read the highest local sequence"))?;
    Ok(high + 1)
}

/// Updates above `after_seq` in one namespace, oldest first.
pub fn updates_after(
    conn: &Connection,
    namespace: Namespace,
    doc_id: &str,
    after_seq: i64,
) -> Result<Vec<UpdateRow>, CrdtError> {
    let mut statement = conn
        .prepare(
            "SELECT seq, update_blob, created_at FROM yjs_updates
             WHERE doc_id = ?1 AND seq > ?2 ORDER BY seq ASC",
        )
        .map_err(failed("prepare the update read"))?;
    let rows = statement
        .query_map(params![namespace.row_id(doc_id), after_seq], |row| {
            Ok(UpdateRow {
                seq: row.get(0)?,
                update_blob: row.get(1)?,
                created_at: row.get(2)?,
            })
        })
        .map_err(failed("read updates"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed("read an update row"))?;
    Ok(rows)
}

/// The snapshot row of one namespace, if the document has one.
pub fn snapshot(
    conn: &Connection,
    namespace: Namespace,
    doc_id: &str,
) -> Result<Option<SnapshotRow>, CrdtError> {
    conn.query_row(
        "SELECT snapshot, last_seq, server_revision, compacted_at FROM yjs_snapshots
         WHERE doc_id = ?1",
        params![namespace.row_id(doc_id)],
        |row| {
            Ok(SnapshotRow {
                snapshot: row.get(0)?,
                last_seq: row.get(1)?,
                server_revision: row.get(2)?,
                compacted_at: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(failed("read a snapshot"))
    .map_err(CrdtError::from)
}

/// Stores the snapshot the server answered with, at the sequence the server
/// gave it and under the server's opaque `revision` token.
///
/// The revision is compared for equality and for nothing else (chapter 07
/// §7.5).
pub fn put_server_snapshot(
    conn: &Connection,
    doc_id: &str,
    snapshot_bytes: &[u8],
    server_sequence_num: i64,
    revision: Option<&str>,
    compacted_at: i64,
) -> Result<(), CrdtError> {
    conn.execute(
        "INSERT INTO yjs_snapshots (doc_id, snapshot, last_seq, server_revision, compacted_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(doc_id) DO UPDATE SET
           snapshot = excluded.snapshot,
           last_seq = excluded.last_seq,
           server_revision = excluded.server_revision,
           compacted_at = excluded.compacted_at",
        params![
            Namespace::Server.row_id(doc_id),
            snapshot_bytes,
            server_sequence_num,
            revision,
            compacted_at
        ],
    )
    .map_err(failed("store a server snapshot"))?;
    Ok(())
}

/// Folds the local namespace: stores `snapshot_bytes` at the highest local
/// sequence **read inside this transaction** and deletes every local update at
/// or below it.
///
/// `server_revision` stays NULL. The local namespace has no server token and an
/// invented one can collide with a real one (chapter 07 §7.13.4).
///
/// Returns the fold point.
pub fn fold_local(
    conn: &mut Connection,
    doc_id: &str,
    snapshot_bytes: &[u8],
    compacted_at: i64,
) -> Result<i64, CrdtError> {
    let txn = conn
        .transaction()
        .map_err(failed("open the fold transaction"))?;
    let row_id = Namespace::Local.row_id(doc_id);

    // Read inside the transaction. A count passed in by the caller is not a
    // sequence and prunes nothing after the first fold.
    let fold_at = next_local_seq(&txn, &row_id)? - 1;

    txn.execute(
        "INSERT INTO yjs_snapshots (doc_id, snapshot, last_seq, server_revision, compacted_at)
         VALUES (?1, ?2, ?3, NULL, ?4)
         ON CONFLICT(doc_id) DO UPDATE SET
           snapshot = excluded.snapshot,
           last_seq = excluded.last_seq,
           server_revision = NULL,
           compacted_at = excluded.compacted_at",
        params![row_id, snapshot_bytes, fold_at, compacted_at],
    )
    .map_err(failed("store the local snapshot"))?;
    txn.execute(
        "DELETE FROM yjs_updates WHERE doc_id = ?1 AND seq <= ?2",
        params![row_id, fold_at],
    )
    .map_err(failed("prune folded updates"))?;
    txn.commit().map_err(failed("commit the fold"))?;
    Ok(fold_at)
}

/// Everything a loader must apply, in order, to bring a document up to date.
///
/// Each half starts at its own snapshot's fold point, which is why an
/// updates-only read is wrong: the rows below the fold no longer exist.
pub fn load_plan(conn: &Connection, doc_id: &str) -> Result<LoadPlan, CrdtError> {
    let server_snapshot = snapshot(conn, Namespace::Server, doc_id)?;
    let local_snapshot = snapshot(conn, Namespace::Local, doc_id)?;
    Ok(LoadPlan {
        server_updates: updates_after(
            conn,
            Namespace::Server,
            doc_id,
            server_snapshot.as_ref().map_or(0, |row| row.last_seq),
        )?,
        local_updates: updates_after(
            conn,
            Namespace::Local,
            doc_id,
            local_snapshot.as_ref().map_or(0, |row| row.last_seq),
        )?,
        server_snapshot,
        local_snapshot,
    })
}

/// Removes both namespaces for a document.
///
/// What a tombstone requires: on applying one, the local Y.Doc and the local
/// update log go (chapter 07 §7.15). The server keeps its rows and that is not
/// evidence the delete failed.
pub fn purge(conn: &mut Connection, doc_id: &str) -> Result<(), CrdtError> {
    let txn = conn
        .transaction()
        .map_err(failed("open the purge transaction"))?;
    purge_in(&txn, doc_id)?;
    txn.commit().map_err(failed("commit the purge"))?;
    Ok(())
}

/// The purge's statements, inside a transaction the **caller** already holds.
///
/// [`purge`] is this plus a transaction of its own. The split is what lets the
/// one production caller — `sync::apply`'s tombstone arm — take the record
/// delete, the projection delete and this purge as a single atomic step. Three
/// separate transactions would let a crash between them leave a deleted note
/// with a live body, which is the state §7.15 exists to forbid.
///
/// Returns the number of rows removed, so a caller can tell a document that had
/// a body from one that never did. **Zero is not a failure**: a delete for an id
/// this device only ever saw metadata for legitimately removes nothing.
pub fn purge_in(conn: &Connection, doc_id: &str) -> Result<usize, CrdtError> {
    let mut removed = 0;
    for row_id in [
        Namespace::Server.row_id(doc_id),
        Namespace::Local.row_id(doc_id),
    ] {
        removed += conn
            .execute("DELETE FROM yjs_updates WHERE doc_id = ?1", params![row_id])
            .map_err(failed("purge updates"))?;
        removed += conn
            .execute(
                "DELETE FROM yjs_snapshots WHERE doc_id = ?1",
                params![row_id],
            )
            .map_err(failed("purge a snapshot"))?;
    }
    // The document's body cursor goes with its log. Kept, it would make a
    // later pull of a revived document ask only for what came after it, and
    // the history the server still holds would never come back to this
    // device (spec 005-journal JP092). Not counted in `removed`: a cursor is
    // not body.
    conn.execute(
        "DELETE FROM sync_cursors WHERE scope = 'crdt:' || ?1",
        params![doc_id],
    )
    .map_err(failed("reset the body cursor"))?;
    Ok(removed)
}

fn failed(what: &'static str) -> impl Fn(rusqlite::Error) -> StorageError {
    move |err| StorageError::Failed {
        what: format!("could not {what}: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{Db, open_data, test_support::temp_dir};

    fn db(label: &str) -> (crate::storage::test_support::TempDir, Db) {
        let dir = temp_dir(label);
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        (dir, db)
    }

    #[test]
    fn the_two_namespaces_are_different_rows() {
        assert_eq!(Namespace::Server.row_id("abc123def456"), "abc123def456");
        assert_eq!(
            Namespace::Local.row_id("abc123def456"),
            "local.abc123def456"
        );
        assert_eq!(Namespace::Local.row_id("j2026-04-16"), "local.j2026-04-16");
    }

    #[test]
    fn a_local_append_never_collides_with_a_server_sequence() {
        let (_dir, db) = db("update-log-namespaces");
        db.call_blocking(|conn| {
            // The server numbered three updates for this document.
            for seq in 1..=3 {
                append_server_update(conn, "abc123def456", seq, &[seq as u8], 100).unwrap();
            }
            // A local append takes local sequence 1, not 4, and does not
            // overwrite the server's row 1.
            let first = append_local_update(conn, "abc123def456", b"local-1", 101).unwrap();
            let second = append_local_update(conn, "abc123def456", b"local-2", 102).unwrap();
            assert_eq!((first, second), (1, 2));

            let server = updates_after(conn, Namespace::Server, "abc123def456", 0).unwrap();
            let local = updates_after(conn, Namespace::Local, "abc123def456", 0).unwrap();
            assert_eq!(server.len(), 3);
            assert_eq!(server[0].update_blob, vec![1u8]);
            assert_eq!(local.len(), 2);
            assert_eq!(local[0].update_blob, b"local-1".to_vec());
            Ok(())
        })
        .expect("namespaces");
    }

    #[test]
    fn a_duplicate_server_sequence_is_ignored_not_an_error() {
        let (_dir, db) = db("update-log-duplicate");
        db.call_blocking(|conn| {
            append_server_update(conn, "abc123def456", 7, b"first", 1).unwrap();
            append_server_update(conn, "abc123def456", 7, b"second", 2).unwrap();
            let rows = updates_after(conn, Namespace::Server, "abc123def456", 0).unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].update_blob, b"first".to_vec());
            Ok(())
        })
        .expect("duplicate");
    }

    #[test]
    fn a_fold_prunes_and_the_next_local_sequence_still_moves_forward() {
        let (_dir, db) = db("update-log-fold");
        db.call_blocking(|conn| {
            for n in 0..4 {
                append_local_update(conn, "abc123def456", &[n], 1).unwrap();
            }

            let fold_at = fold_local(conn, "abc123def456", b"snapshot-a", 10).unwrap();
            assert_eq!(fold_at, 4);
            assert!(
                updates_after(conn, Namespace::Local, "abc123def456", 0)
                    .unwrap()
                    .is_empty(),
                "the fold deletes the rows it absorbed"
            );

            // The count of surviving rows is zero; a fold that used a count as
            // a sequence would now hand out 1 again and overwrite history.
            let next = append_local_update(conn, "abc123def456", b"after", 11).unwrap();
            assert_eq!(next, 5);

            // A second fold with nothing new folds at the same point rather
            // than walking backwards.
            let second = fold_local(conn, "abc123def456", b"snapshot-b", 12).unwrap();
            assert_eq!(second, 5);

            let stored = snapshot(conn, Namespace::Local, "abc123def456")
                .unwrap()
                .expect("a local snapshot");
            assert_eq!(stored.snapshot, b"snapshot-b".to_vec());
            assert_eq!(stored.last_seq, 5);
            assert_eq!(
                stored.server_revision, None,
                "the local namespace never invents a revision"
            );
            Ok(())
        })
        .expect("fold");
    }

    #[test]
    fn a_read_since_a_fold_point_consults_the_snapshot() {
        let (_dir, db) = db("update-log-plan");
        db.call_blocking(|conn| {
            put_server_snapshot(conn, "j2026-04-16", b"server-base", 12, Some("rev-1"), 5).unwrap();
            append_server_update(conn, "j2026-04-16", 11, b"already-folded", 6).unwrap();
            append_server_update(conn, "j2026-04-16", 13, b"after-fold", 7).unwrap();
            append_local_update(conn, "j2026-04-16", b"mine", 8).unwrap();

            let plan = load_plan(conn, "j2026-04-16").unwrap();

            assert_eq!(
                plan.server_snapshot.as_ref().map(|row| row.last_seq),
                Some(12)
            );
            assert_eq!(
                plan.server_snapshot
                    .as_ref()
                    .and_then(|row| row.server_revision.clone()),
                Some("rev-1".to_owned())
            );
            assert_eq!(plan.server_updates.len(), 1, "rows at or below the fold");
            assert_eq!(plan.server_updates[0].update_blob, b"after-fold".to_vec());
            assert_eq!(plan.local_updates.len(), 1);

            assert_eq!(
                plan.blobs(),
                vec![
                    b"server-base".as_slice(),
                    b"after-fold".as_slice(),
                    b"mine".as_slice(),
                ],
                "server snapshot, server updates, local snapshot, local updates"
            );
            Ok(())
        })
        .expect("plan");
    }

    #[test]
    fn a_purge_removes_both_namespaces_and_leaves_its_neighbour_alone() {
        let (_dir, db) = db("update-log-purge");
        db.call_blocking(|conn| {
            append_server_update(conn, "abc123def456", 1, b"a", 1).unwrap();
            append_local_update(conn, "abc123def456", b"b", 1).unwrap();
            put_server_snapshot(conn, "abc123def456", b"s", 1, None, 1).unwrap();
            fold_local(conn, "abc123def456", b"l", 1).unwrap();
            append_server_update(conn, "other12345678", 1, b"keep", 1).unwrap();

            purge(conn, "abc123def456").unwrap();

            assert!(load_plan(conn, "abc123def456").unwrap().is_empty());
            assert!(!load_plan(conn, "other12345678").unwrap().is_empty());
            Ok(())
        })
        .expect("purge");
    }
}
