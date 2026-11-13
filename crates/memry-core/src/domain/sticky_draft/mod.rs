//! Unsent sticky text: the `sticky_draft` sync type
//! (`StickyDraftSyncPayloadSchema`, `packages/contracts/src/sync-payloads.ts`;
//! chapter 13 §13.7.25), desktop's `stickies/drafts.ts` over the record.
//!
//! The record in `sync_items` is the owner and `sticky_drafts` its projection
//! ([`crate::storage::repositories::projectors::sticky_drafts`]). Sending or
//! discarding a draft deletes it. The payload carries exactly the five schema
//! keys `{content, kind, clock, createdAt, modifiedAt}`, a subset of the whole
//! row Electron pushes (`sticky-draft-handler.ts:101-112`), and [`merge`]
//! applies a peer's.

pub mod merge;

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::domain::desktop_records::{self, live};
use crate::domain::notes::{failed, insert_local, iso, next_clock, object};
use crate::domain::saved_filters::mint_id;
use crate::storage::repositories::Change;
use crate::storage::repositories::schema::Object;
use crate::sync::outbox;

/// The sync type of a draft record.
pub const ITEM_TYPE: &str = "sticky_draft";

/// Where a draft goes when sent (`STICKY_KINDS`,
/// `packages/contracts/src/sticky-api.ts:13`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StickyKind {
    Note,
    Task,
    Journal,
}

impl StickyKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Note => "note",
            Self::Task => "task",
            Self::Journal => "journal",
        }
    }

    /// `parseStickyKind`: a kind this build does not know is `note`.
    pub fn parse(kind: &str) -> Self {
        match kind {
            "task" => Self::Task,
            "journal" => Self::Journal,
            _ => Self::Note,
        }
    }
}

/// One live draft. Instants are epoch milliseconds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StickyDraft {
    pub id: String,
    pub content: String,
    pub kind: StickyKind,
    pub created_at: i64,
    pub modified_at: i64,
}

/// Saves a draft: a new one when `id` is `None`, or when the draft `id` names
/// is gone (sent or discarded on another device meanwhile), so the text is
/// never dropped; otherwise the draft `id` names. Saving the text and kind a
/// draft already has writes and queues nothing.
pub fn upsert(
    conn: &Connection,
    id: Option<&str>,
    content: &str,
    kind: StickyKind,
    device_id: &str,
    now_ms: i64,
) -> Result<StickyDraft, StorageError> {
    if let Some(id) = id
        && let Some(existing) = get(conn, id)?
    {
        if existing.content == content && existing.kind == kind {
            return Ok(existing);
        }
        return outbox::commit(conn, &outbox::Change::upsert(ITEM_TYPE, id), now_ms, |tx| {
            let stored = live(tx, ITEM_TYPE, id, "sticky draft")?;
            let changes = vec![
                ("content", Change::set(content)),
                ("kind", Change::set(kind.as_str())),
                ("modifiedAt", Change::set(iso(now_ms)?)),
            ];
            desktop_records::edit(tx, ITEM_TYPE, id, &stored, changes, device_id, now_ms)?;
            read_back(tx, id)
        })
        .map(outbox::Durable::acknowledge);
    }
    let id = mint_id();
    outbox::commit(
        conn,
        &outbox::Change::upsert(ITEM_TYPE, &id),
        now_ms,
        |tx| {
            let created = iso(now_ms)?;
            let payload = object(json!({
                "content": content,
                "kind": kind.as_str(),
                "clock": next_clock(&Object::new(), device_id)?,
                "createdAt": created,
                "modifiedAt": created,
            }));
            insert_local(tx, ITEM_TYPE, &id, payload, now_ms)?;
            read_back(tx, &id)
        },
    )
    .map(outbox::Durable::acknowledge)
}

/// Deletes a draft and queues the delete. `false` when there was none.
pub fn delete(
    conn: &Connection,
    id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<bool, StorageError> {
    if get(conn, id)?.is_none() {
        return Ok(false);
    }
    outbox::commit(conn, &outbox::Change::delete(ITEM_TYPE, id), now_ms, |tx| {
        let stored = live(tx, ITEM_TYPE, id, "sticky draft")?;
        desktop_records::tombstone(tx, ITEM_TYPE, id, &stored, Vec::new(), device_id, now_ms)
    })?;
    Ok(true)
}

/// One live draft by id.
pub fn get(conn: &Connection, id: &str) -> Result<Option<StickyDraft>, StorageError> {
    conn.query_row(
        &format!("{SELECT} WHERE id = ?1 AND deleted_at IS NULL"),
        params![id],
        read_row,
    )
    .optional()
    .map_err(failed)
}

/// Every live draft, most recently edited first (`listStickyDrafts`).
pub fn list(conn: &Connection) -> Result<Vec<StickyDraft>, StorageError> {
    let mut statement = conn
        .prepare_cached(&format!(
            "{SELECT} WHERE deleted_at IS NULL ORDER BY modified_at DESC, id"
        ))
        .map_err(failed)?;
    statement
        .query_map([], read_row)
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

const SELECT: &str = "SELECT id, content, kind, created_at, modified_at FROM sticky_drafts";

fn read_row(row: &Row<'_>) -> rusqlite::Result<StickyDraft> {
    let kind: String = row.get(2)?;
    Ok(StickyDraft {
        id: row.get(0)?,
        content: row.get(1)?,
        kind: StickyKind::parse(&kind),
        created_at: row.get(3)?,
        modified_at: row.get(4)?,
    })
}

fn read_back(tx: &Connection, id: &str) -> Result<StickyDraft, StorageError> {
    get(tx, id)?.ok_or_else(|| StorageError::Failed {
        what: format!("sticky draft {id} did not project"),
    })
}

/// Whether a remote payload can create a draft: Electron's insert guard
/// (`sticky-draft-handler.ts:54-60`), a stated `content`.
pub(crate) fn can_create(remote: &Object) -> bool {
    remote.get("content").is_some_and(Value::is_string)
}
