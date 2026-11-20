//! The record manifest reconcile, chapter 08 §8.10 **Closing checks** (#5232).
//!
//! Record packs are a cache and the manifest is the truth. After the packs
//! and the feed tail, one `GET /sync/manifest` (read after the reader holds
//! the pack bytes) decides every item:
//!
//! 1. A listed item is held when the device holds it live at exactly the
//!    manifest's `serverCursor`: the cursor of a pack entry it applied
//!    (`sortKey`). Anything else is pulled by id. An item with no
//!    `serverCursor` matches nothing, and a manifest with none at all means
//!    record packs only seeded, so every item is pulled (fail closed).
//! 2. A live row taken from a pack that the manifest does not list was
//!    deleted on the server. It is pulled by id, so a tombstone the server
//!    still holds arrives with its clock; one the server answers nothing for
//!    (a shed tombstone, §5.12.3) is deleted locally. A row the device
//!    changed locally is kept.
//! 3. Packed tombstones already applied as pulled ones would.
//!
//! The unpaged manifest is one request and one consistent read. The pulls are
//! `ceil(k / 100)` requests for the `k` items the packs did not deliver.

use std::collections::{HashMap, HashSet};

use serde_json::Value as Json;

use crate::storage::nested_tx;

use super::super::apply::{self, Pending};
use super::super::first_sync_store::{HeldRow, forget_cursors, held_rows, read_meta, write_meta};
use super::super::pull::{MAX_PULL_IDS, PullLoop};
use super::{FirstSync, FirstSyncError, FirstSyncPhase, FirstSyncProgress, FirstSyncReport};
use super::{now_ms, sqlite_failed};

/// Set when the reconcile finished, so a resumed first sync does not pull
/// again what it already pulled.
pub const META_FIRST_SYNC_RECONCILED: &str = "first_sync.reconciled";

/// One `GET /sync/manifest` item.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Listed {
    item_type: String,
    item_id: String,
    server_cursor: Option<i64>,
    modified_at: i64,
}

impl FirstSync {
    pub(super) async fn reconcile(
        &self,
        report: &mut FirstSyncReport,
    ) -> Result<(), FirstSyncError> {
        if self
            .db
            .call(|conn| read_meta(conn, META_FIRST_SYNC_RECONCILED))
            .await?
            .is_some()
        {
            return Ok(());
        }
        let request = self.pull.request("GET", "/sync/manifest");
        let body: Json = self
            .pull
            .http()
            .send_json(request)
            .await
            .map_err(|source| FirstSyncError::Pull {
                source: source.into(),
            })?;
        report.reconcile_requests += 1;
        let listed = read_manifest(&body);
        let held = self.db.call(|conn| held_rows(conn)).await?;
        let plan = plan(&listed, &held, &self.pull);

        let total = (plan.pull.len() + plan.stale.len()) as u64;
        let mut done = 0u64;
        let pull_ids = plan.pull.clone();
        self.db
            .call(move |conn| forget_cursors(conn, &pull_ids))
            .await?;
        for chunk in plan.pull.chunks(MAX_PULL_IDS) {
            let page = self.pull.fetch_ids(chunk).await?;
            report.reconcile_requests += 1;
            report.reconcile_pulled += page.applied + page.deleted + page.skipped;
            report.metadata_corrupt += page.corrupt;
            done += chunk.len() as u64;
            self.progress.progress(FirstSyncProgress {
                phase: FirstSyncPhase::Metadata,
                completed: done,
                total,
            });
        }
        for chunk in plan.stale.chunks(MAX_PULL_IDS) {
            let ids: Vec<String> = chunk.iter().map(|row| row.item_id.clone()).collect();
            self.pull.fetch_ids(&ids).await?;
            report.reconcile_requests += 1;
            done += chunk.len() as u64;
            self.progress.progress(FirstSyncProgress {
                phase: FirstSyncPhase::Metadata,
                completed: done,
                total,
            });
        }
        report.reconcile_removed += self.remove_unanswered(plan.stale).await?;
        self.db
            .call(|conn| write_meta(conn, META_FIRST_SYNC_RECONCILED, "1"))
            .await?;
        Ok(())
    }

    /// Rule 2's last step: a stale row the pull left live at the cursor it
    /// had came back with no answer, so the server holds no live item and no
    /// tombstone payload for it. It is deleted here, as an id in `deleted`
    /// with no clock would be (§5.12.1).
    async fn remove_unanswered(&self, stale: Vec<HeldRow>) -> Result<usize, FirstSyncError> {
        if stale.is_empty() {
            return Ok(0);
        }
        let now = now_ms();
        let removed = self
            .db
            .call(move |conn| {
                let still: HashSet<(String, String, Option<i64>)> = held_rows(conn)?
                    .into_iter()
                    .filter(|row| row.held)
                    .map(|row| (row.item_type, row.item_id, row.server_cursor))
                    .collect();
                let gone: Vec<Pending> = stale
                    .into_iter()
                    .filter(|row| {
                        still.contains(&(
                            row.item_type.clone(),
                            row.item_id.clone(),
                            row.server_cursor,
                        ))
                    })
                    .map(|row| Pending::Tombstone {
                        item_type: row.item_type,
                        item_id: row.item_id,
                        deleted_at: now,
                        server_cursor: None,
                        clock: None,
                        body_state_vector: None,
                    })
                    .collect();
                let count = gone.len();
                let txn = nested_tx::begin(conn).map_err(sqlite_failed)?;
                apply::apply_page(&txn, gone, Vec::new(), now, None)?;
                txn.commit().map_err(sqlite_failed)?;
                Ok(count)
            })
            .await?;
        Ok(removed)
    }
}

#[derive(Debug, Default)]
struct Plan {
    /// Ids to pull, newest first.
    pull: Vec<String>,
    /// Pack-held live rows the manifest does not list.
    stale: Vec<HeldRow>,
}

fn plan(listed: &[Listed], held: &[HeldRow], pull: &PullLoop) -> Plan {
    let trusted = listed.iter().any(|item| item.server_cursor.is_some());
    let by_key: HashMap<(&str, &str), &HeldRow> = held
        .iter()
        .map(|row| ((row.item_type.as_str(), row.item_id.as_str()), row))
        .collect();
    let mut wanted: Vec<&Listed> = listed
        .iter()
        .filter(|item| {
            let row = by_key.get(&(item.item_type.as_str(), item.item_id.as_str()));
            let exact = trusted
                && item.server_cursor.is_some()
                && row.is_some_and(|row| row.held && row.server_cursor == item.server_cursor);
            !exact
        })
        .collect();
    wanted.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    let mut seen = HashSet::new();
    let pull_ids: Vec<String> = wanted
        .into_iter()
        .filter(|item| seen.insert(item.item_id.clone()))
        .map(|item| item.item_id.clone())
        .collect();

    let listed_keys: HashSet<(&str, &str)> = listed
        .iter()
        .map(|item| (item.item_type.as_str(), item.item_id.as_str()))
        .collect();
    let stale = held
        .iter()
        .filter(|row| {
            row.held
                && row.server_cursor.is_some()
                && !row.local_change
                && pull.declares(&row.item_type)
                && !listed_keys.contains(&(row.item_type.as_str(), row.item_id.as_str()))
                && !seen.contains(&row.item_id)
        })
        .cloned()
        .collect();
    Plan {
        pull: pull_ids,
        stale,
    }
}

fn read_manifest(body: &Json) -> Vec<Listed> {
    body.get("items")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            Some(Listed {
                item_id: item.get("id").and_then(Json::as_str)?.to_owned(),
                item_type: item.get("type").and_then(Json::as_str)?.to_owned(),
                server_cursor: item.get("serverCursor").and_then(Json::as_i64),
                modified_at: item.get("modifiedAt").and_then(Json::as_i64).unwrap_or(0),
            })
        })
        .collect()
}
