//! The reminder commands' service (Step 21f2, #3538): Electron's `lib/reminders.ts` CRUD and
//! queries over `memry_core::domain::reminders`, which owns every reminder row and the rule of
//! when one fires. This module checks the values the zod schemas check, maps the core's
//! outcome to the command's, and reads back what a write left, in the same writer call: the
//! reminder as the renderer sees it and the pending count for the badge.
//!
//! Every function blocks (SQLite); an async caller runs it on a blocking thread. A write and
//! a scheduler tick both run on the vault's one writer connection, so a dismiss, snooze or
//! delete lands either before a tick reads what is due or after it fired.

use std::sync::Arc;

use chrono::{Days, Local, TimeZone as _};
use memry_core::api::auth::ensure_device_identity;
use memry_core::api::errors::{AuthError, StorageError};
use memry_core::domain::reminders::{
    self, ListFilter, NewReminder, NewTarget, Reminder, ReminderUpdate, fire, target_of,
};
use memry_core::seams::secure_store::SecureStore;
use memry_core::storage::Db;
use memry_core::storage::repositories::instants;
use rusqlite::Connection;

use super::reminder_contract::{
    ReminderCreateInput, ReminderListInput, ReminderListView, ReminderSnoozeInput,
    ReminderStatusFilter, ReminderTargetInput, ReminderTargetType, ReminderUpdateInput,
    ReminderView, ReminderWithTargetView,
};
use crate::session::OpenVault;

/// `ListRemindersSchema.limit`: 50 when absent, at most 200.
const LIST_LIMIT: u32 = 50;
const LIST_LIMIT_MAX: u32 = 200;
/// `getUpcomingReminders`: 7 days when absent, 1 to 365, at most 100 reminders.
const UPCOMING_DAYS: u32 = 7;
const UPCOMING_DAYS_MAX: u32 = 365;
const UPCOMING_LIMIT: usize = 100;

/// Why a reminder command failed. The shell turns each into its message.
#[derive(Debug, thiserror::Error)]
pub enum ReminderError {
    /// `errors:reminder.notFound`: no live reminder has the id.
    #[error("reminder not found")]
    NotFound,
    /// `system:error.reminderTimeMustBeFuture`.
    #[error("reminder time must be in the future")]
    RemindAtPast,
    /// Electron's `Snooze time must be in the future`.
    #[error("Snooze time must be in the future")]
    SnoozePast,
    /// A value the zod schema refuses.
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Storage(StorageError),
    /// A write could not read this device's identity (a locked keychain); reads never need it.
    #[error(transparent)]
    Identity(AuthError),
}

impl From<StorageError> for ReminderError {
    fn from(error: StorageError) -> Self {
        match error {
            StorageError::NotFound { .. } => Self::NotFound,
            error => Self::Storage(error),
        }
    }
}

/// What a write committed, and the pending count after it (the badge).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Written<T> {
    pub value: T,
    pub pending: u32,
}

/// What `bulk_dismiss` did before it stopped. `failure` is the error that stopped it; the
/// reminders before it stay dismissed.
#[derive(Debug)]
pub struct BulkDismissed {
    pub dismissed: Vec<ReminderView>,
    pub pending: u32,
    pub failure: Option<ReminderError>,
}

pub struct ReminderService {
    db: Db,
    device_id: Box<dyn Fn() -> Result<String, AuthError> + Send + Sync>,
}

impl ReminderService {
    /// `device_id` is asked for on each write only, so the read commands work while the
    /// device identity cannot be read.
    pub fn new(
        db: Db,
        device_id: impl Fn() -> Result<String, AuthError> + Send + Sync + 'static,
    ) -> Self {
        Self {
            db,
            device_id: Box::new(device_id),
        }
    }

    /// The reminders of `open`, written under the device identity in `store`.
    pub fn open(open: &OpenVault, store: Arc<dyn SecureStore>) -> Self {
        let vault = open.vault.clone();
        Self::new(open.vault.db_handle(), move || {
            ensure_device_identity(store.clone())?;
            Ok(vault.notes_writer(store.clone())?.device_id())
        })
    }

    fn device(&self) -> Result<String, ReminderError> {
        (self.device_id)().map_err(ReminderError::Identity)
    }

    /// `createReminder`.
    pub fn create(
        &self,
        input: &ReminderCreateInput,
        now_ms: i64,
    ) -> Result<Written<ReminderView>, ReminderError> {
        let target = new_target(input)?;
        future(&input.remind_at, now_ms, ReminderError::RemindAtPast)?;
        let reminder = NewReminder {
            id: None,
            target,
            remind_at: &input.remind_at,
            title: input.title.as_deref(),
            note: input.note.as_deref(),
        };
        self.write(|conn, device| {
            Ok(reminders::create_reminder(conn, &reminder, device, now_ms)?.acknowledge())
        })
    }

    /// `updateReminder`: a new time makes the reminder pending again, so it fires at it.
    pub fn update(
        &self,
        input: &ReminderUpdateInput,
        now_ms: i64,
    ) -> Result<Written<ReminderView>, ReminderError> {
        if let Some(remind_at) = &input.remind_at {
            future(remind_at, now_ms, ReminderError::RemindAtPast)?;
        }
        let edit = ReminderUpdate {
            remind_at: input.remind_at.as_deref(),
            title: input.title.as_ref().map(Option::as_deref),
            note: input.note.as_ref().map(Option::as_deref),
        };
        let id = input.id.as_str();
        self.write(|conn, device| {
            reminders::update(conn, id, &edit, device, now_ms)?.acknowledge();
            Ok(id.to_owned())
        })
    }

    /// `deleteReminder`. Returns the reminder as it was, for the event and the banner.
    pub fn delete(&self, id: &str, now_ms: i64) -> Result<Written<ReminderView>, ReminderError> {
        let device = self.device()?;
        self.db
            .call_blocking(|conn| {
                let Some(before) = reminders::get(conn, id)? else {
                    return Ok(Err(ReminderError::NotFound));
                };
                if let Err(error) = reminders::delete(conn, id, &device, now_ms) {
                    return Ok(Err(error.into()));
                }
                Ok(Ok(Written {
                    value: ReminderView::from(&before),
                    pending: fire::pending_count(conn)?,
                }))
            })
            .map_err(ReminderError::from)?
    }

    /// `dismissReminder`. A reminder already dismissed is dismissed again, as Electron's is.
    pub fn dismiss(&self, id: &str, now_ms: i64) -> Result<Written<ReminderView>, ReminderError> {
        self.write(|conn, device| {
            reminders::dismiss(conn, id, device, now_ms)?.acknowledge();
            Ok(id.to_owned())
        })
    }

    /// `snoozeReminder`: the reminder fires again at `snoozeUntil`, also after it fired here.
    pub fn snooze(
        &self,
        input: &ReminderSnoozeInput,
        now_ms: i64,
    ) -> Result<Written<ReminderView>, ReminderError> {
        future(&input.snooze_until, now_ms, ReminderError::SnoozePast)?;
        let (id, until) = (input.id.as_str(), input.snooze_until.as_str());
        self.write(|conn, device| {
            reminders::snooze(conn, id, until, device, now_ms)?.acknowledge();
            Ok(id.to_owned())
        })
    }

    /// `bulkDismissReminders`: each id that names a live reminder is dismissed in its own
    /// write; an id that names none is skipped, as Electron's update matches no row.
    pub fn bulk_dismiss(&self, ids: &[String], now_ms: i64) -> BulkDismissed {
        if ids.is_empty() || ids.iter().any(String::is_empty) {
            return BulkDismissed {
                dismissed: Vec::new(),
                pending: self.count_pending().unwrap_or_default(),
                failure: Some(ReminderError::Invalid(
                    "reminderIds needs at least one non-empty id".to_owned(),
                )),
            };
        }
        let mut dismissed = Vec::new();
        let mut failure = None;
        for id in ids {
            match self.dismiss(id, now_ms) {
                Ok(written) => dismissed.push(written.value),
                Err(ReminderError::NotFound) => {}
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            }
        }
        let pending = match self.count_pending() {
            Ok(pending) => pending,
            Err(error) => {
                failure.get_or_insert(error);
                0
            }
        };
        BulkDismissed {
            dismissed,
            pending,
            failure,
        }
    }

    /// `getReminder`, with its target resolved.
    pub fn get(&self, id: &str) -> Result<Option<ReminderWithTargetView>, ReminderError> {
        Ok(self.db.read_blocking(|conn| {
            reminders::get(conn, id)?
                .map(|reminder| with_target(conn, &reminder))
                .transpose()
        })?)
    }

    /// `listReminders`.
    pub fn list(&self, input: &ReminderListInput) -> Result<ReminderListView, ReminderError> {
        let limit = input.limit.unwrap_or(LIST_LIMIT);
        if !(1..=LIST_LIMIT_MAX).contains(&limit) {
            return Err(ReminderError::Invalid(format!(
                "limit is 1 to {LIST_LIMIT_MAX}"
            )));
        }
        let statuses: Vec<&str> = match &input.status {
            None => Vec::new(),
            Some(ReminderStatusFilter::One(status)) => vec![status.as_str()],
            Some(ReminderStatusFilter::Many(statuses)) => {
                statuses.iter().map(|status| status.as_str()).collect()
            }
        };
        let filter = ListFilter {
            target_type: input.target_type.map(ReminderTargetType::as_str),
            // Electron skips a falsy filter, so an empty id filters nothing.
            target_id: input.target_id.as_deref().filter(|id| !id.is_empty()),
            statuses: &statuses,
            from_ms: input.from_date.as_deref().map(instant).transpose()?,
            to_ms: input.to_date.as_deref().map(instant).transpose()?,
            limit: limit as usize,
            offset: input.offset.unwrap_or(0) as usize,
        };
        self.page(&filter)
    }

    /// `getUpcomingReminders`: pending and snoozed reminders from now to the same local time
    /// `days` calendar days ahead (`Date.setDate`), at most 100.
    pub fn upcoming(
        &self,
        days: Option<u32>,
        now_ms: i64,
    ) -> Result<ReminderListView, ReminderError> {
        let days = days.unwrap_or(UPCOMING_DAYS);
        if !(1..=UPCOMING_DAYS_MAX).contains(&days) {
            return Err(ReminderError::Invalid(format!(
                "days is 1 to {UPCOMING_DAYS_MAX}"
            )));
        }
        let to_ms = Local
            .timestamp_millis_opt(now_ms)
            .single()
            .and_then(|now| now.checked_add_days(Days::new(u64::from(days))))
            .map(|to| to.timestamp_millis())
            .ok_or_else(|| ReminderError::Invalid("the upcoming window is out of range".into()))?;
        let statuses = [reminders::STATUS_PENDING, reminders::STATUS_SNOOZED];
        self.page(&ListFilter {
            statuses: &statuses,
            from_ms: Some(now_ms),
            to_ms: Some(to_ms),
            limit: UPCOMING_LIMIT,
            ..ListFilter::default()
        })
    }

    /// `getDueReminders`: pending and snoozed reminders whose time has come and that this
    /// device has not fired yet.
    pub fn due(&self, now_ms: i64) -> Result<Vec<ReminderWithTargetView>, ReminderError> {
        Ok(self.db.read_blocking(|conn| {
            fire::due(conn, now_ms)?
                .iter()
                .map(|due| with_target(conn, &due.reminder))
                .collect()
        })?)
    }

    /// `getRemindersForTarget`: every status, earliest `remindAt` first.
    pub fn for_target(
        &self,
        input: &ReminderTargetInput,
    ) -> Result<Vec<ReminderView>, ReminderError> {
        if input.target_id.is_empty() {
            return Err(ReminderError::Invalid(
                "targetId cannot be empty".to_owned(),
            ));
        }
        let kind = input.target_type.as_str();
        Ok(self.db.read_blocking(|conn| {
            Ok(reminders::for_target(conn, kind, &input.target_id, false)?
                .iter()
                .map(ReminderView::from)
                .collect())
        })?)
    }

    /// `countPendingReminders`: the badge.
    pub fn count_pending(&self) -> Result<u32, ReminderError> {
        Ok(self.db.read_blocking(fire::pending_count)?)
    }

    fn page(&self, filter: &ListFilter<'_>) -> Result<ReminderListView, ReminderError> {
        Ok(self.db.read_blocking(|conn| {
            let page = reminders::list(conn, filter)?;
            let reminders = page
                .reminders
                .iter()
                .map(|reminder| with_target(conn, reminder))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(ReminderListView {
                total: u32::try_from(page.total).unwrap_or(u32::MAX),
                has_more: filter.offset.saturating_add(reminders.len()) < page.total,
                reminders,
            })
        })?)
    }

    /// Runs one write on the writer and reads back the reminder it names, with the pending
    /// count, in the same call.
    fn write<F>(&self, write: F) -> Result<Written<ReminderView>, ReminderError>
    where
        F: FnOnce(&Connection, &str) -> Result<String, StorageError>,
    {
        let device = self.device()?;
        self.db
            .call_blocking(|conn| {
                let id = match write(conn, &device) {
                    Ok(id) => id,
                    Err(error) => return Ok(Err(ReminderError::from(error))),
                };
                let Some(reminder) = reminders::get(conn, &id)? else {
                    return Ok(Err(ReminderError::NotFound));
                };
                Ok(Ok(Written {
                    value: ReminderView::from(&reminder),
                    pending: fire::pending_count(conn)?,
                }))
            })
            .map_err(ReminderError::from)?
    }
}

fn with_target(
    conn: &Connection,
    reminder: &Reminder,
) -> Result<ReminderWithTargetView, StorageError> {
    Ok(ReminderWithTargetView::new(
        reminder,
        target_of(conn, reminder)?,
    ))
}

/// The arm of `CreateReminderSchema` `targetType` names, with the fields it needs.
fn new_target(input: &ReminderCreateInput) -> Result<NewTarget<'_>, ReminderError> {
    let missing = |field: &str| {
        ReminderError::Invalid(format!(
            "a {} reminder needs {field}",
            input.target_type.as_str()
        ))
    };
    let note_id = input.target_id.as_str();
    Ok(match input.target_type {
        ReminderTargetType::Note => NewTarget::Note(note_id),
        ReminderTargetType::Journal => NewTarget::Journal(note_id),
        ReminderTargetType::Task => NewTarget::Task(note_id),
        ReminderTargetType::Highlight => NewTarget::Highlight {
            note_id,
            text: input
                .highlight_text
                .as_deref()
                .ok_or_else(|| missing("highlightText"))?,
            start: input
                .highlight_start
                .ok_or_else(|| missing("highlightStart"))?,
            end: input.highlight_end.ok_or_else(|| missing("highlightEnd"))?,
        },
        ReminderTargetType::NoteDate => NewTarget::NoteDate {
            note_id,
            anchor_id: input
                .anchor_id
                .as_deref()
                .ok_or_else(|| missing("anchorId"))?,
        },
    })
}

fn instant(text: &str) -> Result<i64, ReminderError> {
    instants::to_epoch_ms(text)
        .ok_or_else(|| ReminderError::Invalid(format!("`{text}` is not an ISO datetime")))
}

/// `text` is an instant after `now_ms`, else `past`.
fn future(text: &str, now_ms: i64, past: ReminderError) -> Result<(), ReminderError> {
    if instant(text)? <= now_ms {
        return Err(past);
    }
    Ok(())
}
