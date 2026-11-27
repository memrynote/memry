//! The durable state of attachment sync: the four tables of data migration
//! 0035, one module each, in Electron's shapes so the Electron import (#3553)
//! copies rows unchanged.
//!
//! | Module                | Table                          | Electron owner                       |
//! | --------------------- | ------------------------------ | ------------------------------------ |
//! | [`upload_queue`]      | `attachment_upload_queue`      | `main/sync/attachment-outbox.ts`     |
//! | [`download_failures`] | `attachment_download_failures` | `sync-client/attachment-download-state.ts` |
//! | [`files`]             | `attachment_files`             | `main/sync/attachment-files.ts`      |
//! | [`releases`]          | `deleted_asset_releases`       | `main/sync/deleted-asset-release.ts` |
//!
//! Every function takes the connection and, where a time is written or
//! compared, the time in epoch milliseconds: the caller's clock, so tests drive
//! the retry windows without waiting. A failed read or write is an `Err`, never
//! a silent default; the runners decide whether to fail open (a download check)
//! or skip the pass (a release).
//!
//! `note_id` in two of the tables holds the owner id (a note, canvas or home
//! page id), the name Electron gave the column.

pub mod download_failures;
pub mod files;
pub mod releases;
pub mod upload_queue;

use crate::api::errors::StorageError;

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// `min(base * 2^(attempts - 1), max)`, the backoff of both retry rules.
/// Attempt 0 (never failed) waits nothing.
fn backoff_ms(attempts: u32, base_ms: i64, max_ms: i64) -> i64 {
    match attempts {
        0 => 0,
        n => base_ms
            .checked_mul(1_i64.checked_shl(n - 1).unwrap_or(i64::MAX))
            .map_or(max_ms, |wait| wait.min(max_ms)),
    }
}

/// A count read from an INTEGER column. A negative or oversized value, which
/// no build writes, reads as the nearest bound.
fn attempts_of(raw: i64) -> u32 {
    u32::try_from(raw.max(0)).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests;
