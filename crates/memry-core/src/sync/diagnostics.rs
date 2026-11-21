//! A sync run's request statistics, told to the shell's log (#5215).
//!
//! A [`RunDiagnostics`] does two jobs for one run. Attached to an
//! [`HttpClient`] with [`RunDiagnostics::observe`], it counts every attempt the
//! run's requests make: wire time, retries, 429s and the wait they cost, 5xx
//! and transport failures. And it scopes those counts to a phase
//! ([`RunDiagnostics::phase`]), reporting one [`CoreDiagnostic::PhaseStats`]
//! when the phase ends.
//!
//! **A run that never ends still reports.** The incident this exists for was a
//! first sync that crawled for hours, so a phase also reports a snapshot of its
//! counts so far, at most once per [`INTERIM_INTERVAL`]. The snapshot rides on
//! the next attempt rather than on a timer task, so an idle run makes no noise.
//!
//! Only the requests of a client derived by `observe` are counted, which is how
//! the run's own traffic is told from the rest of the session's. Without a sink
//! ([`RunDiagnostics::silent`]) every call is a no-op and `observe` hands back
//! the client it was given.

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::time::Instant;

use crate::protocol::http::{HttpClient, RequestObserver};
use crate::seams::diagnostics::{CoreDiagnostic, DiagnosticPhase, DiagnosticsSink, RequestStats};

/// The longest a running phase stays quiet.
pub const INTERIM_INTERVAL: Duration = Duration::from_secs(120);

pub struct RunDiagnostics {
    sink: Option<Arc<dyn DiagnosticsSink>>,
    window: Mutex<Option<Window>>,
}

/// One phase's counts so far.
struct Window {
    phase: DiagnosticPhase,
    started: Instant,
    last_reported: Instant,
    latencies_ms: Vec<u32>,
    retries: u32,
    rate_limited: u32,
    rate_limit_wait_ms: u64,
    server_errors: u32,
    transport_errors: u32,
}

impl Window {
    fn open(phase: DiagnosticPhase) -> Self {
        let now = Instant::now();
        Self {
            phase,
            started: now,
            last_reported: now,
            latencies_ms: Vec::new(),
            retries: 0,
            rate_limited: 0,
            rate_limit_wait_ms: 0,
            server_errors: 0,
            transport_errors: 0,
        }
    }

    fn report(&self, finished: bool) -> CoreDiagnostic {
        let mut sorted = self.latencies_ms.clone();
        sorted.sort_unstable();
        CoreDiagnostic::PhaseStats {
            phase: self.phase,
            finished,
            elapsed_ms: u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX),
            requests: RequestStats {
                requests: u32::try_from(sorted.len()).unwrap_or(u32::MAX),
                p50_ms: percentile(&sorted, 50),
                p95_ms: percentile(&sorted, 95),
                max_ms: sorted.last().copied().unwrap_or(0),
                retries: self.retries,
                rate_limited: self.rate_limited,
                rate_limit_wait_ms: self.rate_limit_wait_ms,
                server_errors: self.server_errors,
                transport_errors: self.transport_errors,
            },
        }
    }
}

/// Nearest-rank percentile of an ascending list; 0 for an empty one.
fn percentile(sorted: &[u32], percent: usize) -> u32 {
    let rank = (sorted.len() * percent).div_ceil(100);
    rank.checked_sub(1)
        .and_then(|index| sorted.get(index))
        .copied()
        .unwrap_or(0)
}

impl RunDiagnostics {
    pub fn new(sink: Arc<dyn DiagnosticsSink>) -> Arc<Self> {
        Arc::new(Self {
            sink: Some(sink),
            window: Mutex::new(None),
        })
    }

    /// The recorder of a run nobody listens to.
    pub fn silent() -> Arc<Self> {
        Arc::new(Self {
            sink: None,
            window: Mutex::new(None),
        })
    }

    /// `http`, derived so this run's requests are counted. Without a sink it is
    /// `http` itself.
    pub fn observe(self: &Arc<Self>, http: &Arc<HttpClient>) -> Arc<HttpClient> {
        if self.sink.is_none() {
            return Arc::clone(http);
        }
        Arc::new(http.observed(Arc::clone(self) as Arc<dyn RequestObserver>))
    }

    pub fn emit(&self, event: CoreDiagnostic) {
        if let Some(sink) = &self.sink {
            sink.record(event);
        }
    }

    /// Runs `work` as `phase`: the requests it makes are counted from zero, and
    /// one final [`CoreDiagnostic::PhaseStats`] reports them when it returns,
    /// unless it made none. A run dropped mid-phase reports no final; its
    /// interim snapshots stand.
    pub async fn phase<T>(&self, phase: DiagnosticPhase, work: impl Future<Output = T>) -> T {
        if self.sink.is_none() {
            return work.await;
        }
        *self.lock() = Some(Window::open(phase));
        let output = work.await;
        let closed = self.lock().take();
        if let Some(window) = closed
            && !window.latencies_ms.is_empty()
        {
            self.emit(window.report(true));
        }
        output
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Window>> {
        self.window
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl RequestObserver for RunDiagnostics {
    fn attempt(&self, status: Option<u16>, elapsed_ms: u64) {
        let interim = {
            let mut guard = self.lock();
            let Some(window) = guard.as_mut() else { return };
            window
                .latencies_ms
                .push(u32::try_from(elapsed_ms).unwrap_or(u32::MAX));
            match status {
                Some(429) => window.rate_limited += 1,
                Some(500..=599) => window.server_errors += 1,
                None => window.transport_errors += 1,
                Some(_) => {}
            }
            let now = Instant::now();
            (now.duration_since(window.last_reported) >= INTERIM_INTERVAL).then(|| {
                window.last_reported = now;
                window.report(false)
            })
        };
        if let Some(event) = interim {
            self.emit(event);
        }
    }

    fn retry(&self, status: Option<u16>, wait_ms: u64) {
        let mut guard = self.lock();
        let Some(window) = guard.as_mut() else { return };
        window.retries += 1;
        if status == Some(429) {
            window.rate_limit_wait_ms += wait_ms;
        }
    }
}
