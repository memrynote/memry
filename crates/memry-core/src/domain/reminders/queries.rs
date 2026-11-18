//! Reminder reads over the `reminders` projection: one target's reminders,
//! desktop's filtered list, and the due window a shell schedules local
//! notifications from (FR-061/062).
//!
//! Every read skips tombstoned rows. Desktop hard-deletes a reminder; the core
//! keeps a tombstone until it is purged, and a tombstone is not a reminder.
//! Every read also reads this device's `reminder_fires` rows, so a reminder
//! fired here for its current instant reads as [`STATUS_TRIGGERED`] through
//! [`Reminder::shown_status`] while its synced `status` stays untouched.

use rusqlite::{Connection, OptionalExtension as _, Row, params};

use crate::api::errors::StorageError;
use crate::storage::repositories::instants;

use super::{STATUS_PENDING, STATUS_SNOOZED, STATUS_TRIGGERED, TARGET_TASK};

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
    /// The inline date pill a `note_date` reminder belongs to.
    pub anchor_id: Option<String>,
    /// Desktop's notification body for a `highlight` reminder.
    pub highlight_text: Option<String>,
    pub highlight_start: Option<i64>,
    pub highlight_end: Option<i64>,
    /// `pending`, `snoozed`, `dismissed` (and `triggered` from an older
    /// desktop build) — carried verbatim.
    pub status: String,
    pub dismissed_at: Option<String>,
    pub snoozed_until: Option<String>,
    pub created_at_ms: Option<i64>,
    pub modified_at_ms: Option<i64>,
    /// When this device fired the reminder for its current fire instant
    /// (`reminder_fires`); `None` when it has not, or fired an earlier instant.
    pub fired_at_ms: Option<i64>,
    /// Desktop's `triggeredAt`: the last time this device fired the reminder
    /// for its `remindAt` or its `snoozedUntil`. Desktop stamps it at a fire,
    /// keeps it through a dismiss and a snooze, and clears it when a new
    /// `remindAt` re-arms the reminder; a new `remindAt` here matches no fire.
    pub triggered_at_ms: Option<i64>,
}

impl Reminder {
    /// Desktop's `activeReminders` filter: `pending` or `snoozed`.
    pub fn is_active(&self) -> bool {
        self.status == STATUS_PENDING || self.status == STATUS_SNOOZED
    }

    /// The status desktop's renderer reads: `triggered` for an active reminder
    /// this device fired for its current instant (desktop's scheduler writes
    /// that status locally), else the synced `status`.
    pub fn shown_status(&self) -> &str {
        if self.is_active() && self.fired_at_ms.is_some() {
            STATUS_TRIGGERED
        } else {
            &self.status
        }
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

const COLUMNS: &str = "r.id, r.target_type, r.target_id, r.remind_at, r.title, r.note, \
                       r.highlight_text, r.status, r.dismissed_at, r.snoozed_until, r.anchor_id, \
                       r.highlight_start, r.highlight_end, r.created_at, r.modified_at, \
                       (SELECT json_group_array(json_array(f.fired_for_ms, f.fired_at_ms)) \
                        FROM reminder_fires f WHERE f.reminder_id = r.id)";
const FROM: &str = "reminders r";

/// One live reminder by id, or `None`.
pub fn get(conn: &Connection, id: &str) -> Result<Option<Reminder>, StorageError> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM {FROM} WHERE r.id = ?1 AND r.deleted_at IS NULL"),
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
    for_target(conn, TARGET_TASK, task_id, active_only)
}

/// One target's live reminders, earliest parsed `remindAt` first (desktop
/// `getRemindersForTarget`); the body of [`for_task`] and
/// [`super::journal::for_journal`].
pub fn for_target(
    conn: &Connection,
    target_type: &str,
    target_id: &str,
    active_only: bool,
) -> Result<Vec<Reminder>, StorageError> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM {FROM} \
             WHERE r.target_type = ?1 AND r.target_id = ?2 AND r.deleted_at IS NULL \
             ORDER BY r.remind_at, r.id"
        ))
        .map_err(failed)?;
    let rows = statement
        .query_map(params![target_type, target_id], reminder_row)
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

/// Desktop `listReminders`' filters (`ListRemindersSchema`).
#[derive(Debug, Clone, Copy, Default)]
pub struct ListFilter<'a> {
    pub target_type: Option<&'a str>,
    pub target_id: Option<&'a str>,
    /// Statuses as [`Reminder::shown_status`] reads them; empty keeps every
    /// status.
    pub statuses: &'a [&'a str],
    /// Only a `remindAt` at or after this instant.
    pub from_ms: Option<i64>,
    /// Only a `remindAt` at or before this instant.
    pub to_ms: Option<i64>,
    pub limit: usize,
    pub offset: usize,
}

/// One page of [`list`] and how many reminders matched in all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReminderPage {
    pub reminders: Vec<Reminder>,
    pub total: usize,
}

/// Desktop `listReminders`: the live reminders that pass `filter`, earliest
/// `remindAt` first, then the page `limit` and `offset` name. Desktop compares
/// `remindAt` with the bounds as text, which orders the same as instants for
/// the `toISOString` form it writes; here both are compared as instants, so a
/// `remindAt` that will not parse matches no bound and sorts last.
pub fn list(conn: &Connection, filter: &ListFilter<'_>) -> Result<ReminderPage, StorageError> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM {FROM} \
             WHERE r.deleted_at IS NULL \
               AND (?1 IS NULL OR r.target_type = ?1) AND (?2 IS NULL OR r.target_id = ?2)"
        ))
        .map_err(failed)?;
    let rows = statement
        .query_map(params![filter.target_type, filter.target_id], reminder_row)
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    let mut matched: Vec<(i64, Reminder)> = rows
        .into_iter()
        .filter(|reminder| {
            filter.statuses.is_empty() || filter.statuses.contains(&reminder.shown_status())
        })
        .map(|reminder| {
            let at = instants::to_epoch_ms(&reminder.remind_at).unwrap_or(i64::MAX);
            (at, reminder)
        })
        .filter(|(at, _)| {
            let parsed = *at != i64::MAX;
            filter.from_ms.is_none_or(|from| parsed && *at >= from)
                && filter.to_ms.is_none_or(|to| parsed && *at <= to)
        })
        .collect();
    matched.sort_by(|(a_at, a), (b_at, b)| (a_at, &a.id).cmp(&(b_at, &b.id)));
    let total = matched.len();
    let reminders = matched
        .into_iter()
        .skip(filter.offset)
        .take(filter.limit)
        .map(|(_, reminder)| reminder)
        .collect();
    Ok(ReminderPage { reminders, total })
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
            "SELECT {COLUMNS} FROM {FROM} \
             WHERE r.deleted_at IS NULL AND r.status IN (?1, ?2) \
             ORDER BY r.remind_at, r.id"
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
        let target = target_of(conn, &reminder)?;
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
    fire_instant(
        &reminder.status,
        &reminder.remind_at,
        reminder.snoozed_until.as_deref(),
    )
}

pub(super) fn fire_instant(
    status: &str,
    remind_at: &str,
    snoozed_until: Option<&str>,
) -> Option<i64> {
    let snoozed = (status == STATUS_SNOOZED)
        .then_some(snoozed_until)
        .flatten()
        .and_then(instants::to_epoch_ms);
    snoozed.or_else(|| instants::to_epoch_ms(remind_at))
}

/// What a reminder's target is (desktop `resolveReminderTarget`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Target {
    /// The task's or note's title; the date itself for a journal reminder.
    pub title: Option<String>,
    /// `false` when the task or note is missing or tombstoned, or the target
    /// type is one this core does not know.
    pub exists: bool,
    /// A task target with a `completedAt`.
    pub completed: bool,
    /// A task target's project.
    pub project_id: Option<String>,
}

/// Desktop `resolveReminderTarget`.
pub fn target_of(conn: &Connection, reminder: &Reminder) -> Result<Target, StorageError> {
    let id = reminder.target_id.as_str();
    match reminder.target_type.as_str() {
        "journal" => Ok(Target {
            title: Some(reminder.target_id.clone()),
            exists: true,
            ..Target::default()
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
                ..Target::default()
            })
        }
        TARGET_TASK => {
            let task: Option<(String, Option<String>, Option<String>)> = conn
                .query_row(
                    "SELECT title, completed_at, project_id FROM tasks \
                     WHERE id = ?1 AND deleted_at IS NULL",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(failed)?;
            Ok(match task {
                Some((title, completed_at, project_id)) => Target {
                    title: Some(title),
                    exists: true,
                    completed: completed_at.is_some(),
                    project_id,
                },
                None => Target::default(),
            })
        }
        _ => Ok(Target::default()),
    }
}

fn reminder_row(row: &Row<'_>) -> rusqlite::Result<Reminder> {
    let mut reminder = Reminder {
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
        anchor_id: row.get(10)?,
        highlight_start: row.get(11)?,
        highlight_end: row.get(12)?,
        created_at_ms: row.get(13)?,
        modified_at_ms: row.get(14)?,
        fired_at_ms: None,
        triggered_at_ms: None,
    };
    // `[[fired_for_ms, fired_at_ms], ...]`: one row per instant fired here.
    let fires: String = row.get(15)?;
    let fires: Vec<(i64, i64)> = serde_json::from_str(&fires).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(15, rusqlite::types::Type::Text, error.into())
    })?;
    let fired_for = |instant: Option<i64>| {
        fires
            .iter()
            .filter(|(fired_for, _)| Some(*fired_for) == instant)
            .map(|(_, fired_at)| *fired_at)
            .max()
    };
    reminder.fired_at_ms = fired_for(fire_at_ms(&reminder));
    let remind_at = instants::to_epoch_ms(&reminder.remind_at);
    let snoozed_until = reminder
        .snoozed_until
        .as_deref()
        .and_then(instants::to_epoch_ms);
    reminder.triggered_at_ms = fired_for(remind_at).max(fired_for(snoozed_until));
    Ok(reminder)
}

pub(super) fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
