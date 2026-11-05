//! The pending table of the flush handshake: main asks a window to write its unsaved edits and
//! waits for that window's reply. A reply counts only from the window that was asked, with the
//! id that was issued, so a stale or foreign reply cannot release a wait
//! (`apps/desktop/src/main/index.ts:2064-2145`).
//!
//! A window is asked only while its page listens: from the page's own report that it subscribed
//! until its document is replaced or its process dies. A page that is still loading holds no edits
//! and would miss the request, so a quit during a launch or a reload waited the whole timeout for
//! it (#3967). A page that loses its process can never answer either: the OS ends the webview's
//! processes at a session end while the app is still flushing. The table then releases the waits
//! on that window at once instead of letting each one run to its timeout.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use tokio::sync::oneshot;

/// The most one window gets to answer, before the shared shutdown deadline clamps it.
pub const FLUSH_WINDOW_TIMEOUT: Duration = Duration::from_millis(2000);

#[derive(Default)]
pub struct FlushTable {
    state: Mutex<TableState>,
}

#[derive(Default)]
struct TableState {
    /// Request id to the asked window's label and the waiter.
    pending: HashMap<String, (String, oneshot::Sender<()>)>,
    /// Windows whose page subscribed to flush requests.
    listening: HashSet<String>,
}

/// An issued request: send `id` to the window, then wait on `reply`. `reply` fails when the
/// window's page lost its process before answering.
pub struct FlushTicket {
    pub id: String,
    pub reply: oneshot::Receiver<()>,
}

impl FlushTable {
    /// Registers a request to the window labelled `label`. `None` when that window's page does not
    /// listen, so nobody could answer.
    pub fn begin(&self, label: &str) -> Option<FlushTicket> {
        let mut state = self.lock();
        if !state.listening.contains(label) {
            return None;
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, reply) = oneshot::channel();
        state.pending.insert(id.clone(), (label.to_owned(), sender));
        Some(FlushTicket { id, reply })
    }

    /// Settles request `id` when `from` is the window it was sent to. Returns whether it did.
    pub fn complete(&self, from: &str, id: &str) -> bool {
        let mut state = self.lock();
        match state.pending.get(id) {
            Some((label, _)) if label == from => {}
            _ => return false,
        }
        state.pending.remove(id).is_some_and(|(_, sender)| {
            // The waiter may have timed out already; the reply is then moot, not wrong.
            let _ = sender.send(());
            true
        })
    }

    /// Forgets a request whose wait ended without a reply.
    pub fn cancel(&self, id: &str) {
        self.lock().pending.remove(id);
    }

    /// The page of window `label` lost its process or its document: every wait on it ends now,
    /// and requests are refused until [`FlushTable::page_listening`]. Returns how many waits it
    /// ended.
    pub fn page_gone(&self, label: &str) -> usize {
        let mut state = self.lock();
        state.listening.remove(label);
        let before = state.pending.len();
        // Dropping a sender fails its receiver, which is what ends the wait.
        state.pending.retain(|_, (asked, _)| asked != label);
        before - state.pending.len()
    }

    /// The page of window `label` subscribed to flush requests and can answer.
    pub fn page_listening(&self, label: &str) {
        self.lock().listening.insert(label.to_owned());
    }

    /// Whether a request to window `label` would be sent.
    pub fn is_listening(&self, label: &str) -> bool {
        self.lock().listening.contains(label)
    }

    pub fn len(&self) -> usize {
        self.lock().pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.lock().pending.is_empty()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, TableState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The app pages each webview browser process hosts, so that the process's exit marks exactly
/// those pages gone. A destroyed window is forgotten; otherwise its label would be marked gone
/// when the browser ends, long after the window closed.
#[derive(Default)]
pub struct BrowserPages {
    hosted: Mutex<HashMap<u32, HashSet<String>>>,
}

impl BrowserPages {
    /// Records that browser process `pid` hosts page `label`. True the first time `pid` is seen,
    /// when nothing watches its exit yet.
    pub fn host(&self, pid: u32, label: &str) -> bool {
        let mut hosted = self.lock();
        let first = !hosted.contains_key(&pid);
        hosted.entry(pid).or_default().insert(label.to_owned());
        first
    }

    /// Window `label` was destroyed. A browser left with no page stays recorded, since its exit
    /// is still watched.
    pub fn forget(&self, label: &str) {
        for pages in self.lock().values_mut() {
            pages.remove(label);
        }
    }

    /// Browser process `pid` ended, or its exit cannot be watched: the pages it still hosted.
    pub fn ended(&self, pid: u32) -> HashSet<String> {
        self.lock().remove(&pid).unwrap_or_default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u32, HashSet<String>>> {
        self.hosted.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// How long to wait for a window: the per-window ceiling, clamped to what the deadline leaves.
pub fn wait_for(remaining: Duration) -> Duration {
    FLUSH_WINDOW_TIMEOUT.min(remaining)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A table whose `labels` pages listen.
    fn listening(labels: &[&str]) -> FlushTable {
        let table = FlushTable::default();
        for label in labels {
            table.page_listening(label);
        }
        table
    }

    #[tokio::test]
    async fn a_reply_from_the_asked_window_releases_the_wait() {
        let table = listening(&["main"]);
        let ticket = table.begin("main").unwrap();
        assert!(table.complete("main", &ticket.id));
        assert!(ticket.reply.await.is_ok());
        assert!(table.is_empty());
    }

    #[test]
    fn a_reply_from_another_window_or_with_a_wrong_id_is_ignored() {
        let table = listening(&["main", "sticky"]);
        let ticket = table.begin("main").unwrap();
        assert!(!table.complete("sticky", &ticket.id));
        assert!(!table.complete("main", "not-an-id"));
        assert_eq!(table.len(), 1);
    }

    #[test]
    fn a_reply_settles_a_request_once() {
        let table = listening(&["main"]);
        let ticket = table.begin("main").unwrap();
        assert!(table.complete("main", &ticket.id));
        assert!(!table.complete("main", &ticket.id));
    }

    #[test]
    fn a_cancelled_request_cannot_be_answered() {
        let table = listening(&["main"]);
        let ticket = table.begin("main").unwrap();
        table.cancel(&ticket.id);
        assert!(!table.complete("main", &ticket.id));
    }

    #[test]
    fn a_page_that_loses_its_process_ends_the_waits_on_it_at_once() {
        use tokio::sync::oneshot::error::TryRecvError;
        let table = listening(&["main", "sticky"]);
        let mut first = table.begin("main").unwrap();
        let mut second = table.begin("main").unwrap();
        let mut other = table.begin("sticky").unwrap();
        assert_eq!(table.page_gone("main"), 2);
        // Already failed, without waiting for anything.
        assert_eq!(first.reply.try_recv(), Err(TryRecvError::Closed));
        assert_eq!(second.reply.try_recv(), Err(TryRecvError::Closed));
        // Another window's request still waits for its own answer.
        assert_eq!(other.reply.try_recv(), Err(TryRecvError::Empty));
        assert!(table.complete("sticky", &other.id));
        assert_eq!(other.reply.try_recv(), Ok(()));
    }

    #[test]
    fn a_page_is_not_asked_before_it_listens() {
        // A launch or a reload: the page is loading and has not subscribed yet.
        let table = FlushTable::default();
        assert!(table.begin("main").is_none());
        assert!(table.is_empty());
        table.page_listening("main");
        assert!(table.begin("main").is_some());
    }

    #[test]
    fn a_gone_page_is_not_asked_until_its_next_document_listens() {
        let table = listening(&["main", "sticky"]);
        table.page_gone("main");
        assert!(!table.is_listening("main"));
        assert!(table.begin("main").is_none());
        assert!(table.begin("sticky").is_some());
        table.page_listening("main");
        assert!(table.begin("main").is_some());
    }

    #[test]
    fn a_browser_that_ends_releases_the_pages_it_hosts() {
        let pages = BrowserPages::default();
        assert!(pages.host(7, "main"));
        assert!(!pages.host(7, "e2e-1"));
        assert!(pages.host(9, "sticky"));
        let ended = pages.ended(7);
        assert_eq!(
            ended,
            HashSet::from(["main".to_owned(), "e2e-1".to_owned()])
        );
        // A browser seen again after its exit is watched again.
        assert!(pages.host(7, "main"));
    }

    #[test]
    fn a_destroyed_window_is_not_released_when_its_browser_ends() {
        let pages = BrowserPages::default();
        pages.host(7, "main");
        pages.host(7, "e2e-1");
        pages.forget("e2e-1");
        // Its exit is still watched: the browser hosts `main`.
        assert!(!pages.host(7, "main"));
        assert_eq!(pages.ended(7), HashSet::from(["main".to_owned()]));
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
