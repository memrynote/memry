use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, PoisonError, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Failures with the same `<command>:<code>` key reach the sink once per window
/// (`ERROR_TRACK_THROTTLE_MS` in `apps/desktop/src/main/ipc/validate.ts`).
pub const THROTTLE_WINDOW_MS: u64 = 60_000;
/// Hard bound on tracked keys (`MAX_TRACKED_ERROR_KEYS` in the same file).
pub const MAX_TRACKED_KEYS: usize = 1000;

struct Tracked {
    reported_at_ms: u64,
    inserted: u64,
}

/// Loop protection for failure reporting. Dropping a key only forfeits its throttle, never a
/// report.
#[derive(Default)]
pub struct FailureThrottle {
    keys: HashMap<String, Tracked>,
    next_insert: u64,
}

impl FailureThrottle {
    pub fn new() -> Self {
        Self::default()
    }

    /// True when `key` has not been reported inside the window ending at `now_ms`.
    pub fn should_report(&mut self, key: &str, now_ms: u64) -> bool {
        if let Some(tracked) = self.keys.get_mut(key) {
            if now_ms.saturating_sub(tracked.reported_at_ms) < THROTTLE_WINDOW_MS {
                return false;
            }
            tracked.reported_at_ms = now_ms;
            return true;
        }
        self.keys.insert(
            key.to_owned(),
            Tracked {
                reported_at_ms: now_ms,
                inserted: self.next_insert,
            },
        );
        self.next_insert += 1;
        self.sweep(now_ms);
        true
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    fn sweep(&mut self, now_ms: u64) {
        if self.keys.len() <= MAX_TRACKED_KEYS {
            return;
        }
        self.keys
            .retain(|_, t| now_ms.saturating_sub(t.reported_at_ms) < THROTTLE_WINDOW_MS);
        // A burst of more than MAX distinct keys inside one window leaves nothing expired, so the
        // oldest-inserted keys go to keep the bound hard.
        while self.keys.len() > MAX_TRACKED_KEYS {
            let Some(oldest) = self
                .keys
                .iter()
                .min_by_key(|(_, t)| t.inserted)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.keys.remove(&oldest);
        }
    }
}

/// What a sink sees of a command failure. The renderer-facing `CommandError` lives in
/// `memry-tauri`; this crate has no tauri or specta dependency, so the fields cross as strings.
#[derive(Debug, Clone, Copy)]
pub struct FailureDetails<'a> {
    pub kind: &'a str,
    pub code: &'a str,
    pub message: &'a str,
}

pub trait FailureSink: Send + Sync {
    fn report(&self, command: &str, error: FailureDetails<'_>);
}

/// The sink that ships with the scaffold. Step 09 (#3526) registers a telemetry sink instead.
pub struct LoggingSink;

impl FailureSink for LoggingSink {
    fn report(&self, command: &str, error: FailureDetails<'_>) {
        tracing::warn!(
            command,
            kind = error.kind,
            code = error.code,
            "command failed: {}",
            error.message
        );
    }
}

/// Throttle plus the replaceable sink.
pub struct FailureReporter {
    throttle: Mutex<FailureThrottle>,
    sink: RwLock<Arc<dyn FailureSink>>,
}

impl FailureReporter {
    pub fn new(sink: Arc<dyn FailureSink>) -> Self {
        Self {
            throttle: Mutex::new(FailureThrottle::new()),
            sink: RwLock::new(sink),
        }
    }

    pub fn register_sink(&self, sink: Arc<dyn FailureSink>) {
        *self.sink.write().unwrap_or_else(PoisonError::into_inner) = sink;
    }

    /// Forward the failure to the sink unless its `<command>:<code>` key is inside the window.
    pub fn report(&self, command: &str, error: FailureDetails<'_>) {
        let key = format!("{command}:{}", error.code);
        let allowed = self
            .throttle
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .should_report(&key, now_ms());
        if allowed {
            let sink = Arc::clone(&self.sink.read().unwrap_or_else(PoisonError::into_inner));
            sink.report(command, error);
        }
    }
}

/// The process-wide reporter that `log_failure` in `memry-tauri` feeds.
pub fn reporter() -> &'static FailureReporter {
    static REPORTER: OnceLock<FailureReporter> = OnceLock::new();
    REPORTER.get_or_init(|| FailureReporter::new(Arc::new(LoggingSink)))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}
