//! The bounds of Electron's image-processing bridge (`bridge.ts:16-25`) on Tokio's blocking pool:
//! a few requests run at once, at most 256 wait behind them, and a running request has 60 s.
//!
//! Electron frees a timed-out request's slot while its worker keeps working; here the work keeps
//! its slot until it returns, so abandoned work never runs past the concurrency bound. Every
//! operation is bounded (the decode's caps, ffmpeg's own 10 s), so a slot always comes back.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use tokio::sync::Semaphore;

use super::ImageError;

pub(super) struct Pool {
    running: Arc<Semaphore>,
    waiting: AtomicUsize,
    queue_cap: usize,
    timeout: Duration,
}

/// Counts a request in the queue until it starts or its caller gives up.
struct Waiting<'a>(&'a AtomicUsize);

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Pool {
    pub(super) fn new(workers: usize, queue_cap: usize, timeout: Duration) -> Self {
        Self {
            running: Arc::new(Semaphore::new(workers)),
            waiting: AtomicUsize::new(0),
            queue_cap,
            timeout,
        }
    }

    /// Runs `job` on the blocking pool once a worker is free. `Busy` when the queue is full,
    /// `TimedOut` when the job runs past the limit (its result is dropped).
    pub(super) async fn run<T: Send + 'static>(
        &self,
        job: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, ImageError> {
        let permit = match Arc::clone(&self.running).try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                if self.waiting.fetch_add(1, Ordering::SeqCst) >= self.queue_cap {
                    self.waiting.fetch_sub(1, Ordering::SeqCst);
                    tracing::warn!(queued = self.queue_cap, "image processing queue is full");
                    return Err(ImageError::Busy);
                }
                let _waiting = Waiting(&self.waiting);
                Arc::clone(&self.running)
                    .acquire_owned()
                    .await
                    .map_err(|_| ImageError::Failed("image pool closed".to_owned()))?
            }
        };
        let task = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            job()
        });
        match tokio::time::timeout(self.timeout, task).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(ImageError::Failed(error.to_string())),
            Err(_) => {
                tracing::warn!(timeout = ?self.timeout, "image processing request timed out");
                Err(ImageError::TimedOut)
            }
        }
    }
}

#[cfg(test)]
#[path = "pool_tests.rs"]
mod tests;
