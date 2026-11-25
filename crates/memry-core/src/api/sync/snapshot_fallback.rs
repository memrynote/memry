//! The snapshot push behind an update too large for the incremental route,
//! chapter 07 §7.4.2.
//!
//! The pass hands the push wave this seam: [`crate::sync::push::PushCoordinator`]
//! decides *that* a batch needs a snapshot, and this decides *whether one may
//! go*. The document is replayed from its durable log, which holds every
//! update the outbox does, so the snapshot covers the rows the wave then acks.
//! The gate is closed unless this pass's pull finished cleanly, because a
//! snapshot is destructive on the server (§7.7).

use std::sync::{Arc, PoisonError, RwLock};

use async_trait::async_trait;

use crate::api::errors::{ApiError, StorageError};
use crate::crdt::epoch::{self, Epoch};
use crate::crdt::errors::CrdtError;
use crate::crdt::registry::{Document, UpdateSink};
use crate::crdt::snapshots::SnapshotError;
use crate::crdt::{Refusal, SnapshotGate, SnapshotOutcome, SnapshotPusher};
use crate::storage::Db;
use crate::sync::admission::CrdtAdmission;
use crate::sync::engine::PullSink;
use crate::sync::pull::PullReport;
use crate::sync::push::{SnapshotFallback, SnapshotFallbackOutcome};

// TODO(#3664): desktop tells the user a note is too large to sync or over
// quota (`emitNoteTooLarge`, `emitQuotaExceeded`,
// `apps/desktop/src/main/sync/runtime.ts:661-671`). The core has no per-note
// sync status to carry either yet, so the reason sits on the deferred outbox
// row's `last_error` ([`crate::crdt::Refusal::TooLarge`]).
pub(crate) struct PassSnapshots {
    pub(crate) pusher: SnapshotPusher,
    pub(crate) db: Db,
    pub(crate) device_id: String,
    /// The pull the snapshot gate reads: this pass's, set before its push
    /// wave (on desktop's driver through [`PullSink`]).
    pub(crate) pull: Arc<RwLock<LastPull>>,
    /// The driver's shared CRDT admission; iOS paces nothing.
    pub(crate) admission: Option<Arc<CrdtAdmission>>,
}

/// §7.13.2 condition 1 as a pull left it.
#[derive(Debug, Clone, Default)]
pub(crate) struct LastPull {
    /// The pull ran to its end with nothing refused, dropped or left undecoded.
    pub(crate) clean: bool,
    pub(crate) purged: Vec<String>,
}

impl LastPull {
    /// What `pull` left; `failed` when it ended in an error.
    pub(crate) fn of(pull: &PullReport, failed: bool) -> Self {
        Self {
            clean: !failed
                && !pull.has_more
                && !pull.refused
                && pull.corrupt == 0
                && pull.dropped_pages == 0,
            purged: pull.purged_documents.clone(),
        }
    }
}

/// Desktop's driver: each pass's pull, before its push wave.
impl PullSink for PassSnapshots {
    fn pulled(&self, pull: &PullReport, failed: bool) {
        *self.pull.write().unwrap_or_else(PoisonError::into_inner) = LastPull::of(pull, failed);
    }
}

impl PassSnapshots {
    /// The gate for `doc_id` from the last pull. False until a pull finished.
    pub(crate) fn gate(&self, doc_id: &str) -> SnapshotGate {
        let pull = self.pull.read().unwrap_or_else(PoisonError::into_inner);
        SnapshotGate {
            pull_completed_clean: pull.clean,
            purged: pull.purged.iter().any(|purged| purged == doc_id),
        }
    }

    /// The document replayed from its durable log with the epoch read before
    /// it loaded (a purge since refuses the push, #5356), or the class of why not.
    pub(crate) async fn replay(
        &self,
        doc_id: &str,
    ) -> Result<Result<(Arc<Document>, Epoch), SnapshotFallbackOutcome>, ApiError> {
        let id = doc_id.to_owned();
        let device_id = self.device_id.clone();
        let opened = self
            .db
            .call(move |conn| {
                // The replay is durable, so the sink sees nothing.
                let sink: UpdateSink = Arc::new(|_, _| {});
                Ok(epoch::capture(conn, &id).and_then(|opened_at| {
                    epoch::open_for_write(conn, &device_id, &id, sink).map(|doc| (doc, opened_at))
                }))
            })
            .await
            .map_err(local)?;
        Ok(match opened {
            Ok(document) => Ok(document),
            Err(error) => Err(crdt_class(
                error,
                "could not replay the document's update log",
            )?),
        })
    }
}

#[async_trait]
impl SnapshotFallback for PassSnapshots {
    async fn push_snapshot(&self, doc_id: &str) -> Result<SnapshotFallbackOutcome, ApiError> {
        let (document, opened_at) = match self.replay(doc_id).await? {
            Ok(opened) => opened,
            Err(outcome) => return Ok(outcome),
        };
        let gate = self.gate(doc_id);
        let _permit = match &self.admission {
            Some(admission) => match admission.admit().await {
                Ok(permit) => Some(permit),
                Err(left) => {
                    return Ok(SnapshotFallbackOutcome::Transient(format!(
                        "crdt pushes are rate limited for {} ms",
                        left.as_millis()
                    )));
                }
            },
            None => None,
        };
        let pushed = self
            .pusher
            .push(
                &document,
                opened_at,
                gate,
                crate::api::tasks_write::now_ms(),
            )
            .await;
        if let (Some(admission), Err(SnapshotError::Api { source })) = (&self.admission, &pushed) {
            admission.note(source);
        }
        classify(pushed)
    }
}

/// The class of every way a snapshot push ends (chapter 07 §7.4.2), and the
/// one place that decides which of them fail the pass. Only these do, and each
/// is a failure of the device or the session rather than of one document:
/// a network error, a 401, 402, 403, 426 or 429, and a local storage error,
/// including one under the document's log
/// (the database is unreadable, and the pass cannot go on without it).
/// Everything about one document defers that document's batch alone.
pub(crate) fn classify(
    pushed: Result<SnapshotOutcome, SnapshotError>,
) -> Result<SnapshotFallbackOutcome, ApiError> {
    use SnapshotFallbackOutcome::{Parked, Pushed, QuotaExceeded, Rejected, Transient};
    Ok(match pushed {
        Ok(SnapshotOutcome::Pushed { .. }) => Pushed,
        Ok(SnapshotOutcome::Refused(refusal)) => {
            let reason = refusal.reason().to_owned();
            match refusal {
                // A purge since the replay: the next pass replays it again.
                Refusal::UnmergedRemoteState | Refusal::PurgedSinceLoad => Transient(reason),
                Refusal::LocalOnly | Refusal::Purged | Refusal::EmptyState | Refusal::TooLarge => {
                    Parked(reason)
                }
            }
        }
        Err(SnapshotError::Rejected { reason }) => Rejected(reason),
        Err(SnapshotError::Crdt { source }) => return crdt_class(source, "could not encode"),
        Err(error @ SnapshotError::Seal { .. }) => Transient(error.to_string()),
        Err(SnapshotError::Storage { source }) => return Err(local(source)),
        Err(SnapshotError::Api { source }) => match source {
            ApiError::Status {
                status: 413,
                code: Some(ref code),
                ..
            } if code == QUOTA_EXCEEDED => QuotaExceeded(format!("{QUOTA_EXCEEDED}: {source}")),
            ApiError::Status { status, .. } if status >= 500 => Transient(source.to_string()),
            // 401, 402 (`SYNC_PAYMENT_REQUIRED`, `SYNC_VAULT_LIMIT_EXCEEDED`),
            // 403 and 426 are the account's or the client's state, not this
            // document's: the pass fails, whatever shape the answer arrives in.
            // (A 429 arrives as `RateLimited`, never as a `Status`.)
            ApiError::Status { status, .. }
                if (400..500).contains(&status) && !matches!(status, 401 | 402 | 403 | 426) =>
            {
                Rejected(source.to_string())
            }
            other => return Err(other),
        },
    })
}

/// A document's own log or state that did not replay or encode. Only bytes that
/// cannot decode or apply wait for an edit; a busy document is retried, and a
/// storage failure is the device's, so it fails the pass.
fn crdt_class(error: CrdtError, doing: &str) -> Result<SnapshotFallbackOutcome, ApiError> {
    match error {
        CrdtError::Undecodable { .. } | CrdtError::NotApplicable { .. } => {
            Ok(SnapshotFallbackOutcome::Parked(format!("{doing}: {error}")))
        }
        // A sync step never asks a lock, so this does not reach here.
        #[cfg(feature = "markdown")]
        CrdtError::Locked { .. } => {
            Ok(SnapshotFallbackOutcome::Parked(format!("{doing}: {error}")))
        }
        CrdtError::DocumentBusy { .. } => Ok(SnapshotFallbackOutcome::Transient(format!(
            "{doing}: {error}"
        ))),
        CrdtError::Storage { source } => Err(local(source)),
    }
}

/// `ErrorCodes.STORAGE_QUOTA_EXCEEDED` (`apps/sync-server/src/lib/errors.ts:79`),
/// answered with a 413 by `reserveStorage` (`services/quota.ts:12`, `:44`).
const QUOTA_EXCEEDED: &str = "STORAGE_QUOTA_EXCEEDED";

fn local(error: StorageError) -> ApiError {
    ApiError::Storage {
        what: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crdt::errors::CrdtError;
    use crate::protocol::envelope::EnvelopeError;
    use SnapshotFallbackOutcome::{Parked, Pushed, QuotaExceeded, Rejected, Transient};

    fn status(status: u16, code: Option<&str>) -> Result<SnapshotOutcome, SnapshotError> {
        Err(SnapshotError::Api {
            source: ApiError::Status {
                status,
                code: code.map(str::to_owned),
                message: "refused".to_owned(),
            },
        })
    }

    fn class(pushed: Result<SnapshotOutcome, SnapshotError>) -> SnapshotFallbackOutcome {
        classify(pushed).expect("a class, not a failed pass")
    }

    #[test]
    fn every_refusal_is_transient_or_parked() {
        for (refusal, transient) in [
            (Refusal::UnmergedRemoteState, true),
            (Refusal::LocalOnly, false),
            (Refusal::Purged, false),
            (Refusal::EmptyState, false),
            (Refusal::TooLarge, false),
        ] {
            let label = format!("{refusal:?}");
            let got = class(Ok(SnapshotOutcome::Refused(refusal)));
            assert_eq!(matches!(got, Transient(_)), transient, "{label}");
            assert!(transient || matches!(got, Parked(_)), "{label}");
        }
    }

    #[test]
    fn each_server_answer_has_one_class() {
        assert!(matches!(class(status(500, None)), Transient(_)));
        assert!(matches!(class(status(503, None)), Transient(_)));
        assert!(matches!(
            class(status(413, Some("STORAGE_QUOTA_EXCEEDED"))),
            QuotaExceeded(_)
        ));
        // A 413 that is not the quota is the server refusing this document.
        assert!(matches!(
            class(status(413, Some("VALIDATION_BODY_TOO_LARGE"))),
            Rejected(_)
        ));
        for refused in [400, 404, 409, 422] {
            assert!(
                matches!(class(status(refused, None)), Rejected(_)),
                "{refused}"
            );
        }
        assert!(matches!(
            class(Err(SnapshotError::Rejected {
                reason: "no".to_owned()
            })),
            Rejected(_)
        ));
        assert_eq!(
            class(Ok(SnapshotOutcome::Pushed {
                sequence_num: 1,
                pruned: 0
            })),
            Pushed
        );
    }

    #[test]
    fn a_local_failure_of_one_document_defers_it_and_does_not_fail_the_pass() {
        let undecodable = SnapshotError::Crdt {
            source: CrdtError::Undecodable {
                doc_id: "d".to_owned(),
                what: "garbage".to_owned(),
            },
        };
        assert!(matches!(class(Err(undecodable)), Parked(_)));
        // A busy document is retried: it is not damaged.
        let busy = SnapshotError::Crdt {
            source: CrdtError::DocumentBusy {
                doc_id: "d".to_owned(),
                what: "transaction alive".to_owned(),
            },
        };
        assert!(matches!(class(Err(busy)), Transient(_)));
        let seal = SnapshotError::Seal {
            source: EnvelopeError::Malformed {
                what: "no key".to_owned(),
            },
        };
        assert!(matches!(class(Err(seal)), Transient(_)));
    }

    #[test]
    fn only_a_failure_of_the_device_or_the_session_fails_the_pass() {
        let storage_under_the_log = SnapshotError::Crdt {
            source: CrdtError::Storage {
                source: StorageError::Failed {
                    what: "disk".to_owned(),
                },
            },
        };
        for failing in [
            status(401, None),
            status(402, Some("SYNC_PAYMENT_REQUIRED")),
            status(402, Some("SYNC_VAULT_LIMIT_EXCEEDED")),
            status(403, None),
            status(426, None),
            Err(storage_under_the_log),
            Err(SnapshotError::Storage {
                source: StorageError::Failed {
                    what: "disk".to_owned(),
                },
            }),
            Err(SnapshotError::Api {
                source: ApiError::WritesDisabled {
                    message: "off".to_owned(),
                },
            }),
            Err(SnapshotError::Api {
                source: ApiError::Unauthorized {
                    code: "AUTH".to_owned(),
                    message: "no".to_owned(),
                },
            }),
        ] {
            assert!(classify(failing).is_err());
        }
    }
}
