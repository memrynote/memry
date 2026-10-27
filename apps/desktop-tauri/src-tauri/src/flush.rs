//! The flush handshake: main asks a window to write its unsaved edits and waits for the window's
//! `flush_done` reply. The pending table and its rules live in `memry_desktop::shell::flush`.

use memry_desktop::shell::flush::{FlushTable, wait_for};
use memry_desktop::shell::shutdown::Deadline;
use tauri::{AppHandle, Wry};

use crate::events::{FlushRequestedEvent, send_to};

#[derive(Default)]
pub struct FlushService {
    table: FlushTable,
}

impl FlushService {
    /// Asks the window labelled `label` to flush and waits for its reply, for at most the
    /// per-window ceiling or what `deadline` leaves. False on a timeout.
    pub async fn request(&self, app: &AppHandle<Wry>, label: &str, deadline: Deadline) -> bool {
        let ticket = self.table.begin(label);
        send_to(
            app,
            label,
            FlushRequestedEvent {
                request_id: ticket.id.clone(),
            },
        );
        match tokio::time::timeout(wait_for(deadline.remaining()), ticket.reply).await {
            Ok(Ok(())) => true,
            _ => {
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
}
