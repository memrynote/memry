//! The device-local run state of `sync-state.ts`, over `readwise_run_state` (data migration
//! 0038). Keys and value text are desktop's (`readwise.<key>` there), so Step 36 copies the
//! rows unchanged. A value that does not parse costs a retry or a display, never a note: it is
//! logged and read as absent, as desktop does.

use memry_core::api::errors::StorageError;
use memry_core::api::readwise::ReadwiseStore;
use serde::{Deserialize, Serialize};

const CURSOR: &str = "cursor";
const RETRY_LIST: &str = "retryList";
const FULL_PASS: &str = "fullPass";
const LAST_RUN: &str = "lastRun";
const LAST_FULL_READ: &str = "lastFullRead";
const ERROR_TOAST: &str = "errorToastShown";

const SCOPE: &str = "ReadwiseState";

/// A book the next run fetches by id (`RetryEntry`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryEntry {
    pub readwise_book_id: i64,
    pub reason: String,
    pub attempts: u32,
}

/// `ReadwiseRunCounts`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunCounts {
    pub books: u64,
    pub added: u64,
    pub updated: u64,
    pub appended: u64,
    pub deferred: u64,
    pub failed: u64,
    pub highlights: u64,
}

/// The error that parked the schedule (`AttentionKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Attention {
    InvalidToken,
    SubscriptionExpired,
}

/// `LastRun`. `attention` and `counts` are absent in a value an older build wrote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastRun {
    pub at: String,
    pub needs_attention: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention: Option<Attention>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub counts: Option<RunCounts>,
}

/// The run state of the open vault.
pub struct RunState {
    store: ReadwiseStore,
}

impl RunState {
    pub fn new(store: ReadwiseStore) -> Self {
        Self { store }
    }

    fn get(&self, key: &str) -> Result<Option<String>, StorageError> {
        self.store.run_state(key)
    }

    fn set(&self, key: &str, value: Option<&str>) -> Result<(), StorageError> {
        self.store.set_run_state(key, value)
    }

    fn json<T: for<'de> Deserialize<'de>>(&self, key: &str) -> Result<Option<T>, StorageError> {
        let Some(raw) = self.get(key)? else {
            return Ok(None);
        };
        match serde_json::from_str(&raw) {
            Ok(value) => Ok(Some(value)),
            Err(error) => {
                tracing::warn!(scope = SCOPE, key, "dropping an unreadable Readwise {key}: {error}");
                Ok(None)
            }
        }
    }

    fn put_json<T: Serialize>(&self, key: &str, value: &T) -> Result<(), StorageError> {
        let text = serde_json::to_string(value).map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })?;
        self.set(key, Some(&text))
    }

    /// The newest highlight `updated_at` the last completed run applied, minus one second.
    pub fn cursor(&self) -> Result<Option<String>, StorageError> {
        self.get(CURSOR)
    }

    pub fn set_cursor(&self, cursor: &str) -> Result<(), StorageError> {
        self.set(CURSOR, Some(cursor))
    }

    pub fn retry_list(&self) -> Result<Vec<RetryEntry>, StorageError> {
        let list: Option<Vec<RetryEntry>> = self.json(RETRY_LIST)?;
        // `z.number().int().min(1)`: a list with a zero count does not parse in desktop either.
        Ok(match list {
            Some(list) if list.iter().all(|entry| entry.attempts >= 1) => list,
            Some(_) => {
                tracing::warn!(scope = SCOPE, "dropping an unreadable Readwise retryList");
                Vec::new()
            }
            None => Vec::new(),
        })
    }

    /// `addRetry`: lists the book, or bumps its attempts and reason when it is listed.
    pub fn add_retry(&self, book_id: i64, reason: &str) -> Result<(), StorageError> {
        let mut list = self.retry_list()?;
        match list.iter_mut().find(|entry| entry.readwise_book_id == book_id) {
            Some(entry) => {
                entry.reason = reason.to_owned();
                entry.attempts = entry.attempts.saturating_add(1);
            }
            None => list.push(RetryEntry {
                readwise_book_id: book_id,
                reason: reason.to_owned(),
                attempts: 1,
            }),
        }
        self.put_json(RETRY_LIST, &list)
    }

    /// `removeRetry`; the key goes with the last entry.
    pub fn remove_retry(&self, book_id: i64) -> Result<(), StorageError> {
        let mut list = self.retry_list()?;
        let before = list.len();
        list.retain(|entry| entry.readwise_book_id != book_id);
        match (list.is_empty(), list.len() == before) {
            (true, _) => self.set(RETRY_LIST, None),
            (false, true) => Ok(()),
            (false, false) => self.put_json(RETRY_LIST, &list),
        }
    }

    /// A category or the Reader switch went on: the next run reads the whole export.
    pub fn full_pass_pending(&self) -> Result<bool, StorageError> {
        Ok(self.get(FULL_PASS)?.as_deref() == Some("true"))
    }

    pub fn set_full_pass_pending(&self, pending: bool) -> Result<(), StorageError> {
        self.set(FULL_PASS, pending.then_some("true"))
    }

    /// When a run last read the whole export, ISO on this device's clock.
    pub fn last_full_read(&self) -> Result<Option<String>, StorageError> {
        self.get(LAST_FULL_READ)
    }

    pub fn set_last_full_read(&self, at: &str) -> Result<(), StorageError> {
        self.set(LAST_FULL_READ, Some(at))
    }

    pub fn last_run(&self) -> Result<Option<LastRun>, StorageError> {
        self.json(LAST_RUN)
    }

    /// `setLastRun`: a run that needs no attention ends the error episode, so the next one
    /// may show its toast again (D19).
    pub fn set_last_run(&self, run: &LastRun) -> Result<(), StorageError> {
        self.put_json(LAST_RUN, run)?;
        match run.needs_attention {
            true => Ok(()),
            false => self.set(ERROR_TOAST, None),
        }
    }
}
