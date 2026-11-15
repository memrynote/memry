//! The pull loop's apply step and its refused-items ledger (#4453).

use std::collections::BTreeSet;

use serde_json::Value as Json;

use super::items::field;
use super::{MAX_PULL_IDS, PullError, PullLoop, now_ms};
use crate::sync::apply::{self, ApplyTotals, Pending};
use crate::sync::body_debt;
use crate::sync::driver::observer::AppliedFeed;
use crate::sync::hardening::{corrupt, quarantine};
use crate::sync::refused_items::{self, CORE_BUILD};

impl PullLoop {
    /// Hands the page to [`apply`], which owns every decision about what an
    /// item's type means. The loop's only remaining job is the clock it is
    /// applied at, on a feed page the body debt of its documents, and the
    /// ledger entry of each record the type's schema refused, under this core
    /// build ([`CORE_BUILD`]), in the same writer call as the apply.
    ///
    /// The debt is written **before** the apply (#2294): a page re-pulled
    /// after a crash skips its identical records (chapter 06 §6.5.2 P4), so a
    /// debt written after them would be lost with the crash. A debt this page
    /// created for a record it then skipped is taken back; one an earlier
    /// page left is kept.
    pub(super) async fn apply_all(
        &self,
        pending: Vec<Pending>,
        untyped: Vec<String>,
        owe_bodies: bool,
        feed: &mut AppliedFeed,
    ) -> Result<ApplyTotals, PullError> {
        let now = now_ms();
        let clock_device = self.clock_device.clone();
        let at_rest = self.at_rest.clone();
        let (mut totals, applied) = self
            .db
            .call(move |conn| {
                let mut totals = ApplyTotals::default();
                let applied = (|| {
                    let owed_here = if owe_bodies {
                        body_debt::owe_page(conn, &pending)?
                    } else {
                        Vec::new()
                    };
                    apply::apply_page_into(
                        conn,
                        pending,
                        untyped,
                        now,
                        clock_device.as_deref(),
                        &at_rest,
                        &mut totals,
                    )?;
                    for doc_id in &owed_here {
                        if !totals.applied_documents.contains(doc_id) {
                            body_debt::settle(conn, doc_id)?;
                        }
                    }
                    refused_items::record(conn, &totals.refused, CORE_BUILD, now)
                })();
                Ok((totals, applied))
            })
            .await?;
        // What committed before a failure is the caller's to tell (#3534).
        let committed = std::mem::take(&mut totals.feed);
        feed.records.extend(committed.records);
        feed.revived_notes.extend(committed.revived_notes);
        feed.downloads.extend(committed.downloads);
        applied?;
        Ok(totals)
    }

    /// Tells the observers what an apply committed
    /// ([`crate::sync::driver::observer::Observers::applied`]).
    /// Called after the commit, never inside it: an observer reads the row.
    pub(super) async fn tell(&self, feed: AppliedFeed) {
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
        let mut warnings = Vec::new();
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
                            warnings.extend(self.record_corrupt(&item, &failure).await?);
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
        // The warnings already counted reach the observers on every exit.
        if !matches!(fetched, Ok(true)) {
            self.warn(warnings).await;
            return fetched.map(drop);
        }
        pending.sort_by_key(|item| apply::apply_rank(item.item_type()));
        let mut feed = AppliedFeed::default();
        let applied = self
            .apply_all(pending, Vec::new(), self.bodies.is_some(), &mut feed)
            .await;
        self.tell(feed).await;
        self.warn(warnings).await;
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
