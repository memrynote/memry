use std::sync::Arc;

use crate::sync::bootstrap::BootstrapClient;

/// The run's bootstrap session, closed once on whichever exit the run takes.
/// A run dropped mid-pass (a cancelled foreign future, an aborted task) cannot
/// await, so the drop hands the close to the runtime.
pub(super) struct OpenSession(pub(super) Option<Arc<BootstrapClient>>);

impl OpenSession {
    pub(super) async fn close(mut self) {
        if let Some(bootstrap) = self.0.take() {
            bootstrap.close().await;
        }
    }
}

impl Drop for OpenSession {
    fn drop(&mut self) {
        let Some(bootstrap) = self.0.take() else {
            return;
        };
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                let unfinished = CloseUnfinished;
                runtime.spawn(async move {
                    bootstrap.close().await;
                    std::mem::forget(unfinished);
                });
            }
            Err(_) => eprintln!(
                "memry-core: a cancelled first sync left its bootstrap session open until expiry: no runtime to close it on"
            ),
        }
    }
}

/// Owned by the close that `drop` hands to the runtime. A runtime that is
/// shutting down drops its tasks, or the future of a task spawned on it, so
/// this guard dropping means the close never finished.
struct CloseUnfinished;

impl Drop for CloseUnfinished {
    fn drop(&mut self) {
        eprintln!(
            "memry-core: a cancelled first sync left its bootstrap session open until expiry: the runtime shut down before the close ran"
        );
    }
}
