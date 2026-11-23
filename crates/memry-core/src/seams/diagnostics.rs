//! The diagnostics seam (#5215): what the core tells the shell's log about a
//! sync run, so a feedback email can show why a first sync crawled.
//!
//! **The payload is the privacy rule, held by its shape.** [`CoreDiagnostic`]
//! carries integers, booleans and closed enums, and nothing else. It has no
//! `String`, so no note id, title, path, key, token or server message can ride
//! along, and a future field of that kind has to be written into this file
//! where a reviewer reads it. The shell decides the words: it maps each
//! variant to a fixed message of its own and renders these numbers beside it.
//!
//! Volume is bounded the same way. A phase reports once when it ends, and at
//! most once every [`crate::sync::diagnostics::INTERIM_INTERVAL`] while it
//! runs, because a run that crawls for hours never reaches the end. Nothing is
//! reported per request.

/// How `POST /sync/bootstrap` answered (chapter 10 §10.5), reduced to the
/// cases a support reader acts on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum BootstrapOutcome {
    /// A session was granted: the run is elevated.
    Granted,
    /// 409 `BOOTSTRAP_NOT_ELIGIBLE`: this device already pulled the vault and
    /// is past the resume window (§10.9).
    NotEligible,
    /// 429 `BOOTSTRAP_SESSION_LIMIT`: the per-user concurrent cap.
    SessionLimit,
    /// 501: the deployment has no bootstrap key (§10.12).
    NotImplemented,
    /// The server answered 2xx without a session token.
    NoToken,
    /// Any other failure, with the status in [`CoreDiagnostic::BootstrapOpened`].
    Failed,
}

/// The parts of a sync run that report their own request statistics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum DiagnosticPhase {
    /// Record packs on a fresh device (chapter 08 §8.4.2).
    RecordPacks,
    /// `GET /sync/changes` to the end of the feed.
    Refs,
    /// The manifest reconcile after record packs (§8.10).
    Reconcile,
    /// `POST /sync/pull` over the records still metadata-only.
    Metadata,
    /// Body packs (§8.4.3).
    BodyPacks,
    /// The first sync's item-granular bodies pass.
    Bodies,
    /// One round of the foreground body drain.
    DrainBodies,
}

/// Wire statistics of one phase, over its requests so far.
///
/// `requests` counts every attempt put on the wire, retries included, and the
/// latencies are each attempt's own wire time. Waits slept between attempts
/// are in `rate_limit_wait_ms`, not in the latencies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, uniffi::Record)]
pub struct RequestStats {
    pub requests: u32,
    pub p50_ms: u32,
    pub p95_ms: u32,
    pub max_ms: u32,
    /// Attempts repeated after a retryable answer or a transport failure by
    /// the retry ladder, plus each 429 pause taken outside it (documents put
    /// back by the bodies pass, packs waiting in the pack download).
    pub retries: u32,
    /// Attempts the server answered 429.
    pub rate_limited: u32,
    /// Time slept waiting out a 429: in the retry ladder, and in the pauses
    /// taken outside it.
    pub rate_limit_wait_ms: u64,
    /// Attempts the server answered 5xx.
    pub server_errors: u32,
    /// Attempts that got no HTTP answer at all.
    pub transport_errors: u32,
}

/// One fact about a sync run. See the module doc for what it may carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum CoreDiagnostic {
    /// The bootstrap session open finished. `status` is the HTTP status, or 0
    /// when there was no HTTP answer or the failure names none.
    BootstrapOpened {
        outcome: BootstrapOutcome,
        status: u16,
    },
    /// A bodies pass probed its documents and is about to pull the rest.
    /// `concurrency` is the streams it runs, `documents` the window, and
    /// `up_to_date` those the probe showed current, which are skipped. `None`
    /// when the pass never measures it: a drain round probes chunk by chunk.
    BodyPassStarted {
        elevated: bool,
        concurrency: u32,
        documents: u32,
        up_to_date: Option<u32>,
    },
    /// A phase's requests so far. `finished` is `true` once the phase ended,
    /// `false` for an interim snapshot of one still running.
    PhaseStats {
        phase: DiagnosticPhase,
        finished: bool,
        elapsed_ms: u64,
        requests: RequestStats,
    },
    /// The manifest reconcile kept `kept` stale rows live: their pull by id
    /// brought no verified delete or attested marker (§5.12.1). `remembered`
    /// of them hold an unattested marker for the push wave, and
    /// `non_envelope` pull answers were not envelopes. `cursor` is the record
    /// feed cursor, `None` when unset or not numeric. The ids stay out: this
    /// payload carries no strings.
    ReconcileKept {
        kept: u32,
        remembered: u32,
        non_envelope: u32,
        cursor: Option<i64>,
    },
    /// The refs pass pulled the `deleted` ids of the page at `cursor`:
    /// `unverified` of them got no verified delete, so they stay live, and
    /// `non_envelope` pulls got no envelope, so the feed re-read retries them.
    RefsDeletes {
        unverified: u32,
        non_envelope: u32,
        cursor: Option<i64>,
    },
}

impl CoreDiagnostic {
    /// A stored feed cursor as a number. Server cursors are integers.
    pub(crate) fn cursor(stored: Option<&str>) -> Option<i64> {
        stored.and_then(|cursor| cursor.parse().ok())
    }

    pub(crate) fn count(value: usize) -> u32 {
        u32::try_from(value).unwrap_or(u32::MAX)
    }
}

/// Where [`CoreDiagnostic`]s go.
///
/// **Synchronous by contract**, as [`crate::api::sync::SyncProgressListener`]
/// is: it is called from inside the sync it reports on, so an implementation
/// that blocks stalls that sync. Write the line and return.
#[uniffi::export(with_foreign)]
pub trait DiagnosticsSink: Send + Sync {
    fn record(&self, event: CoreDiagnostic);
}
