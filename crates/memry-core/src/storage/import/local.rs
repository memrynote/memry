//! Device-local rows of the import that are no sync records: an Inbox capture's tags, its
//! pending file upload and its background jobs (Step 27), and the events of a calendar feed
//! each device fetches itself (spec 007 §5 F1). Nothing here reaches `sync_items` or the outbox.

use rusqlite::params;

use super::{ImportWriter, failed};
use crate::api::errors::StorageError;
use crate::storage::nested_tx;

/// One `inbox_item_tags` row; `created_at` in epoch ms.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportInboxTag {
    pub item_id: String,
    pub tag: String,
    pub created_at: i64,
}

/// One `inbox_attachment_uploads` row: a capture's file still waiting to upload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportInboxUpload {
    pub item_id: String,
    pub created_at: i64,
}

/// One `inbox_jobs` row as `domain::inbox::jobs` stores it; instants in epoch ms.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportInboxJob {
    pub id: String,
    pub item_id: String,
    pub job_type: String,
    pub status: String,
    pub attempts: i64,
    pub max_attempts: i64,
    pub next_run_at: i64,
    pub last_error: Option<String>,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One `calendar_local_events` row: an event of a device-local mirror. Time columns are the
/// verbatim ISO text, JSON columns the stored text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportLocalEvent {
    pub id: String,
    pub source_id: String,
    pub remote_event_id: String,
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub start_at: String,
    pub end_at: Option<String>,
    pub timezone: Option<String>,
    pub is_all_day: bool,
    pub status: String,
    pub recurrence_rule: Option<String>,
    pub attendees: Option<String>,
    pub reminders: Option<String>,
    pub conference_data: Option<String>,
    pub raw_payload: Option<String>,
    pub modified_at: Option<i64>,
}

impl ImportWriter {
    /// Writes `tags` in order and returns how many were stored: a tag already on the item (the
    /// core key ignores case, as Electron's `NOCASE` column compares) keeps the first one.
    pub fn put_inbox_tags(&mut self, tags: &[ImportInboxTag]) -> Result<u64, StorageError> {
        let tx = nested_tx::begin(&self.data).map_err(failed)?;
        let mut stored = 0;
        for tag in tags {
            stored += tx
                .execute(
                    "INSERT OR IGNORE INTO inbox_item_tags (item_id, tag, created_at)
                     VALUES (?1, ?2, ?3)",
                    params![tag.item_id, tag.tag, tag.created_at],
                )
                .map_err(failed)? as u64;
        }
        tx.commit().map_err(failed)?;
        Ok(stored)
    }

    pub fn put_inbox_uploads(&mut self, uploads: &[ImportInboxUpload]) -> Result<(), StorageError> {
        let tx = nested_tx::begin(&self.data).map_err(failed)?;
        for upload in uploads {
            tx.execute(
                "INSERT INTO inbox_attachment_uploads (item_id, created_at) VALUES (?1, ?2)",
                params![upload.item_id, upload.created_at],
            )
            .map_err(failed)?;
        }
        tx.commit().map_err(failed)
    }

    /// Writes `jobs` with no current run (`run_id` NULL). A second job for one (capture, type)
    /// fails the call: the caller keeps one per pair, as `jobs::enqueue` does.
    pub fn put_inbox_jobs(&mut self, jobs: &[ImportInboxJob]) -> Result<(), StorageError> {
        let tx = nested_tx::begin(&self.data).map_err(failed)?;
        for job in jobs {
            tx.execute(
                "INSERT INTO inbox_jobs (id, item_id, type, status, run_id, attempts,
                   max_attempts, next_run_at, last_error, started_at, completed_at, created_at,
                   updated_at)
                 VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    job.id,
                    job.item_id,
                    job.job_type,
                    job.status,
                    job.attempts,
                    job.max_attempts,
                    job.next_run_at,
                    job.last_error,
                    job.started_at,
                    job.completed_at,
                    job.created_at,
                    job.updated_at,
                ],
            )
            .map_err(failed)?;
        }
        tx.commit().map_err(failed)
    }

    pub fn put_local_events(&mut self, events: &[ImportLocalEvent]) -> Result<(), StorageError> {
        let tx = nested_tx::begin(&self.data).map_err(failed)?;
        for e in events {
            tx.execute(
                "INSERT INTO calendar_local_events (id, source_id, remote_event_id, title,
                   description, location, start_at, end_at, timezone, is_all_day, status,
                   recurrence_rule, attendees, reminders, conference_data, raw_payload,
                   modified_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                   ?17)",
                params![
                    e.id,
                    e.source_id,
                    e.remote_event_id,
                    e.title,
                    e.description,
                    e.location,
                    e.start_at,
                    e.end_at,
                    e.timezone,
                    e.is_all_day,
                    e.status,
                    e.recurrence_rule,
                    e.attendees,
                    e.reminders,
                    e.conference_data,
                    e.raw_payload,
                    e.modified_at,
                ],
            )
            .map_err(failed)?;
        }
        tx.commit().map_err(failed)
    }
}
