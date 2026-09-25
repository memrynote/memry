//! The Snoozed & reminders view: desktop's `buildReminderPanel`
//! (`apps/desktop/src/renderer/src/lib/reminder-panel.ts`) over the synced
//! reminders and inbox rows.
//!
//! - **Upcoming**: pending or snoozed reminders still to fire, plus captures
//!   snoozed into the future (a snoozed `reminder` capture expands to its
//!   target), deduplicated on `(target, time)` with the capture-derived entry
//!   winning, soonest first.
//! - **Past**: active `reminder` captures whose snooze is not in the future,
//!   by `metadata.remindAt` (or `createdAt`), newest first.
//!
//! Desktop marks a fired reminder `triggered` on the device that fired it and
//! syncs it as `pending` (`reminders/mod.rs`), so a synced `pending` reminder
//! can be in the past here. Upcoming keeps only those still to fire; a fired
//! one reaches Past through the `reminder` capture desktop writes for it.

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::domain::notes::failed;
use crate::domain::reminders;
use crate::storage::repositories::instants;

use super::{InboxItem, queries};

/// Where an entry navigates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PanelTarget {
    /// `note`, `journal`, `task`, `highlight`, `note_date`, verbatim.
    pub target_type: String,
    pub target_id: String,
    pub target_title: Option<String>,
    pub project_id: Option<String>,
}

/// One row of the panel.
#[derive(Debug, Clone, PartialEq)]
pub struct PanelEntry {
    pub key: String,
    pub time_ms: i64,
    /// Set for a reminder entry; `None` for a snoozed capture.
    pub target: Option<PanelTarget>,
    /// The capture this entry came from (a snoozed capture, or a fired
    /// reminder capture that opening marks viewed).
    pub item: Option<InboxItem>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Panel {
    pub upcoming: Vec<PanelEntry>,
    pub past: Vec<PanelEntry>,
}

pub fn panel(conn: &Connection, now_ms: i64) -> Result<Panel, StorageError> {
    let mut upcoming = Vec::new();
    for due in reminders::due_window(conn, None)? {
        if due.fire_at_ms <= now_ms {
            continue;
        }
        let project_id = task_project(conn, &due.reminder)?;
        upcoming.push(PanelEntry {
            key: format!("reminder:{}", due.reminder.id),
            time_ms: due.fire_at_ms,
            target: Some(PanelTarget {
                target_type: due.reminder.target_type.clone(),
                target_id: due.reminder.target_id.clone(),
                target_title: due.target_title.clone(),
                project_id,
            }),
            item: None,
        });
    }
    for item in queries::snoozed(conn)? {
        let Some(until) = item.snoozed_until.filter(|until| *until > now_ms) else {
            continue;
        };
        let target = (item.item_type == "reminder")
            .then(|| target_of(&item))
            .flatten();
        upcoming.push(PanelEntry {
            key: format!("inbox:{}", item.id),
            time_ms: until,
            target,
            item: Some(item),
        });
    }
    let mut upcoming = dedupe(upcoming);
    upcoming.sort_by(|a, b| a.time_ms.cmp(&b.time_ms).then_with(|| a.key.cmp(&b.key)));

    let mut past = Vec::new();
    for item in queries::reminder_items(conn)? {
        if item.snoozed_until.is_some_and(|until| until > now_ms) {
            continue;
        }
        let Some(target) = target_of(&item) else {
            continue;
        };
        let time_ms = item
            .metadata_text("remindAt")
            .and_then(instants::to_epoch_ms)
            .unwrap_or(item.created_at);
        past.push(PanelEntry {
            key: format!("inbox:{}", item.id),
            time_ms,
            target: Some(target),
            item: Some(item),
        });
    }
    past.sort_by(|a, b| b.time_ms.cmp(&a.time_ms).then_with(|| a.key.cmp(&b.key)));
    Ok(Panel { upcoming, past })
}

/// `metadataToNav`: a reminder capture's target, `None` without metadata.
fn target_of(item: &InboxItem) -> Option<PanelTarget> {
    let meta = item.metadata.as_ref()?;
    let text = |key: &str| meta.get(key).and_then(Value::as_str).map(str::to_owned);
    Some(PanelTarget {
        target_type: text("targetType")?,
        target_id: text("targetId")?,
        target_title: text("targetTitle"),
        project_id: text("projectId"),
    })
}

/// `dedupeUpcoming`: one entry per `(target, time)`; the capture-derived one
/// wins because it carries the capture that opening marks viewed.
fn dedupe(entries: Vec<PanelEntry>) -> Vec<PanelEntry> {
    let mut out: Vec<PanelEntry> = Vec::new();
    for entry in entries {
        let Some(target) = &entry.target else {
            out.push(entry);
            continue;
        };
        let same = out.iter().position(|seen| {
            seen.time_ms == entry.time_ms
                && seen.target.as_ref().is_some_and(|t| {
                    t.target_type == target.target_type && t.target_id == target.target_id
                })
        });
        match same {
            None => out.push(entry),
            Some(index) => {
                if entry.item.is_some() && out[index].item.is_none() {
                    out[index] = entry;
                }
            }
        }
    }
    out
}

/// The project of a task target, for opening the task in its list.
fn task_project(
    conn: &Connection,
    reminder: &reminders::Reminder,
) -> Result<Option<String>, StorageError> {
    if reminder.target_type != reminders::TARGET_TASK {
        return Ok(None);
    }
    conn.query_row(
        "SELECT project_id FROM tasks WHERE id = ?1 AND deleted_at IS NULL",
        [&reminder.target_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map(Option::flatten)
    .map_err(failed)
}
