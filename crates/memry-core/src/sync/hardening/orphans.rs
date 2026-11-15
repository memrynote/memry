//! Orphan repair, Electron's `repairOrphans`
//! (`apps/desktop/src/main/sync/engine/orphan-repair.ts:48-64`): a child
//! record whose parent is gone.
//!
//! Three children name a parent: a task its project (`task-handler.ts:41`),
//! an external calendar event its source
//! (`calendar-external-event-handler.ts:56`), and an agent message its
//! conversation (`agent-message-handler.ts:72-120`). Electron's tables bind
//! them (by a foreign key, or by hand for the message), so a child that lands
//! before its parent is deferred, and a child whose parent was deleted, by a
//! cascade sync never saw, is re-pulled on every manifest check for ever
//! (#837). This core stores the child as it comes, so nothing loops; what is
//! left is the outcome:
//!
//! - **A parent this device never held is fetched by id.** Once per parent
//!   per pull loop: one that the server does not serve (Electron's default
//!   `inbox` project, never a record) stays absent, and its children stay.
//! - **A child whose parent is a tombstone here is tombstoned**, and the
//!   delete pushed, which is what the cascade should have pushed. The children
//!   are fetched again first, so a move a peer pushed with the parent's delete
//!   (this core's project delete moves its tasks to the inbox) lands before
//!   the check, and a child with a local change queued is left to that change.
//!
//! **More conservative than Electron, on purpose:** Electron also takes a
//! parent the server did not return as gone (`orphan-repair.ts:96-103`). Here
//! only a tombstone is: absence carries no clock (chapter 05 §5.12.3, last
//! rule), and a parent that is only absent leaves its children in place.
//!
//! The repair runs at the end of a hardened pull run that reached the head of
//! the feed and applied something, so every delete and move pushed before it
//! has landed.

use std::collections::BTreeSet;
use std::sync::Mutex;

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::domain::notes::tombstone_local;
use crate::domain::{agent_message, tasks};
use crate::sync::outbox::{self, Change};
use crate::sync::pull::{PullError, PullLoop};

/// `(child type, payload key naming the parent, parent type)`.
pub const LINKS: [(&str, &str, &str); 3] = [
    ("task", "projectId", "project"),
    ("calendar_external_event", "sourceId", "calendar_source"),
    ("agent_message", "conversationId", "agent_conversation"),
];

/// What a repair did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct OrphanOutcome {
    /// Parents fetched by id because no row of them was held.
    pub fetched_parents: Vec<String>,
    /// Children tombstoned because their parent is.
    pub tombstoned: Vec<(String, String)>,
}

/// The parents already fetched by one pull loop, so an absent one costs one
/// request per loop, not one per run.
#[derive(Debug, Default)]
pub struct OrphanRepair {
    fetched: Mutex<BTreeSet<String>>,
}

/// One live child and the parent its payload names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Link {
    pub child_type: String,
    pub child_id: String,
    pub parent_id: String,
}

/// Where a parent stands here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Parent {
    Absent,
    Tombstoned,
}

impl OrphanRepair {
    pub async fn run(&self, pull: &PullLoop) -> Result<OrphanOutcome, PullError> {
        let mut outcome = OrphanOutcome::default();
        let absent: Vec<String> = {
            let found = pull.db().call(|conn| links(conn, Parent::Absent)).await?;
            let fresh: BTreeSet<String> = found
                .into_iter()
                .map(|link| link.parent_id)
                .filter(|id| !self.fetched_lock().contains(id))
                .collect();
            fresh.into_iter().collect()
        };
        if !absent.is_empty() {
            pull.fetch_ids(&absent).await?;
            self.fetched_lock().extend(absent.iter().cloned());
            outcome.fetched_parents = absent;
        }

        let orphaned = pull
            .db()
            .call(|conn| links(conn, Parent::Tombstoned))
            .await?;
        if orphaned.is_empty() {
            return Ok(outcome);
        }
        let Some(device_id) = pull.clock_device().map(str::to_owned) else {
            eprintln!(
                "memry-core: {} orphaned record(s) kept: no device id to tombstone them under",
                orphaned.len()
            );
            return Ok(outcome);
        };
        let children: Vec<String> = orphaned.iter().map(|link| link.child_id.clone()).collect();
        pull.fetch_ids(&children).await?;
        outcome.tombstoned = pull
            .db()
            .call(move |conn| tombstone_orphans(conn, &device_id, super::super::pull::now_ms()))
            .await?;
        Ok(outcome)
    }
}

impl OrphanRepair {
    fn fetched_lock(&self) -> std::sync::MutexGuard<'_, BTreeSet<String>> {
        self.fetched
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Every live, fully stored child whose parent is in `state` here.
pub(crate) fn links(conn: &Connection, state: Parent) -> Result<Vec<Link>, StorageError> {
    let parent_row = match state {
        Parent::Absent => {
            "NOT EXISTS (SELECT 1 FROM sync_items p
                             WHERE p.item_type = ?3 AND p.item_id = parent)"
        }
        Parent::Tombstoned => {
            "EXISTS (SELECT 1 FROM sync_items p
                                WHERE p.item_type = ?3 AND p.item_id = parent
                                  AND p.deleted_at IS NOT NULL)"
        }
    };
    let mut found = Vec::new();
    for (child_type, key, parent_type) in LINKS {
        // `CASE`, not `AND`: SQLite does not promise to test `json_valid`
        // first, and `json_extract` of a sealed or broken payload throws.
        let sql = format!(
            "SELECT item_id, parent FROM (
               SELECT item_id,
                      CASE WHEN json_valid(payload) THEN json_extract(payload, ?2) END AS parent
                 FROM sync_items
                WHERE item_type = ?1 AND deleted_at IS NULL AND payload IS NOT NULL)
              WHERE typeof(parent) = 'text' AND parent <> '' AND {parent_row}
              ORDER BY item_id"
        );
        let mut statement = conn.prepare(&sql).map_err(failed)?;
        let rows = statement
            .query_map(
                params![child_type, format!("$.{key}"), parent_type],
                |row| {
                    Ok(Link {
                        child_type: child_type.to_owned(),
                        child_id: row.get(0)?,
                        parent_id: row.get(1)?,
                    })
                },
            )
            .map_err(failed)?;
        for row in rows {
            found.push(row.map_err(failed)?);
        }
    }
    Ok(found)
}

/// Tombstones each live child of a tombstoned parent that has no change
/// queued, through its type's delete, so the delete is clocked past the
/// child and queued in the same transaction (`withIncrementedClock`,
/// `orphan-repair.ts:204`).
pub(crate) fn tombstone_orphans(
    conn: &Connection,
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<(String, String)>, StorageError> {
    let mut tombstoned = Vec::new();
    for link in links(conn, Parent::Tombstoned)? {
        let queued: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM outbox WHERE item_type = ?1 AND item_id = ?2)",
                params![link.child_type, link.child_id],
                |row| row.get(0),
            )
            .map_err(failed)?;
        if queued {
            continue;
        }
        let (child_type, id) = (link.child_type.as_str(), link.child_id.as_str());
        match child_type {
            "task" => tasks::delete(conn, id, device_id, now_ms)?.acknowledge(),
            "agent_message" => {
                agent_message::delete(conn, id, device_id, now_ms)?;
            }
            _ => outbox::commit(conn, &Change::delete(child_type, id), now_ms, |tx| {
                tombstone_local(tx, child_type, id, device_id, now_ms)
            })?
            .acknowledge(),
        }
        eprintln!("memry-core: tombstoning a {child_type} whose parent is deleted");
        tombstoned.push((link.child_type, link.child_id));
    }
    Ok(tombstoned)
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
