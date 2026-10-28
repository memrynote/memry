//! Sleep, wake and session end. [`PowerMonitor`] owns one broadcast channel of
//! `memry_desktop::shell::power::PowerEvent`; each platform file feeds it, and subscribers (the
//! stall monitor here, the review scheduler in Step 27 (#3544), Google Calendar resume in Step 29
//! (#3546)) each call `subscribe()`.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod mac;
#[cfg(windows)]
mod win;

use memry_desktop::shell::power::PowerEvent;
use tauri::{AppHandle, Manager, Wry};
use tokio::sync::broadcast;

use crate::commands::error::CommandError;
use crate::guards::stall::StallMonitor;
use crate::startup::{self, Stage};

/// Events nobody has read yet before the slowest subscriber starts missing the oldest.
const CHANNEL_DEPTH: usize = 16;

pub struct PowerMonitor {
    tx: broadcast::Sender<PowerEvent>,
}

impl PowerMonitor {
    fn new() -> Self {
        Self {
            tx: broadcast::channel(CHANNEL_DEPTH).0,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PowerEvent> {
        self.tx.subscribe()
    }

    /// Hands `event` to every subscriber and logs it.
    pub fn emit(&self, event: PowerEvent) {
        publish(&self.tx, event);
    }

    /// A cheap handle a platform callback can own.
    fn sender(&self) -> broadcast::Sender<PowerEvent> {
        self.tx.clone()
    }
}

/// Every platform source reports through this, so a wake reads the same line everywhere.
fn publish(sender: &broadcast::Sender<PowerEvent>, event: PowerEvent) {
    tracing::info!(scope = "Power", "{}", describe(event));
    // No receiver is not a failure: it only means nobody listens yet.
    let _ = sender.send(event);
}

#[cfg(all(target_os = "macos", feature = "e2e"))]
pub use mac::post_workspace_notification;
#[cfg(all(windows, feature = "e2e"))]
pub use win::post_sign_out;

fn describe(event: PowerEvent) -> &'static str {
    match event {
        PowerEvent::Suspend => "system suspend",
        PowerEvent::Resume => "system resume",
        PowerEvent::SessionEnding => "session ending",
    }
}

pub fn register_stages() {
    startup::register(Stage::Handlers, "start power monitor", manage);
    startup::register(Stage::Window, "listen for power events", start_platform);
}

fn manage(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let monitor = PowerMonitor::new();
    let mut events = monitor.subscribe();
    app.manage(monitor);
    // The stall monitor must not read a sleeping machine as a frozen main thread.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(PowerEvent::Suspend) => {
                    if let Some(stall) = handle.try_state::<StallMonitor>() {
                        stall.suspend();
                    }
                }
                Ok(PowerEvent::Resume) => {
                    if let Some(stall) = handle.try_state::<StallMonitor>() {
                        stall.resume();
                    }
                }
                Ok(PowerEvent::SessionEnding) => {}
                Err(broadcast::error::RecvError::Lagged(missed)) => {
                    // A missed `Resume` would leave the stall monitor off for good, and a
                    // monitor that was never suspended is unaffected by `resume`.
                    tracing::warn!(
                        scope = "Power",
                        "missed {missed} power events; resuming the stall monitor"
                    );
                    if let Some(stall) = handle.try_state::<StallMonitor>() {
                        stall.resume();
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    Ok(())
}

fn start_platform(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let sender = app.state::<PowerMonitor>().sender();
    #[cfg(target_os = "macos")]
    mac::start(&sender);
    #[cfg(target_os = "linux")]
    linux::start(app, &sender);
    #[cfg(windows)]
    win::start(app, &sender);
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    let _ = &sender;
    Ok(())
}
