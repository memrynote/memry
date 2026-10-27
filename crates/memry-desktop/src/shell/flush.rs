//! The pending table of the flush handshake: main asks a window to write its unsaved edits and
//! waits for that window's reply. A reply counts only from the window that was asked, with the
//! id that was issued, so a stale or foreign reply cannot release a wait
//! (`apps/desktop/src/main/index.ts:2064-2145`).

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use tokio::sync::oneshot;

/// The most one window gets to answer, before the shared shutdown deadline clamps it.
pub const FLUSH_WINDOW_TIMEOUT: Duration = Duration::from_millis(2000);

#[derive(Default)]
pub struct FlushTable {
    pending: Mutex<HashMap<String, (String, oneshot::Sender<()>)>>,
}

/// An issued request: send `id` to the window, then wait on `reply`.
pub struct FlushTicket {
    pub id: String,
    pub reply: oneshot::Receiver<()>,
}

impl FlushTable {
    /// Registers a request to the window labelled `label`.
    pub fn begin(&self, label: &str) -> FlushTicket {
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, reply) = oneshot::channel();
        self.lock().insert(id.clone(), (label.to_owned(), sender));
        FlushTicket { id, reply }
    }

    /// Settles request `id` when `from` is the window it was sent to. Returns whether it did.
    pub fn complete(&self, from: &str, id: &str) -> bool {
        let mut pending = self.lock();
        match pending.get(id) {
            Some((label, _)) if label == from => {}
            _ => return false,
        }
        pending.remove(id).is_some_and(|(_, sender)| {
            // The waiter may have timed out already; the reply is then moot, not wrong.
            let _ = sender.send(());
            true
        })
    }

    /// Forgets a request whose wait ended without a reply.
    pub fn cancel(&self, id: &str) {
        self.lock().remove(id);
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, (String, oneshot::Sender<()>)>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// How long to wait for a window: the per-window ceiling, clamped to what the deadline leaves.
pub fn wait_for(remaining: Duration) -> Duration {
    FLUSH_WINDOW_TIMEOUT.min(remaining)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_reply_from_the_asked_window_releases_the_wait() {
        let table = FlushTable::default();
        let ticket = table.begin("main");
        assert!(table.complete("main", &ticket.id));
        assert!(ticket.reply.await.is_ok());
        assert!(table.is_empty());
    }

    #[test]
    fn a_reply_from_another_window_or_with_a_wrong_id_is_ignored() {
        let table = FlushTable::default();
        let ticket = table.begin("main");
        assert!(!table.complete("sticky", &ticket.id));
        assert!(!table.complete("main", "not-an-id"));
        assert_eq!(table.len(), 1);
    }

    #[test]
    fn a_reply_settles_a_request_once() {
        let table = FlushTable::default();
        let ticket = table.begin("main");
        assert!(table.complete("main", &ticket.id));
        assert!(!table.complete("main", &ticket.id));
    }

    #[test]
    fn a_cancelled_request_cannot_be_answered() {
        let table = FlushTable::default();
        let ticket = table.begin("main");
        table.cancel(&ticket.id);
        assert!(!table.complete("main", &ticket.id));
    }

    #[test]
    fn the_wait_is_clamped_to_the_deadline() {
        assert_eq!(wait_for(Duration::from_secs(8)), FLUSH_WINDOW_TIMEOUT);
        assert_eq!(
            wait_for(Duration::from_millis(300)),
            Duration::from_millis(300)
        );
        assert_eq!(wait_for(Duration::ZERO), Duration::ZERO);
    }
}
