//! The flush handshake: main asks a window to write its unsaved edits and waits for the window's
//! `flush_done` reply. The pending table and its rules live in `memry_desktop::shell::flush`.

use memry_desktop::shell::flush::{FlushTable, wait_for};
use memry_desktop::shell::shutdown::Deadline;
use tauri::{AppHandle, Manager, Wry};

use crate::events::{FlushRequestedEvent, send_to};
use crate::windows::registry::WindowRegistry;

#[derive(Default)]
pub struct FlushService {
    table: FlushTable,
}

impl FlushService {
    /// Asks the window labelled `label` to flush and waits for its reply, for at most the
    /// per-window ceiling or what `deadline` leaves. False on a timeout, and at once when the
    /// window's page has no process to answer.
    pub async fn request(&self, app: &AppHandle<Wry>, label: &str, deadline: Deadline) -> bool {
        let Some(ticket) = self.table.begin(label) else {
            tracing::warn!(
                scope = "Shutdown",
                "window {label} has no page process; its flush is skipped"
            );
            return false;
        };
        send_to(
            app,
            label,
            FlushRequestedEvent {
                request_id: ticket.id.clone(),
            },
        );
        match tokio::time::timeout(wait_for(deadline.remaining()), ticket.reply).await {
            Ok(Ok(())) => true,
            Ok(Err(_)) => {
                tracing::warn!(
                    scope = "Shutdown",
                    "the page of window {label} lost its process before its flush answered"
                );
                false
            }
            Err(_) => {
                self.table.cancel(&ticket.id);
                tracing::warn!(scope = "Shutdown", "flush of window {label} timed out");
                false
            }
        }
    }

    /// The renderer's reply. True when `from` is the window the request went to.
    pub fn done(&self, from: &str, request_id: &str) -> bool {
        self.table.complete(from, request_id)
    }

    /// The page of window `label` lost its process: the waits on it end now.
    pub fn page_gone(&self, label: &str) -> usize {
        self.table.page_gone(label)
    }

    /// The page of window `label` (re)loaded and can answer again.
    pub fn page_loaded(&self, label: &str) {
        self.table.page_loaded(label);
    }
}

/// Asks every app window to write its unsaved edits, all at once, and waits for them under
/// `deadline`. A window that does not answer is logged by [`FlushService::request`].
pub async fn flush_app_windows(app: &AppHandle<Wry>, deadline: Deadline) {
    let asks: Vec<_> = WindowRegistry::app_windows(app)
        .iter()
        .map(|window| {
            let (app, label) = (app.clone(), window.label().to_owned());
            tauri::async_runtime::spawn(async move {
                app.state::<FlushService>()
                    .request(&app, &label, deadline)
                    .await
            })
        })
        .collect();
    for ask in asks {
        let _answered = ask.await;
    }
}
