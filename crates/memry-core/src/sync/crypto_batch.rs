//! Envelope opens, signature checks and seals over a page run on
//! `spawn_blocking`, never on a runtime worker (#3534): a 500-record page or a
//! body backlog is CPU work long enough to stall the socket and the timers
//! that share the runtime.

use crate::api::errors::StorageError;

/// Runs `work` on the blocking pool. A panic inside it is reported as a
/// storage failure naming `what`, so the pass fails visibly.
pub(crate) async fn off_runtime<T: Send + 'static>(
    what: &'static str,
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, StorageError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| StorageError::Failed {
            what: format!("{what} failed: {error}"),
        })
}
