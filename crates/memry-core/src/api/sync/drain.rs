//! The foreground drain on the FFI (#5233): one round of
//! [`crate::sync::body_drain`] per call.

use std::sync::Arc;

use tokio::time::Instant;

use super::{ForeignProgress, SyncProgressListener, VaultSync, count, now_ms, pass};
use crate::api::diagnostics::run_diagnostics;
use crate::api::errors::SyncError;
use crate::protocol::types::Declaration;
use crate::seams::diagnostics::{CoreDiagnostic, DiagnosticPhase};
use crate::sync::body_drain;
use crate::sync::body_pull::BodyPull;
use crate::sync::bootstrap::BootstrapClient;
use crate::sync::first_sync::{
    BODY_CONCURRENCY_ELEVATED, BODY_CONCURRENCY_STEADY, ProgressSink, SilentProgress,
};

/// What one drain round did.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct BodyDrainSummary {
    /// Documents pulled this round, settled or not.
    pub documents: u32,
    pub requests: u32,
    /// Live documents still owed a body. Some may be backing off after a
    /// failure, so a round that pulled nothing tells the shell to wait and ask
    /// again even when this is above 0.
    pub remaining: u32,
    /// Whether a bootstrap session widened the round (chapter 10 §10.7).
    pub elevated: bool,
}

#[uniffi::export(async_runtime = "tokio")]
impl VaultSync {
    /// One round of the foreground drain: pulls up to
    /// [`body_drain::DRAIN_ROUND_DOCUMENTS`] of the bodies still owed, then
    /// returns. A shell calls it again while it is in the foreground, the
    /// last round pulled something, and `remaining` is above 0.
    ///
    /// Bounded so a write's [`Self::sync_now`] waits for at most one round:
    /// rounds and passes take the same pass gate. A round with nothing due
    /// makes no request, and so does a round before the `Retry-After` of a
    /// `429` the last one met, whether it ended that round or only answered
    /// its probe or bootstrap open, or one the first sync's bodies pass gave
    /// up on: it pulls nothing. The shell then waits a few seconds and asks
    /// again, and pauses its drain until the next foreground only once the
    /// rounds have pulled nothing for longer than the longest `429` hold.
    /// It opens a bootstrap session
    /// for the round and pulls four documents at a time when the server
    /// grants one (a device's first day, §10.9), one at a time otherwise.
    ///
    /// `progress` gets `Bodies` ticks in live documents of the vault, so a
    /// shell continues the first sync's bar where it stopped.
    pub async fn drain_bodies(
        &self,
        progress: Option<Arc<dyn SyncProgressListener>>,
    ) -> Result<BodyDrainSummary, SyncError> {
        let gate = pass::pass_gate(&self.vault_id);
        let _held = gate.lock().await;
        let resume_at = *self.drain_resume_at();
        let due = body_drain::take_due(&self.db).await?;
        if due.is_empty() || resume_at.is_some_and(|at| Instant::now() < at) {
            return Ok(BodyDrainSummary {
                documents: 0,
                requests: 0,
                remaining: count(body_drain::remaining(&self.db).await?),
                elevated: false,
            });
        }

        let cipher = self.cipher().await?;
        let http = self.session.http();
        let diagnostics = run_diagnostics();
        let bootstrap = Arc::new(
            BootstrapClient::new(Arc::clone(&http))
                .with_vault(&self.vault_id)
                .with_diagnostics(Arc::clone(&diagnostics)),
        );
        let _close = bootstrap.close_on_drop();
        let opened = bootstrap.open(now_ms() / 1_000).await;
        // A 429 on the open holds back the next round, whose open would meet
        // it again; this one still runs, at one stream.
        let open_resume_at = opened.rate_limit_s.map(body_drain::resume_after);
        let elevated = opened.elevated();
        let bodies = Arc::new(
            BodyPull::new(
                diagnostics.observe(&http),
                self.db.clone(),
                Declaration::subscribed(),
                cipher,
            )
            .with_vault(&self.vault_id)
            .with_bootstrap(Arc::clone(&bootstrap)),
        );
        let workers = if elevated {
            BODY_CONCURRENCY_ELEVATED
        } else {
            BODY_CONCURRENCY_STEADY
        };
        let sink: Arc<dyn ProgressSink> = match progress {
            Some(listener) => Arc::new(ForeignProgress(listener)),
            None => Arc::new(SilentProgress),
        };
        diagnostics.emit(CoreDiagnostic::BodyPassStarted {
            elevated,
            concurrency: count(workers.min(due.len())),
            documents: count(due.len()),
            up_to_date: None,
        });
        let round = diagnostics
            .phase(
                DiagnosticPhase::DrainBodies,
                body_drain::run(&self.db, &bodies, due, workers, sink),
            )
            .await;
        bootstrap.close().await;
        let round = round?;
        *self.drain_resume_at() = round.resume_at.max(open_resume_at);
        Ok(BodyDrainSummary {
            documents: count(round.documents),
            // The open is a request too, and so is the close of a granted one.
            requests: count(round.requests + 1 + usize::from(elevated)),
            remaining: count(round.remaining),
            elevated,
        })
    }
}

impl VaultSync {
    /// Holds the drain back after a `429` that asked for `wait_s`, met
    /// outside a round: by the first sync's bodies pass, which gave up on it.
    pub(super) fn hold_drain_back(&self, wait_s: u64) {
        let resume_at = body_drain::resume_after(wait_s);
        let mut held = self.drain_resume_at();
        *held = (*held).max(Some(resume_at));
    }

    fn drain_resume_at(&self) -> std::sync::MutexGuard<'_, Option<Instant>> {
        self.drain_resume_at
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}
