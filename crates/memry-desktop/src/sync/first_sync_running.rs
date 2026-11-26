//! Whether the open vault's first sync is running (#5409). The note index holds its core search
//! reindex while one is: that reindex holds the `data.db` writer for its whole pass (~50 s on a
//! 17k-note vault), and the first sync's bodies pass waits on the same writer.

use std::sync::Arc;

use tokio::sync::watch;

/// One per open vault ([`crate::session::OpenVault`]); clones share it. Sync holds it around the
/// first sync, the note index reads it.
#[derive(Clone)]
pub struct FirstSyncRunning(Arc<watch::Sender<u32>>);

impl Default for FirstSyncRunning {
    fn default() -> Self {
        Self(Arc::new(watch::Sender::new(0)))
    }
}

impl FirstSyncRunning {
    /// Running until the hold drops: a first sync that fails, or a pass the loop cuts, lets go.
    #[must_use]
    pub fn hold(&self) -> FirstSyncHold {
        self.0.send_modify(|holds| *holds += 1);
        FirstSyncHold(self.clone())
    }

    pub fn is_running(&self) -> bool {
        *self.0.borrow() > 0
    }

    /// Told each time a first sync starts or ends.
    pub fn subscribe(&self) -> watch::Receiver<u32> {
        self.0.subscribe()
    }
}

/// A first sync running; see [`FirstSyncRunning::hold`].
pub struct FirstSyncHold(FirstSyncRunning);

impl Drop for FirstSyncHold {
    fn drop(&mut self) {
        self.0
            .0
            .send_modify(|holds| *holds = holds.saturating_sub(1));
    }
}
