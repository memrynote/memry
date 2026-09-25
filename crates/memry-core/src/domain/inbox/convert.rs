//! Converting and linking captures (spec 006 IB025-IB027): desktop's
//! `convertToTask`, `convertToReminder`, `linkToNotes` and the bulk handlers
//! (`filing.ts`, `batch.ts`, `snooze.ts`).

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension};

use crate::api::errors::StorageError;
use crate::crdt::body_edit::BlockEdit;
use crate::domain::notes::{self, NewNote, failed};
use crate::domain::tasks::{self, NewTask, TaskDetails};
use crate::domain::{body_write, reads, reminders, task_activity};

use super::filing::{self, LocalStamp, create_filed_note, merged_tags, note_path, note_title};
use super::write::{self, mark_filed, require_live};
use super::{InboxItem, NOTE_ONLY_TYPES, urls};

fn refuse_filed(item: &InboxItem) -> Result<(), StorageError> {
    if item.filed_at.is_some() {
        return Err(StorageError::Invalid {
            what: "Item has already been filed".to_owned(),
        });
    }
    Ok(())
}

/// What a task converted from a capture carries (desktop's input).
#[derive(Debug, Clone, Default)]
pub struct TaskInput {
    /// `None` is the inbox project (`getInboxProject`).
    pub project_id: Option<String>,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub priority: i64,
}

/// `convertToTask`: title from the capture, content as description, tags +
/// `inbox`, filed as `task` with `filedTo = taskId`.
pub fn convert_to_task(
    conn: &Connection,
    item_id: &str,
    input: &TaskInput,
    now: &LocalStamp,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    let item = require_live(conn, item_id)?;
    refuse_filed(&item)?;
    let project_id = match &input.project_id {
        Some(id) => id.clone(),
        None => inbox_project(conn)?,
    };
    let title = note_title(&item, now);
    let tags = merged_tags(&item, &[]);
    let task_id = tasks::new_task_id();
    let description = if item.item_type == "voice" {
        item.transcription.clone().or_else(|| item.content.clone())
    } else {
        item.content.clone()
    };
    tasks::create_detailed(
        conn,
        &NewTask {
            id: &task_id,
            title: &title,
            project_id: &project_id,
            due_date: input.due_date.as_deref(),
            due_time: input.due_time.as_deref(),
            priority: input.priority,
            repeat_config: None,
            tags: &tags,
        },
        &TaskDetails {
            description: description.as_deref(),
            ..TaskDetails::default()
        },
        device_id,
        now_ms,
    )?
    .acknowledge();
    // `recordTaskCreated`: desktop logs the conversion's own creation row.
    let _ = task_activity::record_created(conn, &task_id, &title, device_id, now_ms);
    mark_filed(conn, item_id, &task_id, "task", device_id, now_ms)?.acknowledge();
    Ok(task_id)
}

/// The inbox project: the literal `inbox` id desktop seeds, else the first
/// project flagged `isInbox`.
fn inbox_project(conn: &Connection) -> Result<String, StorageError> {
    let found: Option<String> = conn
        .query_row(
            "SELECT id FROM projects WHERE deleted_at IS NULL
              ORDER BY (id = 'inbox') DESC, is_inbox DESC, position LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    found.ok_or_else(|| StorageError::NotFound {
        what: "No inbox project found".to_owned(),
    })
}

/// `convertToReminder`: a note from the capture plus a note-target reminder,
/// filed as `reminder` with `filedTo = note path`. Returns the note id.
pub fn convert_to_reminder(
    conn: &Connection,
    item_id: &str,
    remind_at_iso: &str,
    remind_at_ms: i64,
    now: &LocalStamp,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    let item = require_live(conn, item_id)?;
    refuse_filed(&item)?;
    if NOTE_ONLY_TYPES.contains(&item.item_type.as_str()) {
        return Err(StorageError::Invalid {
            what: "Only text and voice items can become a reminder".to_owned(),
        });
    }
    if remind_at_ms <= now_ms {
        return Err(StorageError::Invalid {
            what: "Reminder time must be in the future".to_owned(),
        });
    }
    let (note_id, path) = create_filed_note(conn, &item, None, &[], true, now, device_id, now_ms)?;
    let title = note_title(&item, now);
    let reminder_id = format!("rem_{}", write::mint_id());
    reminders::create(
        conn,
        &reminder_id,
        &note_id,
        remind_at_iso,
        Some(&title),
        device_id,
        now_ms,
    )?;
    mark_filed(conn, item_id, &path, "reminder", device_id, now_ms)?.acknowledge();
    Ok(note_id)
}

/// A note to link to: one that exists, or one staged by title.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkTarget {
    Note(String),
    New(String),
}

/// `linkToNotes` for text captures: the capture becomes its own note (in
/// `folder`), and every target gains `- [[title]] - … (date)` under
/// `## Inbox Captures`. Filed as `linked`, `filedTo` = the first target's path.
/// Returns the target note ids in order.
#[allow(clippy::too_many_arguments)]
pub fn link_to_notes(
    conn: &Connection,
    item_id: &str,
    targets: &[LinkTarget],
    tags: &[String],
    folder: Option<&str>,
    now: &LocalStamp,
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<String>, StorageError> {
    if targets.is_empty() {
        return Err(StorageError::Invalid {
            what: "At least one note ID is required".to_owned(),
        });
    }
    let item = require_live(conn, item_id)?;
    refuse_filed(&item)?;
    let mut ids = Vec::new();
    for target in targets {
        match target {
            LinkTarget::Note(id) => {
                if !reads::note_exists(conn, id) {
                    return Err(StorageError::NotFound {
                        what: format!("Target note not found: {id}"),
                    });
                }
                ids.push(id.clone());
            }
            LinkTarget::New(title) => {
                ids.push(new_empty_note(conn, title, folder, device_id, now_ms)?)
            }
        }
    }
    let binary = super::BINARY_TYPES.contains(&item.item_type.as_str());
    let title = note_title(&item, now);
    if !binary {
        create_filed_note(conn, &item, folder, tags, true, now, device_id, now_ms)?;
    }
    for id in &ids {
        append_capture_entry(conn, id, &title, &entry_tail(&item, now), device_id, now_ms)?;
    }
    let first = note_path_of(conn, &ids[0])?;
    mark_filed(conn, item_id, &first, "linked", device_id, now_ms)?.acknowledge();
    Ok(ids)
}

fn new_empty_note(
    conn: &Connection,
    title: &str,
    folder: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    if let Some(folder) = folder.filter(|f| !f.is_empty()) {
        filing::ensure_folder(conn, folder, device_id, now_ms)?;
    }
    let id = write::mint_id();
    notes::create(
        conn,
        &NewNote {
            id: &id,
            title,
            folder_path: folder.filter(|f| !f.is_empty()),
            content: "",
            tags: &[],
            properties: None,
        },
        device_id,
        now_ms,
    )?
    .acknowledge();
    Ok(id)
}

/// ` - Link from host (date)` or ` - first line… (date)` (`generateInboxCaptureEntry`).
fn entry_tail(item: &InboxItem, now: &LocalStamp) -> String {
    let description = if item.item_type == "link" && item.source_url.is_some() {
        item.source_url
            .as_deref()
            .and_then(|url| url.split_once("://").map(|(_, rest)| rest))
            .and_then(|rest| rest.split(['/', '?', '#']).next())
            .map_or(" - Link".to_owned(), |host| format!(" - Link from {host}"))
    } else if let Some(content) = item.content.as_deref().filter(|c| !c.is_empty()) {
        let first: String = content
            .split('\n')
            .next()
            .unwrap_or_default()
            .trim()
            .chars()
            .take(50)
            .collect();
        let more = if content.encode_utf16().count() > 50 {
            "..."
        } else {
            ""
        };
        if first.is_empty() {
            String::new()
        } else {
            format!(" - {first}{more}")
        }
    } else {
        String::new()
    };
    format!("{description} ({})", now.date)
}

/// Appends one `[[title]]` bullet under `Inbox Captures` in a note's body,
/// adding the heading at the end when the note has none.
pub fn append_capture_entry(
    conn: &Connection,
    note_id: &str,
    title: &str,
    tail: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let blocks = reads::note_blocks(conn, note_id)
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })?
        .unwrap_or_default();
    let heading = blocks.iter().find(|b| {
        b.kind == "heading"
            && b.inline.iter().map(|r| r.text.as_str()).collect::<String>() == "Inbox Captures"
    });
    let run = |edit: BlockEdit| {
        body_write::edit_block(conn, note_id, &edit, device_id, now_ms).map_err(|error| {
            StorageError::Failed {
                what: format!("linking into a note: {error}"),
            }
        })
    };
    let heading_id = match heading.and_then(|b| b.id.clone()) {
        Some(id) => id,
        None => {
            let id = write::mint_id();
            run(BlockEdit::InsertBlock {
                kind: "heading".to_owned(),
                after_block_id: None,
                text: "Inbox Captures".to_owned(),
                new_block_id: id.clone(),
            })?;
            run(BlockEdit::SetProp {
                block_id: id.clone(),
                name: "level".to_owned(),
                value: "2".to_owned(),
            })?;
            id
        }
    };
    let bullet = write::mint_id();
    // The title is written as text first and then replaced by the link node,
    // so the range sits inside the block's one run.
    run(BlockEdit::InsertBlock {
        kind: "bulletListItem".to_owned(),
        after_block_id: Some(heading_id),
        text: format!("{title}{tail}"),
        new_block_id: bullet.clone(),
    })?;
    run(BlockEdit::InsertInline {
        block_id: bullet,
        start: 0,
        end: title.len() as u32,
        kind: "wikiLink".to_owned(),
        text: title.to_owned(),
        attrs: HashMap::from([("target".to_owned(), title.to_owned())]),
    })?;
    Ok(())
}

fn note_path_of(conn: &Connection, note_id: &str) -> Result<String, StorageError> {
    let (title, folder): (String, Option<String>) = conn
        .query_row(
            "SELECT title, folder_path FROM notes WHERE id = ?1",
            [note_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(failed)?;
    Ok(note_path(folder.as_deref(), &title))
}

/// Desktop's `BulkResponse`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BulkOutcome {
    pub processed: u32,
    /// `(itemId, error)`.
    pub errors: Vec<(String, String)>,
}

impl BulkOutcome {
    fn record(&mut self, id: &str, result: Result<(), StorageError>) {
        match result {
            Ok(()) => self.processed += 1,
            Err(error) => self.errors.push((id.to_owned(), error.to_string())),
        }
    }
}

/// `handleBulkArchive`.
pub fn bulk_archive(
    conn: &Connection,
    ids: &[String],
    device_id: &str,
    now_ms: i64,
) -> BulkOutcome {
    let mut out = BulkOutcome::default();
    for id in ids {
        out.record(
            id,
            write::archive(conn, id, device_id, now_ms).map(|d| drop(d.acknowledge())),
        );
    }
    out
}

/// `bulkSnoozeItems`.
pub fn bulk_snooze(
    conn: &Connection,
    ids: &[String],
    until_ms: i64,
    reason: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> BulkOutcome {
    let mut out = BulkOutcome::default();
    for id in ids {
        out.record(
            id,
            write::snooze(conn, id, until_ms, reason, device_id, now_ms)
                .map(|d| drop(d.acknowledge())),
        );
    }
    out
}

/// `handleBulkTag`: device-local tags on every capture.
pub fn bulk_tag(conn: &Connection, ids: &[String], tags: &[String], now_ms: i64) -> BulkOutcome {
    let mut out = BulkOutcome::default();
    for id in ids {
        let result = tags
            .iter()
            .try_for_each(|tag| write::add_tag(conn, id, tag, now_ms));
        out.record(id, result);
    }
    out
}

/// `bulkFileToFolder` for text captures; file captures are refused per item
/// (the shell files those with their files).
pub fn bulk_file(
    conn: &Connection,
    ids: &[String],
    folder: Option<&str>,
    tags: &[String],
    now: &LocalStamp,
    device_id: &str,
    now_ms: i64,
) -> BulkOutcome {
    let mut out = BulkOutcome::default();
    for id in ids {
        let result =
            filing::file_text(conn, id, folder, tags, "folder", now, device_id, now_ms).map(|_| ());
        out.record(id, result);
    }
    out
}

/// Whether a URL-only capture's title is still the default one.
pub fn has_default_title(item: &InboxItem) -> bool {
    item.source_url
        .as_deref()
        .map(urls::title_from_url)
        .as_deref()
        == Some(item.title.as_str())
}
