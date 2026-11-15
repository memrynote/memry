//! A copied six-digit code fills the code field (`ipc/auth-device-handlers.ts:226-262`): the
//! clipboard is read once a second from a code request until the code is verified or ten
//! minutes pass, and each new six-digit value is reported once.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior};

pub const POLL: Duration = Duration::from_secs(1);
pub const TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// The one watch of the app; a new start replaces the running one.
#[derive(Default)]
pub struct OtpClipboardWatch {
    task: Mutex<Option<JoinHandle<()>>>,
}

impl OtpClipboardWatch {
    /// Must run inside a Tokio runtime. `read` returns the clipboard text, `None` when it holds
    /// none; `emit` receives each detected code.
    pub fn start(
        &self,
        read: impl Fn() -> Option<String> + Send + Sync + 'static,
        emit: impl Fn(String) + Send + Sync + 'static,
    ) {
        // What the clipboard held before the request is not a code the user just copied.
        let before = read().unwrap_or_default();
        let task = tokio::spawn(watch(before, Arc::new(read), Arc::new(emit)));
        if let Some(previous) = self.lock().replace(task) {
            previous.abort();
        }
    }

    pub fn stop(&self) {
        if let Some(task) = self.lock().take() {
            task.abort();
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<JoinHandle<()>>> {
        self.task.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Drop for OtpClipboardWatch {
    fn drop(&mut self) {
        self.stop();
    }
}

async fn watch(
    mut last: String,
    read: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    emit: Arc<dyn Fn(String) + Send + Sync>,
) {
    let deadline = Instant::now() + TIMEOUT;
    let mut tick = tokio::time::interval_at(Instant::now() + POLL, POLL);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            () = tokio::time::sleep_until(deadline) => return,
            _ = tick.tick() => {
                let text = read().unwrap_or_default().trim().to_owned();
                if text == last {
                    continue;
                }
                last.clone_from(&text);
                if is_code(&text) {
                    emit(text);
                }
            }
        }
    }
}

/// `OTP_PATTERN`, `/^\d{6}$/`.
fn is_code(text: &str) -> bool {
    text.len() == 6 && text.bytes().all(|b| b.is_ascii_digit())
}
