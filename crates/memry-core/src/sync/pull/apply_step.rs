//! The pull loop's apply step and its refused-items ledger (#4453).

use std::collections::BTreeSet;

use serde_json::Value as Json;

use super::items::field;
use super::{MAX_PULL_IDS, PullError, PullLoop, now_ms, still_open};
use crate::api::errors::StorageError;
use crate::storage::nested_tx;
use crate::sync::apply::{self, ApplyTotals, Pending};
use crate::sync::body_debt;
use crate::sync::driver::observer::{AppliedFeed, AppliedOutcome, AppliedRecord};
use crate::sync::hardening::{corrupt, quarantine};
use crate::sync::note_body_feed::{self, FetchedBodies};
use crate::sync::refused_items::{self, CORE_BUILD};
use crate::sync::unknown_signer;

impl PullLoop {
    /// Hands the page to [`apply`], which owns every decision about what an
    /// item's type means. The loop's only remaining job is the clock it is
    /// applied at, on a feed page the body debt of its documents, and the
    /// ledger entry of each record the type's schema refused, under this core
    /// build ([`CORE_BUILD`]), in the same writer call as the apply.
    ///
    /// Invariant (§5.11, #5231): the page's applied records and, on a feed
    /// page, its bodies and cursor (`advance`) commit in one transaction or
    /// not at all. `feed` learns the records only once that transaction
    /// committed: a failure leaves nothing for an observer to read.
    ///
    /// The debt is written **before** the apply (#2294): a page re-pulled
    /// after a crash skips its identical records (chapter 06 §6.5.2 P4), so a
    /// debt written after them would be lost with the crash. A debt this page
    /// created for a record it then skipped is taken back; one an earlier
    /// page left is kept.
    pub(super) async fn apply_all(
        &self,
        pending: Vec<Pending>,
        owe_bodies: bool,
        advance: Option<Advance>,
        feed: &mut AppliedFeed,
    ) -> Result<(ApplyTotals, Vec<String>), PullError> {
        let clock_device = self.clock_device.clone();
        let vault_root = self.vault_root.clone();
        let at_rest = self.at_rest.clone();
        let (mut totals, advanced) = self
            .db
            .call(move |conn| {
                // #5849: stamped inside the hold that writes the rows, so no
                // search watermark written while this page waited for the
                // lock can pass them.
                let now = now_ms();
                let txn = nested_tx::begin(conn).map_err(sqlite_failed)?;
                let mut totals = ApplyTotals::default();
                unknown_signer::resolve_verified(&txn, &pending)?;
                let owed_here = if owe_bodies {
                    body_debt::owe_page(&txn, &pending)?
                } else {
                    Vec::new()
                };
                apply::apply_page_into(
                    &txn,
                    pending,
                    now,
                    clock_device.as_deref(),
                    vault_root.as_deref(),
                    &at_rest,
                    &mut totals,
                )?;
                for doc_id in &owed_here {
                    if !totals.applied_documents.contains(doc_id) {
                        body_debt::settle(&txn, doc_id)?;
                    }
                }
                refused_items::record(&txn, &totals.refused, CORE_BUILD, now)?;
                still_open(&txn)?;
                let advanced = match advance {
                    Some(advance) => {
                        // Stamped under the writer, as `body_pull::store_update` says why.
                        let advanced = note_body_feed::land_and_advance(
                            &txn,
                            advance.bodies,
                            advance.cursor.as_deref(),
                            advance.at_head,
                            now_ms(),
                        )?;
                        still_open(&txn)?;
                        advanced
                    }
                    None => Vec::new(),
                };
                txn.commit().map_err(sqlite_failed)?;
                Ok((totals, advanced))
            })
            .await?;
        let committed = std::mem::take(&mut totals.feed);
        feed.records.extend(committed.records);
        feed.revived_notes.extend(committed.revived_notes);
        feed.downloads.extend(committed.downloads);
        Ok((totals, advanced))
    }

    /// Tells the observers what an apply committed
    /// ([`crate::sync::driver::observer::Observers::applied`]).
    /// Called after the commit, never inside it: an observer reads the row.
    pub(crate) async fn tell(&self, feed: AppliedFeed) {
        if let Some(observers) = &self.observers {
            observers.applied(feed).await;
        }
    }

    /// Refetches the records another core build refused
    /// ([`refused_items::take_retryable`]) at the start of a run, as desktop's
    /// `retrySchemaInvalidItems` does at pull start
    /// (`apps/desktop/src/main/sync/engine/pull-coordinator.ts:182`), and in
    /// a hardened pull the rows marked corrupt an hour ago or more
    /// ([`corrupt::take_retryable`]). A failure is logged and the run goes on
    /// to the feed, as desktop's does (`corrupt-item-tracker.ts:291-297`):
    /// the entries stay, retried after the cooldown, and the outbox still
    /// pushes.
    pub(super) async fn retry_refused(&self) {
        if let Err(error) = self.refetch_refused().await {
            eprintln!("memry-core: refetching refused records failed, they stay ledgered: {error}");
        }
    }

    /// Each requested `(type, id)` the server returned is applied: resolved
    /// when it applies, expires or its clock decides it, recorded under this
    /// build when it is refused again, and kept, under its old build and the
    /// retry cooldown, when it does not decode or applies corrupt. One the
    /// server answered in full without is resolved as gone (desktop's
    /// `missing`). A response that is not a pull envelope, or a failed
    /// request, keeps every entry under the cooldown. Other types under a
    /// requested id are not read (`corrupt-item-tracker.ts:216-223`).
    ///
    /// A corrupt row that does not decode again is recorded corrupt again,
    /// and quarantined on a bad signature ([`PullLoop::record_corrupt`]); one
    /// the server no longer returns stays corrupt, retried after the cooldown.
    async fn refetch_refused(&self) -> Result<(), PullError> {
        let hardened = self.hardened;
        let (refused, corrupt) = self
            .db
            .call(move |conn| {
                let now = now_ms();
                let mut refused: BTreeSet<_> =
                    refused_items::take_retryable(conn, CORE_BUILD, now)?
                        .into_iter()
                        .collect();
                let corrupt = if hardened {
                    // A permanent quarantine is never re-applied by any path.
                    let blocked = quarantine::blocked(conn, now)?;
                    refused.retain(|key| !blocked.contains(key));
                    corrupt::take_retryable(conn, now)?
                } else {
                    Vec::new()
                };
                Ok::<_, crate::api::errors::StorageError>((
                    refused,
                    corrupt.into_iter().collect::<BTreeSet<_>>(),
                ))
            })
            .await?;
        let requested: BTreeSet<(String, String)> = refused.union(&corrupt).cloned().collect();
        let ids: Vec<String> = requested
            .iter()
            .map(|(_, id)| id.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let mut answered = BTreeSet::new();
        let mut pending = Vec::new();
        let mut marked = Vec::new();
        let fetched: Result<bool, PullError> = async {
            for chunk in ids.chunks(MAX_PULL_IDS) {
                let mut body = self.fetch_bodies(chunk).await?;
                let Some(items) = Self::pulled_items(&mut body) else {
                    eprintln!("memry-core: a refused-records refetch got no pull envelope");
                    return Ok(false);
                };
                let asked: Vec<Json> = items
                    .into_iter()
                    .filter(|item| requested.contains(&(field(item, "type"), field(item, "id"))))
                    .collect();
                for (item, decoded) in self.decode_batch(asked).await? {
                    let key = (field(&item, "type"), field(&item, "id"));
                    match decoded {
                        Ok(decoded) => pending.push(decoded),
                        // A bad signature counts toward the quarantine
                        // whichever ledger asked for the item.
                        Err(failure)
                            if corrupt.contains(&key)
                                || (self.hardened && failure.signature_invalid) =>
                        {
                            marked.extend(self.record_corrupt(&item, &failure).await?);
                        }
                        Err(failure) => eprintln!(
                            "memry-core: refused {} {} still does not decode: {}",
                            key.0, key.1, failure.reason
                        ),
                    }
                    answered.insert(key);
                }
            }
            Ok(true)
        }
        .await;
        // The marks already written reach the observers on every exit.
        if !matches!(fetched, Ok(true)) {
            self.warn(marked).await;
            return fetched.map(drop);
        }
        pending.sort_by_key(|item| apply::apply_rank(item.item_type()));
        let mut feed = AppliedFeed::default();
        let applied = self
            .apply_all(pending, self.bodies.is_some(), None, &mut feed)
            .await;
        // A corrupt row that applied is recovered (`item-recovery.ts:78`); a
        // skip changed nothing.
        let recovered: Vec<AppliedRecord> = feed
            .records
            .iter()
            .filter(|record| {
                record.outcome != AppliedOutcome::Skipped
                    && corrupt.contains(&(record.item_type.clone(), record.item_id.clone()))
            })
            .cloned()
            .collect();
        self.tell(feed).await;
        self.warn(marked).await;
        if let Some(observers) = &self.observers {
            observers.recovered(recovered).await;
        }
        applied?;
        let gone: Vec<(String, String)> = refused.difference(&answered).cloned().collect();
        self.db
            .call(move |conn| {
                gone.iter().try_for_each(|(item_type, item_id)| {
                    refused_items::resolve(conn, item_type, item_id)
                })
            })
            .await?;
        Ok(())
    }
}

/// What a feed page commits with its records: its bodies and cursor.
pub(super) struct Advance {
    pub bodies: FetchedBodies,
    pub cursor: Option<String>,
    /// Whether the page reached the head of the feed. A refused page at the head is still
    /// the head: the cursor moves past it, so a run from cursor 0 ends there and the next
    /// run's markers apply (§5.12.3).
    pub at_head: bool,
}

fn sqlite_failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
