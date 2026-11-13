//! The pull loop's apply step and its refused-items ledger (#4453).

use super::{PullError, PullLoop, now_ms};
use crate::sync::apply::{self, ApplyTotals, Pending};
use crate::sync::{body_debt, refused_items};

impl PullLoop {
    /// Hands the page to [`apply`], which owns every decision about what an
    /// item's type means. The loop's only remaining job is the clock it is
    /// applied at, on a feed page the body debt of its documents, and the
    /// ledger entry of each record the type's schema refused, under the app
    /// version the host gave this client (chapter 11 §11.1), in the same
    /// writer call as the apply.
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
        let version = self.http.identity().app_version().to_owned();
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
                refused_items::record(conn, &totals.refused, &version, now)?;
                Ok(totals)
            })
            .await?)
    }

    /// Refetches the records another app version refused
    /// ([`refused_items::retryable`]), at the start of a run (the first page), as
    /// desktop's `retrySchemaInvalidItems` does at pull start
    /// (`apps/desktop/src/main/sync/engine/pull-coordinator.ts:182`). Each one
    /// applies (resolved), is refused again (recorded under this version) or,
    /// when the server answered in full without it, is resolved as gone. A
    /// response that is not a pull envelope keeps every entry for the next run.
    pub(super) async fn retry_refused(&self) -> Result<(), PullError> {
        let version = self.http.identity().app_version().to_owned();
        let current = version.clone();
        let ids = self
            .db
            .call(move |conn| refused_items::retryable(conn, &current))
            .await?;
        if ids.is_empty() {
            return Ok(());
        }
        let report = self.fetch_ids(&ids).await?;
        if report.dropped_pages == 0 {
            self.db
                .call(move |conn| refused_items::resolve_unanswered(conn, &ids, &version))
                .await?;
        }
        Ok(())
    }
}
