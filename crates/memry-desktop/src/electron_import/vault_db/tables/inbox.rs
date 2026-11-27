//! Stage 36d1, the Inbox: `inbox_items` as `inbox-handler.ts:161-169` pushes it (the drizzle
//! row itself, `JSON.stringify(item)`), and the device-local rows of a capture: its tags, its
//! pending file upload and its background jobs. Also the column map the record payloads of this
//! stage share ([`payload`]).

use memry_core::storage::import::{
    ImportInboxJob, ImportInboxTag, ImportInboxUpload, ImportRecord,
};
use memry_core::storage::repositories::instants::to_epoch_ms;
use rusqlite::Row;
use serde_json::{Map, Value};

use super::js_json;
use super::records::{malformed, records};
use super::row_dumps::{column, json_column, synced_at};
use super::tags::drizzle_bool;
use super::{SourceDb, TableStats};
use crate::electron_import::vault_db::source::source_error;
use crate::electron_import::vault_db::{ImportError, TableCtx, read_source_id};

/// How a payload key reads its column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    /// The value as better-sqlite3 hands it over (`?? null` included).
    Plain,
    /// A drizzle `mode: 'json'` column.
    Json,
    /// A `mode: 'json'` column sent as `?? undefined`: the key is left out when it is null.
    JsonOrAbsent,
    /// A drizzle `mode: 'boolean'` column.
    Bool,
}

/// `(payload key, column, kind)` in the order the payload writes them.
pub(super) type Columns = &'static [(&'static str, &'static str, Kind)];

/// The payload `columns` describe, for one source row.
pub(super) fn payload(
    row: &Row<'_>,
    columns: Columns,
    table: &'static str,
    rowid: i64,
) -> Result<Map<String, Value>, ImportError> {
    let mut payload = Map::new();
    for (key, name, kind) in columns {
        let value = match kind {
            Kind::Plain => column(row, name, table, rowid)?,
            Kind::Json | Kind::JsonOrAbsent => json_column(row, name, table, rowid)?,
            Kind::Bool => drizzle_bool(column(row, name, table, rowid)?),
        };
        if *kind == Kind::JsonOrAbsent && value.is_null() {
            continue;
        }
        payload.insert((*key).into(), value);
    }
    Ok(payload)
}

/// `SELECT rowid, id, synced_at, <columns> FROM <table>`, `extra` appended. A handler payload
/// without them still names the record and its projection time by them.
pub(super) fn select(table: &str, columns: Columns, extra: &str) -> String {
    let names: Vec<&str> = columns.iter().map(|(_, column, _)| *column).collect();
    format!(
        "SELECT rowid, id, synced_at, {} FROM {table} {extra}",
        names.join(", ")
    )
}

/// Every record of `table`: the payload of `columns`, stringified as V8 does.
pub(super) fn payload_records(
    ctx: &mut TableCtx<'_>,
    table: &'static str,
    item_type: &'static str,
    columns: Columns,
    extra: &str,
) -> Result<TableStats, ImportError> {
    records(ctx, &select(table, columns, extra), |row, rowid| {
        Ok(ImportRecord {
            item_type,
            item_id: read_source_id(row, SourceDb::Data, table, "id")?,
            payload: js_json::stringify(&Value::Object(payload(row, columns, table, rowid)?)),
            synced_at: synced_at(row, table, rowid)?,
        })
    })
}

/// The `inbox_items` columns in schema order (`packages/db-schema/src/schema/inbox.ts`).
const INBOX_COLUMNS: Columns = &[
    ("id", "id", Kind::Plain),
    ("type", "type", Kind::Plain),
    ("title", "title", Kind::Plain),
    ("content", "content", Kind::Plain),
    ("createdAt", "created_at", Kind::Plain),
    ("modifiedAt", "modified_at", Kind::Plain),
    ("filedAt", "filed_at", Kind::Plain),
    ("filedTo", "filed_to", Kind::Plain),
    ("filedAction", "filed_action", Kind::Plain),
    ("snoozedUntil", "snoozed_until", Kind::Plain),
    ("snoozeReason", "snooze_reason", Kind::Plain),
    ("viewedAt", "viewed_at", Kind::Plain),
    ("processingStatus", "processing_status", Kind::Plain),
    ("processingError", "processing_error", Kind::Plain),
    ("metadata", "metadata", Kind::Json),
    ("attachmentPath", "attachment_path", Kind::Plain),
    ("thumbnailPath", "thumbnail_path", Kind::Plain),
    ("attachmentId", "attachment_id", Kind::Plain),
    ("transcription", "transcription", Kind::Plain),
    ("transcriptionStatus", "transcription_status", Kind::Plain),
    ("sourceUrl", "source_url", Kind::Plain),
    ("sourceTitle", "source_title", Kind::Plain),
    ("captureSource", "capture_source", Kind::Plain),
    ("archivedAt", "archived_at", Kind::Plain),
    ("clock", "clock", Kind::Json),
    ("syncedAt", "synced_at", Kind::Plain),
    ("localOnly", "local_only", Kind::Bool),
];

/// A local-only capture is never pushed (`buildPushPayload` returns null), and the core Inbox
/// has no local-only capture to keep one off the server, so the import refuses the vault rather
/// than let its next edit sync it. No Electron writer sets the flag.
pub fn inbox_items(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    const TABLE: &str = "inbox_items";
    let local_only: Option<i64> = ctx
        .source
        .query_row(
            "SELECT rowid FROM inbox_items WHERE local_only = 1 LIMIT 1",
            [],
            |row| row.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            e => Err(source_error(SourceDb::Data, e)),
        })?;
    if let Some(rowid) = local_only {
        return Err(malformed(
            TABLE,
            rowid,
            "a local-only inbox item, which this build cannot keep off the sync server",
        ));
    }
    // `recoverDirtyInbox` (`dirty-recovery.ts:224-248`) and `seedUnclocked`
    // (`inbox-handler.ts:176-193`).
    refuse_unreplayed(
        ctx,
        TABLE,
        "local_only IS NOT 1 AND (clock IS NULL OR synced_at IS NULL OR modified_at > synced_at)",
    )?;
    payload_records(ctx, TABLE, "inbox", INBOX_COLUMNS, "")
}

/// Electron re-pushes some rows at every start: its dirty sweeps (`dirty-recovery.ts`) and the
/// seed of unclocked rows (`seedUnclocked`). The import has no replay for this stage's types
/// yet (it lands with stage 36c2's `replay.rs`), and an imported vault is converted once, so a
/// vault holding such a row is refused instead of staged without its push. Without a sync
/// device the previous app never signed in, and only signing in there sends the rows.
/// `condition` is Electron's predicate, as SQL over `table`.
pub(super) fn refuse_unreplayed(
    ctx: &TableCtx<'_>,
    table: &'static str,
    condition: &str,
) -> Result<(), ImportError> {
    let owed = source_rows(
        ctx,
        &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {condition})"),
    )?;
    if owed == 0 {
        return Ok(());
    }
    Err(match ctx.electron_device_id {
        Some(_) => ImportError::UnsyncedChanges { table },
        None => ImportError::NeverSynced { table },
    })
}

fn instant(
    row: &Row<'_>,
    name: &str,
    table: &'static str,
    rowid: i64,
) -> Result<Option<i64>, ImportError> {
    match column(row, name, table, rowid)? {
        Value::Null => Ok(None),
        Value::String(iso) => to_epoch_ms(&iso)
            .map(Some)
            .ok_or_else(|| malformed(table, rowid, "a time column is not an ISO instant")),
        _ => Err(malformed(
            table,
            rowid,
            "a time column is not an ISO instant",
        )),
    }
}

fn required_instant(
    row: &Row<'_>,
    name: &str,
    table: &'static str,
    rowid: i64,
) -> Result<i64, ImportError> {
    instant(row, name, table, rowid)?
        .ok_or_else(|| malformed(table, rowid, "a required time column is empty"))
}

fn text(
    row: &Row<'_>,
    name: &str,
    table: &'static str,
    rowid: i64,
) -> Result<Option<String>, ImportError> {
    match column(row, name, table, rowid)? {
        Value::Null => Ok(None),
        Value::String(text) => Ok(Some(text)),
        _ => Err(malformed(table, rowid, "a text column holds a number")),
    }
}

fn integer(row: &Row<'_>, name: &str, table: &'static str, rowid: i64) -> Result<i64, ImportError> {
    column(row, name, table, rowid)?
        .as_i64()
        .ok_or_else(|| malformed(table, rowid, "an integer column holds no integer"))
}

fn source_rows(ctx: &TableCtx<'_>, sql: &str) -> Result<u64, ImportError> {
    ctx.source
        .query_row(sql, [], |row| row.get::<_, i64>(0))
        .map(|n| n as u64)
        .map_err(|e| source_error(SourceDb::Data, e))
}

/// Calls `each` for every row `sql` (which selects `rowid`) returns.
fn each_row(
    ctx: &TableCtx<'_>,
    sql: &str,
    mut each: impl FnMut(&Row<'_>, i64) -> Result<(), ImportError>,
) -> Result<(), ImportError> {
    let mut stmt = ctx
        .source
        .prepare(sql)
        .map_err(|e| source_error(SourceDb::Data, e))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| source_error(SourceDb::Data, e))?;
    while let Some(row) = rows.next().map_err(|e| source_error(SourceDb::Data, e))? {
        let rowid: i64 = row
            .get("rowid")
            .map_err(|e| source_error(SourceDb::Data, e))?;
        each(row, rowid)?;
    }
    Ok(())
}

/// `inbox_item_tags`: the core keys a tag by (capture, tag) and drops Electron's row id. A
/// second spelling of a tag on one capture (the column is `NOCASE`) keeps the earliest.
pub fn inbox_item_tags(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    const TABLE: &str = "inbox_item_tags";
    let total = source_rows(ctx, "SELECT count(*) FROM inbox_item_tags")?;
    let mut tags = Vec::new();
    each_row(
        ctx,
        "SELECT rowid, item_id, tag, created_at FROM inbox_item_tags
          WHERE item_id IN (SELECT id FROM inbox_items) ORDER BY created_at, rowid",
        |row, rowid| {
            tags.push(ImportInboxTag {
                item_id: read_source_id(row, SourceDb::Data, TABLE, "item_id")?,
                tag: text(row, "tag", TABLE, rowid)?
                    .ok_or_else(|| malformed(TABLE, rowid, "tag is empty"))?,
                created_at: required_instant(row, "created_at", TABLE, rowid)?,
            });
            Ok(())
        },
    )?;
    let stored = ctx.writer.put_inbox_tags(&tags)?;
    let mut stats = TableStats {
        written: stored,
        ..TableStats::default()
    };
    push_dropped(&mut stats, "duplicateInboxTags", tags.len() as u64 - stored);
    push_dropped(
        &mut stats,
        "inboxTagsWithoutItem",
        total - tags.len() as u64,
    );
    Ok(stats)
}

/// `inbox_attachment_uploads`: same columns in the core (data 0016), so a capture's file still
/// waiting to upload is uploaded by the core.
pub fn inbox_attachment_uploads(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    const TABLE: &str = "inbox_attachment_uploads";
    let total = source_rows(ctx, "SELECT count(*) FROM inbox_attachment_uploads")?;
    let mut uploads = Vec::new();
    each_row(
        ctx,
        "SELECT rowid, item_id, created_at FROM inbox_attachment_uploads
          WHERE item_id IN (SELECT id FROM inbox_items)",
        |row, rowid| {
            uploads.push(ImportInboxUpload {
                item_id: read_source_id(row, SourceDb::Data, TABLE, "item_id")?,
                created_at: integer(row, "created_at", TABLE, rowid)?,
            });
            Ok(())
        },
    )?;
    ctx.writer.put_inbox_uploads(&uploads)?;
    let mut stats = TableStats {
        written: uploads.len() as u64,
        ..TableStats::default()
    };
    push_dropped(
        &mut stats,
        "inboxUploadsWithoutItem",
        total - uploads.len() as u64,
    );
    Ok(stats)
}

/// The job types the core runs (`domain::inbox::jobs::InboxJobType`). Electron fails a job of
/// any other type when it comes due (`jobs.ts:437`).
const JOB_TYPES: &[&str] = &["metadata-scrape", "article-extract", "transcription"];
const JOB_STATUSES: &[&str] = &["pending", "running", "complete", "failed"];

/// `inbox_jobs` as Electron resumes them at start (`resumeInboxJobs`, `jobs.ts:571-603`): a
/// `running` job is interrupted, so it becomes `pending` with no start time, due at its
/// `run_at`. One job per (capture, type), the most recently updated. `payload` and `result`
/// have no core column: a link job whose capture has no `source_url` reads its URL from the
/// payload alone (`jobs.ts:210`, `:325`), so such a job still to run is dropped and counted.
pub fn inbox_jobs(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    const TABLE: &str = "inbox_jobs";
    let total = source_rows(ctx, "SELECT count(*) FROM inbox_jobs")?;
    let mut stats = TableStats::default();
    let (mut jobs, mut without_item, mut unknown, mut duplicate, mut payloads, mut url_lost) =
        (Vec::<ImportInboxJob>::new(), 0, 0, 0, 0, 0);
    let now_ms = ctx.now_ms;
    let mut last_pair: Option<(String, String)> = None;
    each_row(
        ctx,
        "SELECT rowid, id, item_id, type, status, run_at, attempts, max_attempts, payload,
                last_error, started_at, completed_at, created_at, updated_at,
                item_id IN (SELECT id FROM inbox_items) AS has_item,
                (SELECT coalesce(source_url, '') = '' FROM inbox_items i
                  WHERE i.id = inbox_jobs.item_id) AS no_item_url
           FROM inbox_jobs ORDER BY item_id, type, updated_at DESC, rowid DESC",
        |row, rowid| {
            let has_item: bool = row
                .get("has_item")
                .map_err(|e| source_error(SourceDb::Data, e))?;
            let item_id = read_source_id(row, SourceDb::Data, TABLE, "item_id")?;
            let job_type = text(row, "type", TABLE, rowid)?.unwrap_or_default();
            let status = text(row, "status", TABLE, rowid)?.unwrap_or_default();
            if !has_item {
                without_item += 1;
                return Ok(());
            }
            if !JOB_TYPES.contains(&job_type.as_str()) || !JOB_STATUSES.contains(&status.as_str()) {
                unknown += 1;
                return Ok(());
            }
            // Rows come newest first per (capture, type); only the first one counts.
            let pair = (item_id.clone(), job_type.clone());
            if last_pair.as_ref() == Some(&pair) {
                duplicate += 1;
                return Ok(());
            }
            last_pair = Some(pair);
            let payload = json_column(row, "payload", TABLE, rowid)?;
            let interrupted = status == "running";
            let no_item_url: Option<bool> = row
                .get("no_item_url")
                .map_err(|e| source_error(SourceDb::Data, e))?;
            if (interrupted || status == "pending")
                && job_type != "transcription"
                && no_item_url == Some(true)
                && payload
                    .get("url")
                    .and_then(Value::as_str)
                    .is_some_and(|url| !url.is_empty())
            {
                url_lost += 1;
                return Ok(());
            }
            if !payload.is_null() {
                payloads += 1;
            }
            jobs.push(ImportInboxJob {
                id: read_source_id(row, SourceDb::Data, TABLE, "id")?,
                item_id,
                job_type,
                status: if interrupted {
                    "pending".into()
                } else {
                    status
                },
                attempts: integer(row, "attempts", TABLE, rowid)?,
                max_attempts: integer(row, "max_attempts", TABLE, rowid)?,
                next_run_at: required_instant(row, "run_at", TABLE, rowid)?,
                last_error: text(row, "last_error", TABLE, rowid)?,
                started_at: if interrupted {
                    None
                } else {
                    instant(row, "started_at", TABLE, rowid)?
                },
                completed_at: instant(row, "completed_at", TABLE, rowid)?,
                created_at: required_instant(row, "created_at", TABLE, rowid)?,
                updated_at: if interrupted {
                    now_ms
                } else {
                    required_instant(row, "updated_at", TABLE, rowid)?
                },
            });
            Ok(())
        },
    )?;
    ctx.writer.put_inbox_jobs(&jobs)?;
    stats.written = jobs.len() as u64;
    push_dropped(&mut stats, "inboxJobsWithoutItem", without_item);
    push_dropped(&mut stats, "inboxJobsWithoutProcessor", unknown);
    push_dropped(&mut stats, "duplicateInboxJobs", duplicate);
    push_dropped(&mut stats, "inboxJobsUrlLost", url_lost);
    if payloads > 0 {
        stats.notices.push(("inboxJobPayloadsDropped", payloads));
    }
    debug_assert_eq!(
        stats.written + without_item + unknown + duplicate + url_lost,
        total
    );
    Ok(stats)
}

pub(super) fn push_dropped(stats: &mut TableStats, reason: &'static str, count: u64) {
    if count > 0 {
        stats.dropped.push((reason, count));
    }
}
