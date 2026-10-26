//! A bounded queue with a crash-durable mirror and one sender, the shape both the event queue
//! and the log queue take (`ship-queue.ts`): at most 500 items, a flush ships the oldest 50, a
//! 4xx other than 429 drops the batch (a permanently rejected head would wedge the queue), and
//! anything else keeps it. Turning it off empties it and removes the mirror.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use serde::de::DeserializeOwned;

use super::journal::Journal;
use super::service::{FlushReason, FlushResult, Sender};

pub const QUEUE_LIMIT: usize = 500;
pub const BATCH_LIMIT: usize = 50;

struct Inner<T> {
    items: Vec<T>,
    journal: Journal,
    enabled: bool,
}

pub struct ShipQueue<T> {
    inner: Mutex<Inner<T>>,
    sender: Sender,
}

impl<T: Serialize + DeserializeOwned + Clone> ShipQueue<T> {
    /// Restores what the previous process left in the mirror. Off, it removes the mirror.
    pub fn restore(path: PathBuf, sender: Sender, enabled: bool) -> Self {
        let mut journal = Journal::new(path);
        let mut items = Vec::new();
        if enabled {
            items = journal.load::<T>();
            if items.len() > QUEUE_LIMIT {
                items.drain(..items.len() - QUEUE_LIMIT);
                journal.save(&items);
            }
        } else {
            journal.clear();
        }
        Self {
            inner: Mutex::new(Inner {
                items,
                journal,
                enabled,
            }),
            sender,
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner<T>> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn depth(&self) -> usize {
        self.lock().items.len()
    }

    pub fn is_enabled(&self) -> bool {
        self.lock().enabled
    }

    pub fn items(&self) -> Vec<T> {
        self.lock().items.clone()
    }

    pub fn set_enabled(&self, enabled: bool) {
        let mut inner = self.lock();
        inner.enabled = enabled;
        if !enabled {
            inner.items.clear();
            inner.journal.clear();
        }
    }

    pub fn push(&self, item: T) {
        let mut inner = self.lock();
        if !inner.enabled {
            return;
        }
        inner.items.push(item.clone());
        let over = inner.items.len().saturating_sub(QUEUE_LIMIT);
        if over > 0 {
            inner.items.drain(..over);
        }
        let Inner { journal, items, .. } = &mut *inner;
        journal.append(&item, items);
    }

    /// Ships the oldest batch. `body` turns the batch and the queue depth into the request body.
    /// The lock is not held across the request.
    pub async fn flush(
        &self,
        reason: FlushReason,
        body: impl FnOnce(&[T], usize) -> Result<String, serde_json::Error>,
    ) -> FlushResult {
        let (text, size) = {
            let inner = self.lock();
            if !inner.enabled || inner.items.is_empty() {
                return FlushResult::idle();
            }
            let size = inner.items.len().min(BATCH_LIMIT);
            match body(&inner.items[..size], inner.items.len()) {
                Ok(text) => (text, size),
                Err(error) => return FlushResult::failed(size, error.to_string()),
            }
        };
        match self.sender.post(text).await {
            Ok(status) if (200..300).contains(&status) => {
                self.drop_front(size);
                tracing::info!(
                    scope = "Telemetry",
                    "batch accepted: {size} items (HTTP {status})"
                );
                FlushResult {
                    success: true,
                    attempted: size,
                    accepted: size,
                    error: None,
                }
            }
            Ok(status) => {
                let permanent = (400..500).contains(&status) && status != 429;
                if permanent {
                    self.drop_front(size);
                }
                tracing::warn!(
                    scope = "Telemetry",
                    "batch rejected: status={status} reason={reason:?} dropped={permanent}"
                );
                FlushResult::failed(size, format!("HTTP {status}"))
            }
            Err(error) => {
                tracing::warn!(
                    scope = "Telemetry",
                    "flush failed: reason={reason:?} {error}"
                );
                FlushResult::failed(size, error)
            }
        }
    }

    fn drop_front(&self, count: usize) {
        let mut inner = self.lock();
        let count = count.min(inner.items.len());
        inner.items.drain(..count);
        let Inner { journal, items, .. } = &mut *inner;
        journal.save(items);
    }
}
