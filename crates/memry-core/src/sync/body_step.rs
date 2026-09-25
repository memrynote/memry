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

use crate::api::errors::{ApiError, StorageError};
use crate::storage::Db;

use super::body_debt;
use super::body_pull::{BodyPull, BodyPullError, BodyPullReport, PROBE_CHUNK};
use super::crdt_wire::SnapshotMeta;

/// Requests one pass's body step may send. The first document always runs,
/// so a single large one cannot starve.
pub const BODY_REQUEST_BUDGET: usize = 200;

/// Pulls the documents due this pass and settles or re-owes each one.
pub async fn run(db: &Db, body_pull: &BodyPull) -> Result<BodyPullReport, StorageError> {
    let due = db.call(|conn| body_debt::due(conn)).await?;
    let mut total = BodyPullReport::default();
    'step: for chunk in due.chunks(PROBE_CHUNK) {
        if total.requests >= BODY_REQUEST_BUDGET {
            break;
        }
        let probed = match body_pull
            .probe_snapshot_meta(chunk, &mut total.requests)
            .await
        {
            Ok(probed) => probed,
            Err(BodyPullError::Storage { source }) => return Err(source),
            Err(BodyPullError::Api { .. }) => Default::default(),
        };
        for doc_id in chunk {
            if total.requests >= BODY_REQUEST_BUDGET {
                break 'step;
            }
            if !pull_one(db, body_pull, doc_id, probed.get(doc_id), &mut total).await? {
                break 'step;
            }
        }
    }
    Ok(total)
}

/// One owed document: settled, re-owed, or backed off. `false` ends the step.
async fn pull_one(
    db: &Db,
    body_pull: &BodyPull,
    doc_id: &str,
    probed: Option<&SnapshotMeta>,
    total: &mut BodyPullReport,
) -> Result<bool, StorageError> {
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
        }
        Err(BodyPullError::Storage { source }) => return Err(source),
        Err(BodyPullError::Api { source }) if ends_the_step(&source) => return Ok(false),
        Err(BodyPullError::Api { .. }) => {
            db.call(move |conn| body_debt::owe_after_failure(conn, &doc))
                .await?;
            total.requests += 1;
        }
    }
    Ok(true)
}

/// A failure every later request of this pass would repeat: a `429`, no
/// network, or a session the server no longer accepts. The documents keep
/// their debts without a backoff; they did not fail.
fn ends_the_step(error: &ApiError) -> bool {
    matches!(
        error,
        ApiError::RateLimited { .. }
            | ApiError::Transport { .. }
            | ApiError::Unauthorized { .. }
            | ApiError::DeviceRevoked { .. }
    )
}
