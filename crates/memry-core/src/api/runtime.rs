//! The runtime host, research R5.
//!
//! **One runtime, created once, never dropped.** Every async path in the core
//! — the retry ladder, the refresh timer, the sync engine — runs on it, and a
//! second one would give each its own timer wheel and its own idea of what
//! "now" is. It lives in a `OnceLock` in a `static`, so it is built on first
//! use and never torn down: dropping a multi-thread runtime blocks the calling
//! thread until every worker parks, and the caller here is whichever shell
//! thread happened to make the last call.
//!
//! **Two to four workers.** The core's work is IO-bound through the `Transport`
//! seam and SQLite-bound through `spawn_blocking`, so more workers than that
//! buys nothing and costs a stack each on a device with four performance cores
//! and a 30 MB memory ceiling in an extension.
//!
//! **The resume debounce is the other half.** tokio's timers fire **late and
//! all at once** after the OS suspends the process: a phone that was away for
//! an hour comes back with every interval that should have fired in that hour
//! ready to run in the same tick. A resume that let them all through would
//! launch several sync passes into the same cursor. So the shell's
//! `on_foreground` records the instant, and anything that resumes work waits
//! for the window to settle first.

use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tokio::runtime::{Builder, Runtime};

use crate::seams::background::LifecycleObserver;

/// The floor and ceiling on worker threads (research R5).
const MIN_WORKER_THREADS: usize = 2;
const MAX_WORKER_THREADS: usize = 4;

/// How long after a foreground transition the core waits before it lets
/// resumed work run.
///
/// Not a protocol constant: no chapter names one. It is chosen to be longer
/// than the burst of late timers tokio releases in the first tick after a
/// resume, and short enough that a user who just opened the app cannot see it.
pub const RESUME_DEBOUNCE_MS: u64 = 500;

static RUNTIME: OnceLock<Runtime> = OnceLock::new();

/// The one runtime. Built on first call.
///
/// Panics only if tokio cannot spawn its workers, which is a process that
/// cannot run at all rather than a condition a shell can handle.
pub fn runtime() -> &'static Runtime {
    RUNTIME.get_or_init(|| {
        Builder::new_multi_thread()
            .worker_threads(worker_threads())
            .thread_name("memry-core")
            .enable_time()
            .build()
            .expect("the core's tokio runtime could not be created")
    })
}

/// Available parallelism, clamped to the R5 range.
fn worker_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(MIN_WORKER_THREADS)
        .clamp(MIN_WORKER_THREADS, MAX_WORKER_THREADS)
}

/// Runs a future to completion on the core's runtime.
///
/// For the synchronous FFI surface: a shell thread that is already inside a
/// runtime must not call this, and does not — every foreign call arrives on a
/// thread the core does not own.
pub fn block_on<F: std::future::Future>(future: F) -> F::Output {
    runtime().block_on(future)
}

/// Spawns detached work on the core's runtime.
pub fn spawn<F>(future: F) -> tokio::task::JoinHandle<F::Output>
where
    F: std::future::Future + Send + 'static,
    F::Output: Send + 'static,
{
    runtime().spawn(future)
}

/// Which side of the lifecycle the process is on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum AppPhase {
    Foreground,
    Background,
    /// The platform warned that the current background task is about to be
    /// killed. Distinct from `Background` because the correct response is to
    /// finish the durable write in hand, not to start another one
    /// (data-model §D.6).
    Expiring,
}

#[derive(Debug)]
struct Lifecycle {
    phase: AppPhase,
    /// When the last foreground transition happened. `None` before the first
    /// one, which is the state a headless or test process stays in.
    resumed_at: Option<Instant>,
}

/// The shell's handle on the runtime's lifecycle.
///
/// The shell owns one and calls it from the platform's own lifecycle
/// callbacks. It carries no runtime of its own: the runtime is the process's,
/// this is only the state that says whether resumed work may run yet.
#[derive(Debug, uniffi::Object)]
pub struct RuntimeHost {
    debounce: Duration,
    state: Mutex<Lifecycle>,
}

impl Default for RuntimeHost {
    fn default() -> Self {
        Self::with_debounce_ms(RESUME_DEBOUNCE_MS)
    }
}

impl RuntimeHost {
    /// A host with a custom debounce window. Tests use it to keep the window
    /// short; nothing on device should.
    pub fn with_debounce_ms(debounce_ms: u64) -> Self {
        Self {
            debounce: Duration::from_millis(debounce_ms),
            state: Mutex::new(Lifecycle {
                phase: AppPhase::Foreground,
                resumed_at: None,
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Lifecycle> {
        // A panic while holding this lock would leave the phase unreadable and
        // the app unable to sync until relaunch, which is strictly worse than
        // continuing from the poisoned value: the value is two plain fields.
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Milliseconds still to wait before resumed work may run. Zero when the
    /// window has passed, and zero when there has been no resume at all.
    pub fn resume_debounce_remaining_ms(&self) -> u64 {
        let state = self.lock();
        let Some(resumed_at) = state.resumed_at else {
            return 0;
        };
        let elapsed = resumed_at.elapsed();
        if elapsed >= self.debounce {
            0
        } else {
            (self.debounce - elapsed).as_millis() as u64
        }
    }

    /// Waits out the resume debounce, re-reading it each pass so that a second
    /// foreground transition arriving mid-wait extends the window rather than
    /// being swallowed by it.
    pub async fn await_resume_settled(&self) {
        loop {
            let remaining = self.resume_debounce_remaining_ms();
            if remaining == 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(remaining)).await;
        }
    }
}

#[uniffi::export]
impl RuntimeHost {
    /// Creates the host and, as a side effect, the runtime: doing it here
    /// means the first sync pass does not pay for thread creation.
    #[uniffi::constructor]
    pub fn new() -> Self {
        let _ = runtime();
        Self::default()
    }

    /// The platform moved the app out of the foreground.
    pub fn on_background(&self) {
        self.lock().phase = AppPhase::Background;
    }

    /// The platform brought the app back. Starts the debounce window.
    pub fn on_foreground(&self) {
        let mut state = self.lock();
        state.phase = AppPhase::Foreground;
        state.resumed_at = Some(Instant::now());
    }

    /// The platform is about to kill the current background task.
    pub fn on_expiring(&self) {
        self.lock().phase = AppPhase::Expiring;
    }

    pub fn phase(&self) -> AppPhase {
        self.lock().phase
    }

    /// Whether resumed work may run now. The shell never has to compute this;
    /// it is here so a shell that wants to render "catching up" can.
    pub fn resume_settled(&self) -> bool {
        self.resume_debounce_remaining_ms() == 0
    }
}

/// The seam's own shape, so a shell that already holds the observer trait can
/// hand the runtime host straight to its platform callbacks.
impl LifecycleObserver for RuntimeHost {
    fn on_background(&self) {
        RuntimeHost::on_background(self);
    }

    fn on_foreground(&self) {
        RuntimeHost::on_foreground(self);
    }

    fn on_expiring(&self) {
        RuntimeHost::on_expiring(self);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_threads_stay_inside_the_r5_range() {
        let n = worker_threads();
        assert!((MIN_WORKER_THREADS..=MAX_WORKER_THREADS).contains(&n));
    }

    #[test]
    fn the_runtime_is_created_once() {
        let a = runtime() as *const Runtime;
        let b = runtime() as *const Runtime;
        assert_eq!(a, b);
    }

    #[test]
    fn phase_tracks_the_lifecycle_callbacks() {
        let host = RuntimeHost::with_debounce_ms(0);
        assert_eq!(host.phase(), AppPhase::Foreground);
        host.on_background();
        assert_eq!(host.phase(), AppPhase::Background);
        host.on_expiring();
        assert_eq!(host.phase(), AppPhase::Expiring);
        host.on_foreground();
        assert_eq!(host.phase(), AppPhase::Foreground);
    }

    #[test]
    fn a_process_that_never_backgrounded_never_waits() {
        let host = RuntimeHost::with_debounce_ms(RESUME_DEBOUNCE_MS);
        assert_eq!(host.resume_debounce_remaining_ms(), 0);
        assert!(host.resume_settled());
    }

    #[test]
    fn a_resume_opens_a_debounce_window() {
        let host = RuntimeHost::with_debounce_ms(10_000);
        host.on_background();
        host.on_foreground();
        let remaining = host.resume_debounce_remaining_ms();
        assert!(remaining > 0 && remaining <= 10_000, "{remaining}");
        assert!(!host.resume_settled());
    }

    #[test]
    fn awaiting_the_window_settles_it() {
        let host = RuntimeHost::with_debounce_ms(20);
        host.on_background();
        host.on_foreground();
        block_on(host.await_resume_settled());
        assert!(host.resume_settled());
    }

    #[test]
    fn a_second_resume_extends_the_window() {
        let host = RuntimeHost::with_debounce_ms(10_000);
        host.on_foreground();
        let first = host.resume_debounce_remaining_ms();
        std::thread::sleep(Duration::from_millis(5));
        host.on_foreground();
        let second = host.resume_debounce_remaining_ms();
        assert!(second >= first, "{second} < {first}");
    }
}
