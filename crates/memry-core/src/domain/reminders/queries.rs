//! Reminder reads over the `reminders` projection: a task's reminders for its
//! detail screen, and the due window a shell schedules local notifications
//! from (FR-061/062).
//!
//! Both skip tombstoned rows. Desktop hard-deletes a reminder; the core keeps
//! a tombstone until it is purged, and a tombstone is not a reminder.

use rusqlite::{Connection, OptionalExtension as _, Row, params};

use crate::api::errors::StorageError;
use crate::storage::repositories::instants;

use super::{STATUS_PENDING, STATUS_SNOOZED, TARGET_TASK};

/// One reminder row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reminder {
    pub id: String,
    /// `note`, `journal`, `highlight`, `note_date`, `task` — or whatever a
    /// newer desktop writes; carried verbatim.
    pub target_type: String,
    pub target_id: String,
    /// The ISO instant the payload carries.
    pub remind_at: String,
    pub title: Option<String>,
    pub note: Option<String>,
    /// Desktop's notification body for a `highlight` reminder.
    pub highlight_text: Option<String>,
    /// `pending`, `snoozed`, `dismissed` (and `triggered` from an older
    /// desktop build) — carried verbatim.
    pub status: String,
    pub dismissed_at: Option<String>,
    pub snoozed_until: Option<String>,
}

impl Reminder {
    /// Desktop's `activeReminders` filter: `pending` or `snoozed`.
    pub fn is_active(&self) -> bool {
        self.status == STATUS_PENDING || self.status == STATUS_SNOOZED
    }
}

/// A reminder that is still going to fire, with what a notification needs to
/// say about its target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueReminder {
    pub reminder: Reminder,
    /// When it fires: `snoozedUntil` for a snoozed reminder, `remindAt`
    /// otherwise, in `toISOString` form.
    pub fire_at: String,
    pub fire_at_ms: i64,
    /// The task's or note's title; the date itself for a journal reminder
    /// (desktop `resolveReminderTarget`). `None` when the target is gone.
    pub target_title: Option<String>,
    /// `false` when the task or note is missing or tombstoned, or the target
    /// type is one this core does not know.
    pub target_exists: bool,
    /// A task target with a `completedAt`. Always `false` for other targets.
    pub target_completed: bool,
}

const COLUMNS: &str = "id, target_type, target_id, remind_at, title, note, highlight_text, \
                       status, dismissed_at, snoozed_until";

/// One live reminder by id, or `None`.
pub fn get(conn: &Connection, id: &str) -> Result<Option<Reminder>, StorageError> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM reminders WHERE id = ?1 AND deleted_at IS NULL"),
        [id],
        reminder_row,
    )
    .optional()
    .map_err(failed)
}

/// A task's live reminders, earliest `remindAt` first.
///
/// `active_only` keeps `pending` and `snoozed`, which is desktop's
/// `activeReminders`; otherwise every status is returned, which is its
/// `reminders` (`use-task-reminders.ts`). Desktop sorts by the parsed instant,
/// so this does too; a `remindAt` that will not parse sorts last.
pub fn for_task(
    conn: &Connection,
    task_id: &str,
    active_only: bool,
) -> Result<Vec<Reminder>, StorageError> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM reminders \
             WHERE target_type = ?1 AND target_id = ?2 AND deleted_at IS NULL \
             ORDER BY remind_at, id"
        ))
        .map_err(failed)?;
    let rows = statement
        .query_map(params![TARGET_TASK, task_id], reminder_row)
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    let mut reminders: Vec<Reminder> = rows
        .into_iter()
        .filter(|reminder| !active_only || reminder.is_active())
        .collect();
    reminders
        .sort_by_key(|reminder| instants::to_epoch_ms(&reminder.remind_at).unwrap_or(i64::MAX));
    Ok(reminders)
}

/// Every live `pending` or `snoozed` reminder, on any target, that fires at or
/// before `until_ms` (all of them when `None`), earliest fire time first.
///
/// Overdue reminders are included, as desktop's `getDueReminders` includes
/// them: a reminder that came due while the app was closed still has to be
/// shown. A reminder whose fire time will not parse cannot be scheduled and
/// is left out.
pub fn due_window(
    conn: &Connection,
    until_ms: Option<i64>,
) -> Result<Vec<DueReminder>, StorageError> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM reminders \
             WHERE deleted_at IS NULL AND status IN (?1, ?2) \
             ORDER BY remind_at, id"
        ))
        .map_err(failed)?;
    let rows = statement
        .query_map(params![STATUS_PENDING, STATUS_SNOOZED], reminder_row)
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;

    let mut due = Vec::new();
    for reminder in rows {
        let Some(fire_at_ms) = fire_at_ms(&reminder) else {
            continue;
        };
        if until_ms.is_some_and(|until| fire_at_ms > until) {
            continue;
        }
        let Some(fire_at) = instants::to_iso8601(fire_at_ms) else {
            continue;
        };
        let target = resolve_target(conn, &reminder)?;
        due.push(DueReminder {
            reminder,
            fire_at,
            fire_at_ms,
            target_title: target.title,
            target_exists: target.exists,
            target_completed: target.completed,
        });
    }
    due.sort_by(|a, b| (a.fire_at_ms, &a.reminder.id).cmp(&(b.fire_at_ms, &b.reminder.id)));
    Ok(due)
}

/// A snoozed reminder fires at `snoozedUntil` (desktop's due query); one
/// without a usable `snoozedUntil` falls back to `remindAt`.
fn fire_at_ms(reminder: &Reminder) -> Option<i64> {
    let snoozed = (reminder.status == STATUS_SNOOZED)
        .then_some(reminder.snoozed_until.as_deref())
        .flatten()
        .and_then(instants::to_epoch_ms);
    snoozed.or_else(|| instants::to_epoch_ms(&reminder.remind_at))
}

struct Target {
    title: Option<String>,
    exists: bool,
    completed: bool,
}

/// Desktop `resolveReminderTarget`.
fn resolve_target(conn: &Connection, reminder: &Reminder) -> Result<Target, StorageError> {
    let id = reminder.target_id.as_str();
    match reminder.target_type.as_str() {
        "journal" => Ok(Target {
            title: Some(reminder.target_id.clone()),
            exists: true,
            completed: false,
        }),
        "note" | "note_date" | "highlight" => {
            let title: Option<String> = conn
                .query_row(
                    "SELECT title FROM notes WHERE id = ?1 AND deleted_at IS NULL",
                    [id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(failed)?;
            Ok(Target {
                exists: title.is_some(),
                title,
                completed: false,
            })
        }
        TARGET_TASK => {
            let task: Option<(String, Option<String>)> = conn
                .query_row(
                    "SELECT title, completed_at FROM tasks WHERE id = ?1 AND deleted_at IS NULL",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(failed)?;
            Ok(match task {
                Some((title, completed_at)) => Target {
                    title: Some(title),
                    exists: true,
                    completed: completed_at.is_some(),
                },
                None => Target {
                    title: None,
                    exists: false,
                    completed: false,
                },
            })
        }
        _ => Ok(Target {
            title: None,
            exists: false,
            completed: false,
        }),
    }
}

fn reminder_row(row: &Row<'_>) -> rusqlite::Result<Reminder> {
    Ok(Reminder {
        id: row.get(0)?,
        target_type: row.get(1)?,
        target_id: row.get(2)?,
        remind_at: row.get(3)?,
        title: row.get(4)?,
        note: row.get(5)?,
        highlight_text: row.get(6)?,
        status: row.get(7)?,
        dismissed_at: row.get(8)?,
        snoozed_until: row.get(9)?,
    })
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
