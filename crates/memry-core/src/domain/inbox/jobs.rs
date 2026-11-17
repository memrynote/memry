//! The Inbox's background jobs (`apps/desktop/src/main/inbox/jobs.ts`): link
//! metadata, article extraction and voice transcription, kept in
//! `inbox_jobs` so a restart resumes them.
//!
//! Local only: nothing here syncs. One row per (capture, type), as desktop's
//! `upsertJob` keeps one current job per pair. The shell owns time and the
//! work itself: it claims the next due job, runs it, then finishes or fails
//! it. A job runs only while `running`, so a finish or failure that arrives
//! after the job was queued again (a retry the user asked for) changes
//! nothing.

use rusqlite::{Connection, OptionalExtension as _, Row, params};

use crate::api::errors::StorageError;
use crate::domain::notes::failed;

use super::write::mint_id;

/// A job's kind, stored as desktop's `InboxJobType` string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum InboxJobType {
    MetadataScrape,
    ArticleExtract,
    Transcription,
}

impl InboxJobType {
    const ALL: [Self; 3] = [
        Self::MetadataScrape,
        Self::ArticleExtract,
        Self::Transcription,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::MetadataScrape => "metadata-scrape",
            Self::ArticleExtract => "article-extract",
            Self::Transcription => "transcription",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == text)
    }

    /// Desktop's defaults: `queueInboxMetadataJob` and
    /// `queueInboxArticleExtractJob` allow 2 attempts, transcription 1.
    pub fn max_attempts(self) -> i64 {
        match self {
            Self::MetadataScrape | Self::ArticleExtract => 2,
            Self::Transcription => 1,
        }
    }
}

/// A job's lifecycle state (`InboxJobStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum InboxJobStatus {
    Pending,
    Running,
    Complete,
    Failed,
}

impl InboxJobStatus {
    const ALL: [Self; 4] = [Self::Pending, Self::Running, Self::Complete, Self::Failed];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Complete => "complete",
            Self::Failed => "failed",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|status| status.as_str() == text)
    }
}

/// One `inbox_jobs` row. Instants are epoch milliseconds.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct InboxJob {
    pub id: String,
    pub item_id: String,
    pub job_type: InboxJobType,
    pub status: InboxJobStatus,
    pub attempts: i64,
    pub max_attempts: i64,
    pub next_run_at: i64,
    pub last_error: Option<String>,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

const COLUMNS: &str = "id, item_id, type, status, attempts, max_attempts, next_run_at, \
     last_error, started_at, completed_at, created_at, updated_at";

/// A row a newer build wrote with a type or status this build does not know
/// is skipped rather than misread.
fn job_row(row: &Row<'_>) -> rusqlite::Result<Option<InboxJob>> {
    let kind: String = row.get(2)?;
    let status: String = row.get(3)?;
    let (Some(job_type), Some(status)) =
        (InboxJobType::parse(&kind), InboxJobStatus::parse(&status))
    else {
        return Ok(None);
    };
    Ok(Some(InboxJob {
        id: row.get(0)?,
        item_id: row.get(1)?,
        job_type,
        status,
        attempts: row.get(4)?,
        max_attempts: row.get(5)?,
        next_run_at: row.get(6)?,
        last_error: row.get(7)?,
        started_at: row.get(8)?,
        completed_at: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    }))
}

fn by_id(conn: &Connection, id: &str) -> Result<Option<InboxJob>, StorageError> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM inbox_jobs WHERE id = ?1"),
        params![id],
        job_row,
    )
    .optional()
    .map(Option::flatten)
    .map_err(failed)
}

fn require(conn: &Connection, id: &str) -> Result<InboxJob, StorageError> {
    by_id(conn, id)?.ok_or_else(|| StorageError::NotFound {
        what: format!("no inbox job {id}"),
    })
}

/// `queueInbox*Job`: the (capture, type) job, pending and due at `now_ms`,
/// with its attempts reset. A job already there keeps its id.
pub fn enqueue(
    conn: &Connection,
    item_id: &str,
    job_type: InboxJobType,
    now_ms: i64,
) -> Result<InboxJob, StorageError> {
    conn.execute(
        "INSERT INTO inbox_jobs (id, item_id, type, status, attempts, max_attempts,
                                 next_run_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'pending', 0, ?4, ?5, ?5, ?5)
         ON CONFLICT (item_id, type) DO UPDATE SET
           status = 'pending', attempts = 0, max_attempts = excluded.max_attempts,
           next_run_at = excluded.next_run_at, last_error = NULL, started_at = NULL,
           completed_at = NULL, updated_at = excluded.updated_at",
        params![
            mint_id(),
            item_id,
            job_type.as_str(),
            job_type.max_attempts(),
            now_ms
        ],
    )
    .map_err(failed)?;
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM inbox_jobs WHERE item_id = ?1 AND type = ?2"),
        params![item_id, job_type.as_str()],
        job_row,
    )
    .map_err(failed)?
    .ok_or_else(|| StorageError::Failed {
        what: "the queued inbox job did not read back".to_owned(),
    })
}

/// The earliest pending job due at `now_ms`, marked `running` with one more
/// attempt (`processInboxJob`); `None` when nothing is due.
pub fn claim_next(conn: &Connection, now_ms: i64) -> Result<Option<InboxJob>, StorageError> {
    let known = known_types();
    let id: Option<String> = conn
        .query_row(
            &format!(
                "SELECT id FROM inbox_jobs
                  WHERE status = 'pending' AND next_run_at <= ?1 AND type IN ({known})
                  ORDER BY next_run_at, created_at, id LIMIT 1"
            ),
            params![now_ms],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    let Some(id) = id else {
        return Ok(None);
    };
    conn.execute(
        "UPDATE inbox_jobs SET status = 'running', attempts = attempts + 1,
                started_at = ?2, completed_at = NULL, last_error = NULL, updated_at = ?2
          WHERE id = ?1",
        params![id, now_ms],
    )
    .map_err(failed)?;
    by_id(conn, &id)
}

/// `completeJob`. `None` when the job is no longer running (it was queued
/// again meanwhile), and then nothing changes.
pub fn finish(conn: &Connection, id: &str, now_ms: i64) -> Result<Option<InboxJob>, StorageError> {
    let changed = conn
        .execute(
            "UPDATE inbox_jobs SET status = 'complete', last_error = NULL,
                    completed_at = ?2, updated_at = ?2
              WHERE id = ?1 AND status = 'running'",
            params![id, now_ms],
        )
        .map_err(failed)?;
    if changed == 0 {
        require(conn, id)?;
        return Ok(None);
    }
    by_id(conn, id)
}

/// A run failed with `error`: pending again `retry_delay_ms` from `now_ms`
/// while attempts remain (`rescheduleJob`), else `failed` (`failJob`). `None`
/// when the job is no longer running, and then nothing changes.
pub fn fail(
    conn: &Connection,
    id: &str,
    error: &str,
    retry_delay_ms: i64,
    now_ms: i64,
) -> Result<Option<InboxJob>, StorageError> {
    let changed = conn
        .execute(
            "UPDATE inbox_jobs SET
                    status = CASE WHEN attempts < max_attempts THEN 'pending' ELSE 'failed' END,
                    next_run_at = CASE WHEN attempts < max_attempts THEN ?4 ELSE next_run_at END,
                    started_at = CASE WHEN attempts < max_attempts THEN NULL ELSE started_at END,
                    completed_at = CASE WHEN attempts < max_attempts THEN NULL ELSE ?3 END,
                    last_error = ?2, updated_at = ?3
              WHERE id = ?1 AND status = 'running'",
            params![
                id,
                error,
                now_ms,
                now_ms.saturating_add(retry_delay_ms.max(0))
            ],
        )
        .map_err(failed)?;
    if changed == 0 {
        require(conn, id)?;
        return Ok(None);
    }
    by_id(conn, id)
}

/// `listInboxJobs`: jobs of `item_ids` (all when empty) in `statuses` (all
/// when empty), soonest first.
pub fn list(
    conn: &Connection,
    item_ids: &[String],
    statuses: &[InboxJobStatus],
) -> Result<Vec<InboxJob>, StorageError> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM inbox_jobs
              WHERE (?1 = '[]' OR item_id IN (SELECT value FROM json_each(?1)))
                AND (?2 = '[]' OR status IN (SELECT value FROM json_each(?2)))
              ORDER BY next_run_at, created_at, id"
        ))
        .map_err(failed)?;
    let ids = serde_json::to_string(item_ids).map_err(|e| StorageError::Failed {
        what: e.to_string(),
    })?;
    let statuses: Vec<&str> = statuses.iter().map(|s| s.as_str()).collect();
    let statuses = serde_json::to_string(&statuses).map_err(|e| StorageError::Failed {
        what: e.to_string(),
    })?;
    let rows = statement
        .query_map(params![ids, statuses], job_row)
        .map_err(failed)?;
    let mut jobs = Vec::new();
    for row in rows {
        if let Some(job) = row.map_err(failed)? {
            jobs.push(job);
        }
    }
    Ok(jobs)
}

/// What [`resume`] did at vault open.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, uniffi::Record)]
pub struct InboxJobsResumed {
    /// `running` jobs a quit or crash interrupted, pending again.
    pub requeued: u32,
    /// Interrupted jobs already run past their attempts, now `failed`, so a
    /// job that takes the app down cannot loop forever.
    pub exhausted: u32,
    /// Jobs whose capture is deleted or gone, removed.
    pub dropped: u32,
}

/// `resumeInboxJobs`, run before the runner starts: an interrupted job is
/// pending again with its attempts kept, and a job whose capture is gone is
/// removed.
///
/// Desktop re-runs an interrupted job however often it was interrupted. Here
/// a quit mid-run still gets one more run past `max_attempts` (a
/// transcription allows one attempt, and quitting must not cost it), but a
/// job interrupted again after that is `failed`.
pub fn resume(conn: &Connection, now_ms: i64) -> Result<InboxJobsResumed, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let dropped = tx
        .execute(
            "DELETE FROM inbox_jobs WHERE NOT EXISTS (
               SELECT 1 FROM inbox_items i
                WHERE i.id = inbox_jobs.item_id AND i.deleted_at IS NULL)",
            [],
        )
        .map_err(failed)?;
    let exhausted = tx
        .execute(
            "UPDATE inbox_jobs SET status = 'failed', completed_at = ?1, updated_at = ?1,
                    last_error = 'Interrupted before it finished.'
              WHERE status = 'running' AND attempts > max_attempts",
            params![now_ms],
        )
        .map_err(failed)?;
    let requeued = tx
        .execute(
            "UPDATE inbox_jobs SET status = 'pending', started_at = NULL, updated_at = ?1
              WHERE status = 'running'",
            params![now_ms],
        )
        .map_err(failed)?;
    tx.commit().map_err(failed)?;
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    Ok(InboxJobsResumed {
        requeued: count(requeued),
        exhausted: count(exhausted),
        dropped: count(dropped),
    })
}

/// When the next pending job is due, for the runner's sleep; `None` when
/// nothing is pending.
pub fn next_due(conn: &Connection) -> Result<Option<i64>, StorageError> {
    let known = known_types();
    conn.query_row(
        &format!(
            "SELECT min(next_run_at) FROM inbox_jobs
              WHERE status = 'pending' AND type IN ({known})"
        ),
        [],
        |row| row.get(0),
    )
    .map_err(failed)
}

fn known_types() -> String {
    InboxJobType::ALL
        .iter()
        .map(|kind| format!("'{}'", kind.as_str()))
        .collect::<Vec<_>>()
        .join(", ")
}
