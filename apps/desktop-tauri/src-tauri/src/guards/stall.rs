//! Reports a blocked main thread. A tick every second asks the main thread to acknowledge; the
//! same thread then checks how old the last acknowledgement is. The thread is not the main
//! thread, so it keeps running while the main thread is stuck, and a launch that froze leaves a
//! `main thread stalled` line with the launch phase it interrupted.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use memry_desktop::launch_timeline;
use memry_desktop::shell::stall::{StallDetector, TICK_MS};
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::CommandError;

/// Suspends the monitor across system sleep, which stops the main thread as well. The power
/// monitor calls it.
pub struct StallMonitor {
    detector: Arc<Mutex<StallDetector>>,
    origin: Instant,
}

impl StallMonitor {
    fn now_ms(&self) -> u64 {
        u64::try_from(self.origin.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    pub fn suspend(&self) {
        self.lock().suspend();
    }

    pub fn resume(&self) {
        let now = self.now_ms();
        self.lock().resume(now);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, StallDetector> {
        self.detector.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

pub fn start(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let origin = Instant::now();
    let detector = Arc::new(Mutex::new(StallDetector::new(0)));
    let monitor = StallMonitor {
        detector: detector.clone(),
        origin,
    };
    app.manage(monitor);
    let handle = app.clone();
    std::thread::Builder::new()
        .name("main-thread-stall".to_owned())
        .spawn(move || watch(&handle, &detector, origin))
        .map_err(|error| {
            CommandError::new(
                crate::commands::error::ErrorKind::Internal,
                "stall_monitor",
                error.to_string(),
            )
        })?;
    Ok(())
}

fn watch(app: &AppHandle<Wry>, detector: &Arc<Mutex<StallDetector>>, origin: Instant) {
    let elapsed = move || u64::try_from(origin.elapsed().as_millis()).unwrap_or(u64::MAX);
    loop {
        std::thread::sleep(Duration::from_millis(TICK_MS));
        let on_main = detector.clone();
        // Queued, not awaited: a blocked main thread must not block the watchdog.
        let queued = app.run_on_main_thread(move || {
            on_main
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .ack(elapsed());
        });
        if queued.is_err() {
            // The event loop is gone: the app is exiting.
            return;
        }
        let report = detector
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .poll(elapsed());
        if let Some(report) = report {
            let phase = launch_timeline::global()
                .latest()
                .map_or("startup", launch_timeline::LaunchPhase::name);
            tracing::warn!(
                scope = "MainThreadStall",
                "main thread stalled durationMs={} phase={phase} count={}",
                report.duration_ms,
                report.count
            );
        }
    }
}
