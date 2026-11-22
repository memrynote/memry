//! The record manifest reconcile, chapter 08 §8.10 **Closing checks** (#5232).
//!
//! Record packs are a cache and the manifest is the truth. After the packs
//! and the feed tail, one `GET /sync/manifest` (read after the reader holds
//! the pack bytes) decides every item:
//!
//! 1. A listed item is held when the device holds it live at exactly the
//!    manifest's `serverCursor`. The cursor a row holds is the cursor of the
//!    write it applied: a pack entry's `sortKey`, or a feed ref's
//!    `serverCursor`. A by-id pull leaves none (`POST /sync/pull` names no
//!    cursor, and an item in `blobMissing` is no write), so that row matches
//!    nothing. Anything else is pulled by id. Each manifest item is checked
//!    on its own: one with no `serverCursor` (a mixed rollout) matches
//!    nothing, and a manifest with none at all means record packs only
//!    seeded, so every item is pulled (fail closed).
//! 2. A live row taken from a pack that the manifest does not list may have
//!    been deleted on the server. It is pulled by id: a tombstone the server
//!    still holds arrives signed with its clock, and one whose payload it shed
//!    (§5.12.3) arrives as a marker to a pull that declares
//!    `purged_tombstones`, which deletes only when its attestation verifies
//!    ([`super::super::hardening::purged`]). A row the pull answers with
//!    nothing, a refused item or no envelope is kept and logged (§5.12.1): an
//!    omission is no evidence of a delete. The delete is local: a pulled
//!    tombstone queues no push.
//! 3. Packed tombstones already applied as pulled ones would.
//!
//! The unpaged manifest is one request and one consistent read. The pulls are
//! `ceil(k / 100)` requests for the `k` items the packs did not deliver.

use std::collections::{HashMap, HashSet};

use serde_json::Value as Json;

use super::super::first_sync_store::{HeldRow, forget_cursors, held_rows, read_meta, write_meta};
use super::super::pull::{MAX_PULL_IDS, PullLoop};
use super::super::store::{self, RECORD_CURSOR_SCOPE};
use super::{FirstSync, FirstSyncError, FirstSyncPhase, FirstSyncProgress, FirstSyncReport};

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
        let forget = plan.forget;
        self.db
            .call(move |conn| forget_cursors(conn, &forget))
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
        let mut dropped_pages = 0;
        for chunk in plan.stale.chunks(MAX_PULL_IDS) {
            let ids: Vec<String> = chunk.iter().map(|row| row.item_id.clone()).collect();
            let page = self.pull.fetch_ids(&ids).await?;
            report.reconcile_requests += 1;
            report.reconcile_removed += page.deleted;
            dropped_pages += page.dropped_pages;
            done += chunk.len() as u64;
            self.progress.progress(FirstSyncProgress {
                phase: FirstSyncPhase::Metadata,
                completed: done,
                total,
            });
        }
        let kept = self.count_unanswered(plan.stale).await?;
        if kept > 0 {
            let cursor = self
                .db
                .call(|conn| store::read_cursor(conn, RECORD_CURSOR_SCOPE))
                .await?;
            eprintln!(
                "memry-core: first sync reconcile: {kept} stale id(s) at cursor {cursor:?} had no verified delete or attested marker, kept ({dropped_pages} non-envelope answer(s))"
            );
        }
        self.db
            .call(|conn| write_meta(conn, META_FIRST_SYNC_RECONCILED, "1"))
            .await?;
        Ok(())
    }

    /// Rule 2's last step (§5.12.1, #5402): the pull by id already applied
    /// every verified delete and attested marker it returned. A stale row it
    /// left live at the cursor it had got no answer, a refused one, or no
    /// envelope, and an omission is no evidence of a delete: it is kept.
    /// Answers how many, for the log.
    async fn count_unanswered(&self, stale: Vec<HeldRow>) -> Result<usize, FirstSyncError> {
        if stale.is_empty() {
            return Ok(0);
        }
        let held = self.db.call(|conn| held_rows(conn)).await?;
        let still: HashSet<(String, String, Option<i64>)> = held
            .into_iter()
            .filter(|row| row.held)
            .map(|row| (row.item_type, row.item_id, row.server_cursor))
            .collect();
        Ok(stale
            .into_iter()
            .filter(|row| {
                still.contains(&(
                    row.item_type.clone(),
                    row.item_id.clone(),
                    row.server_cursor,
                ))
            })
            .count())
    }
}

#[derive(Debug, Default)]
struct Plan {
    /// Ids to pull, newest first.
    pull: Vec<String>,
    /// The listed `(type, id)` items behind `pull`.
    forget: Vec<(String, String)>,
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
    wanted.sort_by_key(|item| std::cmp::Reverse(item.modified_at));
    let forget = wanted
        .iter()
        .map(|item| (item.item_type.clone(), item.item_id.clone()))
        .collect();
    let mut seen = HashSet::new();
    let pull_ids: Vec<String> = wanted
        .into_iter()
        .filter(|item| seen.insert(item.item_id.as_str()))
        .map(|item| item.item_id.clone())
        .collect();

    let listed_keys: HashSet<(&str, &str)> = listed
        .iter()
        .map(|item| (item.item_type.as_str(), item.item_id.as_str()))
        .collect();
    // Keyed on (type, id): a listed item of another type that shares the id
    // does not stand for this row.
    let stale = held
        .iter()
        .filter(|row| {
            row.held
                && row.server_cursor.is_some()
                && !row.local_change
                && pull.declares(&row.item_type)
                && !listed_keys.contains(&(row.item_type.as_str(), row.item_id.as_str()))
        })
        .cloned()
        .collect();
    Plan {
        pull: pull_ids,
        forget,
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
