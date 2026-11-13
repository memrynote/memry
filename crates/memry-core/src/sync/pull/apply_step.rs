//! The pull loop's apply step and its refused-items ledger (#4453).

use std::collections::BTreeSet;

use serde_json::Value as Json;

use super::{MAX_PULL_IDS, PullError, PullLoop, now_ms};
use crate::sync::apply::{self, ApplyTotals, Pending};
use crate::sync::body_debt;
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
    ) -> Result<ApplyTotals, PullError> {
        let now = now_ms();
        let clock_device = self.clock_device.clone();
        Ok(self
            .db
            .call(move |conn| {
                let owed_here = if owe_bodies {
                    body_debt::owe_page(conn, &pending)?
                } else {
                    Vec::new()
                };
                let totals =
                    apply::apply_page(conn, pending, untyped, now, clock_device.as_deref())?;
                for doc_id in &owed_here {
                    if !totals.applied_documents.contains(doc_id) {
                        body_debt::settle(conn, doc_id)?;
                    }
                }
                refused_items::record(conn, &totals.refused, CORE_BUILD, now)?;
                Ok(totals)
            })
            .await?)
    }

    /// Refetches the records another core build refused
    /// ([`refused_items::take_retryable`]) at the start of a run, as desktop's
    /// `retrySchemaInvalidItems` does at pull start
    /// (`apps/desktop/src/main/sync/engine/pull-coordinator.ts:182`). A failure
    /// is logged and the run goes on to the feed, as desktop's does
    /// (`corrupt-item-tracker.ts:291-297`): the entries stay, retried after
    /// the cooldown, and the outbox still pushes.
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
    async fn refetch_refused(&self) -> Result<(), PullError> {
        let requested: BTreeSet<(String, String)> = self
            .db
            .call(|conn| refused_items::take_retryable(conn, CORE_BUILD, now_ms()))
            .await?
            .into_iter()
            .collect();
        let ids: Vec<String> = requested
            .iter()
            .map(|(_, id)| id.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let mut answered = BTreeSet::new();
        let mut pending = Vec::new();
        for chunk in ids.chunks(MAX_PULL_IDS) {
            let body = self.fetch_bodies(chunk).await?;
            let Some(items) = body.get("items").and_then(Json::as_array) else {
                eprintln!("memry-core: a refused-records refetch got no pull envelope");
                return Ok(());
            };
            for item in items {
                let key = (field(item, "type"), field(item, "id"));
                if !requested.contains(&key) {
                    continue;
                }
                match self.decode(item) {
                    Ok(decoded) => pending.push(decoded),
                    Err(reason) => eprintln!(
                        "memry-core: refused {} {} still does not decode: {reason}",
                        key.0, key.1
                    ),
                }
                answered.insert(key);
            }
        }
        pending.sort_by_key(|item| apply::apply_rank(item.item_type()));
        self.apply_all(pending, Vec::new(), self.bodies.is_some())
            .await?;
        let gone: Vec<(String, String)> = requested.difference(&answered).cloned().collect();
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

fn field(item: &Json, key: &str) -> String {
    item.get(key)
        .and_then(Json::as_str)
        .unwrap_or_default()
        .to_owned()
}
