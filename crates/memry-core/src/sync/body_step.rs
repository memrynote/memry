//! The body step of a pass: the per-note pull of every document owed one
//! ([`super::body_debt`]), within a request budget, and never in the way of
//! the push (chapter 07 §7.17.4, #2297).
//!
//! The pull-first rule of chapter 06 §6.5.2 is about records. Bodies are CRDT
//! state and commute, so nothing here may stop the push that follows:
//!
//! - **One document's failure is that document's.** An error answer owes the
//!   document with a backoff and the step goes on to the next one.
//! - **A `429` or a dead network ends the step**, not the pass. Every
//!   document not reached keeps its debt, so the next pass resumes there.
//! - **A budget of [`BODY_REQUEST_BUDGET`] requests per pass**, well under the
//!   server's 600 per minute for CRDT pulls. The documents past it stay owed.
//!   The snapshot-meta probe runs once per [`PROBE_CHUNK`] documents, as
//!   [`BodyPull::pull_documents`] does, and counts against the same budget.
//!
//! Only a local storage failure propagates: the debts themselves could not
//! be kept.
//!
//! The step first runs the one-time [`body_heal`], so an install left with
//! documents that hold no body state pulls them without user action.

use crate::api::errors::{ApiError, StorageError};
use crate::storage::Db;

use super::body_pull::{BodyPull, BodyPullError, BodyPullReport, PROBE_CHUNK, Probed};
use super::{body_debt, body_heal};

/// Requests one pass's body step may send. The first document always runs,
/// so a single large one cannot starve.
pub const BODY_REQUEST_BUDGET: usize = 200;

/// Pulls the documents due this pass and settles or re-owes each one.
pub async fn run(db: &Db, body_pull: &BodyPull) -> Result<BodyPullReport, StorageError> {
    let due = db
        .call(|conn| {
            body_heal::owe_unread_documents(conn)?;
            body_debt::due(conn)
        })
        .await?;
    let mut total = BodyPullReport::default();
    'step: for chunk in due.chunks(PROBE_CHUNK) {
        if total.requests >= BODY_REQUEST_BUDGET {
            break;
        }
        let mut probed = match body_pull.probe(chunk, &mut total.requests).await {
            Ok(probed) => probed,
            Err(BodyPullError::Storage { source }) => return Err(source),
            Err(BodyPullError::Api { .. }) => Default::default(),
        };
        for doc_id in chunk {
            if total.requests >= BODY_REQUEST_BUDGET {
                break 'step;
            }
            if let Step::Ended { .. } =
                pull_one(db, body_pull, doc_id, probed.remove(doc_id), &mut total).await?
            {
                break 'step;
            }
        }
    }
    Ok(total)
}

/// What one owed document's pull did to the step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Step {
    /// The debt is settled: the pull reached the server's head.
    Settled,
    /// The document stays owed, backed off or as it was.
    Owed,
    /// A failure every later request would repeat: the step ends here.
    /// `rate_limit_s` is the wait a `429` asked for, at least a second, and
    /// `None` for any other ending.
    Ended { rate_limit_s: Option<u64> },
}

/// One owed document: settled, re-owed, or backed off.
pub(super) async fn pull_one(
    db: &Db,
    body_pull: &BodyPull,
    doc_id: &str,
    probed: Option<Probed>,
    total: &mut BodyPullReport,
) -> Result<Step, StorageError> {
    let doc = doc_id.to_owned();
    match body_pull.pull_with(doc_id, probed).await {
        Ok(pulled) => {
            // Settled only when the pull reached the server's head and
            // stored everything; a stop is backed off; a pull that only
            // yielded at the page cap made progress and stays owed as is.
            let merged = pulled.merged();
            let stopped = !pulled.stopped.is_empty();
            db.call(move |conn| {
                if merged {
                    body_debt::settle(conn, &doc)
                } else if stopped {
                    body_debt::owe_after_failure(conn, &doc)
                } else {
                    body_debt::owe(conn, &doc)
                }
            })
            .await?;
            total.requests += pulled.requests.max(1);
            total.absorb(BodyPullReport {
                requests: 0,
                ..pulled
            });
            Ok(if merged { Step::Settled } else { Step::Owed })
        }
        Err(BodyPullError::Storage { source }) => Err(source),
        Err(BodyPullError::Api { source }) if ends_the_step(&source) => Ok(Step::Ended {
            // A 429 without `Retry-After` still means "not now"; one second
            // is the server's own floor (`Math.max(retryAfter, 1)`).
            rate_limit_s: match source {
                ApiError::RateLimited { retry_after_s, .. } => {
                    Some(retry_after_s.unwrap_or(1).max(1))
                }
                _ => None,
            },
        }),
        Err(BodyPullError::Api { .. }) => {
            db.call(move |conn| body_debt::owe_after_failure(conn, &doc))
                .await?;
            total.requests += 1;
            Ok(Step::Owed)
        }
    }
}

/// A failure every later request of this pass would repeat: a `429`, no
/// network, or a session the server no longer accepts. The documents keep
/// their debts without a backoff; they did not fail.
pub(super) fn ends_the_step(error: &ApiError) -> bool {
    matches!(
        error,
        ApiError::RateLimited { .. }
            | ApiError::Transport { .. }
            | ApiError::Unauthorized { .. }
            | ApiError::DeviceRevoked { .. }
    )
}
