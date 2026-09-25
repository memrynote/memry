//! The records [`crate::api::journal::Journal`] hands the shells (spec
//! 005-journal JP027), split from `journal.rs` for the line ceiling.
//!
//! Each is a flat copy of a domain type in `domain::journal_ops` or
//! `domain::journal_rules`; the domain keeps plain Rust types so its rules
//! are testable without the FFI.

use crate::domain::journal_ops::body::EditDayOutcome;
use crate::domain::journal_ops::reads::{
    JournalBodyState, JournalDay, JournalMonth, JournalMonthEntry, JournalYear,
};
use crate::domain::journal_ops::settings::JournalTemplateSettingsView;
use crate::domain::journal_rules::{JournalHeatmapDay, JournalMonthActivity, JournalStreak};
use crate::domain::note_meta::NoteProperty;
use crate::domain::reminders::Reminder;

/// What this device holds of a day's body.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum JournalBody {
    /// The body is here and has text.
    Present,
    /// The day exists but its body has not been pulled to this device.
    NotPulled,
    /// The body is here and empty.
    Empty,
}

impl From<JournalBodyState> for JournalBody {
    fn from(state: JournalBodyState) -> Self {
        match state {
            JournalBodyState::Present => Self::Present,
            JournalBodyState::NotPulled => Self::NotPulled,
            JournalBodyState::Empty => Self::Empty,
        }
    }
}

/// One live day. `properties` never carries the reserved `date`.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct JournalDayRecord {
    /// The record id, which is also the body's document id.
    pub id: String,
    pub date: String,
    pub tags: Vec<String>,
    pub properties: Vec<NoteProperty>,
    pub created_at: Option<i64>,
    pub modified_at: Option<i64>,
    pub word_count: u64,
    /// UTF-16 code units of the extracted body text (D6).
    pub character_count: u64,
    pub body: JournalBody,
}

impl From<JournalDay> for JournalDayRecord {
    fn from(day: JournalDay) -> Self {
        Self {
            id: day.id,
            date: day.date,
            tags: day.tags,
            properties: day.properties,
            created_at: day.created_at,
            modified_at: day.modified_at,
            word_count: day.word_count,
            character_count: day.character_count,
            body: day.body_state.into(),
        }
    }
}

/// Current and longest run of consecutive days, counted from a given today.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct JournalStreakRecord {
    pub current: u32,
    pub longest: u32,
    pub last_entry_date: Option<String>,
}

impl From<JournalStreak> for JournalStreakRecord {
    fn from(streak: JournalStreak) -> Self {
        Self {
            current: streak.current_streak,
            longest: streak.longest_streak,
            last_entry_date: streak.last_entry_date,
        }
    }
}

/// One day of a Month screen.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct JournalMonthDayRecord {
    pub date: String,
    pub is_today: bool,
    pub is_future: bool,
    pub has_entry: bool,
    /// Activity level 0-4.
    pub level: u8,
    pub preview: String,
    pub character_count: u64,
    /// `None` for a day with no entry.
    pub body: Option<JournalBody>,
}

impl From<JournalMonthEntry> for JournalMonthDayRecord {
    fn from(day: JournalMonthEntry) -> Self {
        Self {
            date: day.date,
            is_today: day.is_today,
            is_future: day.is_future,
            has_entry: day.has_entry,
            level: day.level,
            preview: day.preview,
            character_count: day.character_count,
            body: day.body_state.map(JournalBody::from),
        }
    }
}

/// One month, newest day first.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct JournalMonthRecord {
    pub year: i64,
    /// 1-12.
    pub month: u32,
    pub days: Vec<JournalMonthDayRecord>,
    pub entry_count: u32,
    pub streak: JournalStreakRecord,
}

impl From<JournalMonth> for JournalMonthRecord {
    fn from(month: JournalMonth) -> Self {
        Self {
            year: month.year,
            month: month.month,
            days: month.days.into_iter().map(Into::into).collect(),
            entry_count: month.entry_count,
            streak: month.streak.into(),
        }
    }
}

/// One month card of a Year screen.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct JournalMonthCard {
    /// 0-11.
    pub month: u32,
    /// Days with at least one character.
    pub entry_count: u32,
    pub total_characters: u64,
    /// Highest level per 7-day block from the 1st, at most 5.
    pub activity_dots: Vec<u8>,
}

impl From<JournalMonthActivity> for JournalMonthCard {
    fn from(card: JournalMonthActivity) -> Self {
        Self {
            month: card.month,
            entry_count: card.entry_count,
            total_characters: card.total_chars,
            activity_dots: card.activity_dots,
        }
    }
}

/// One year: twelve cards, totals and the streak.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct JournalYearRecord {
    pub year: i64,
    pub months: Vec<JournalMonthCard>,
    pub days_with_entries: u32,
    pub total_characters: u64,
    pub streak: JournalStreakRecord,
}

impl From<JournalYear> for JournalYearRecord {
    fn from(year: JournalYear) -> Self {
        Self {
            year: year.year,
            months: year.months.into_iter().map(Into::into).collect(),
            days_with_entries: year.days_with_entries,
            total_characters: year.total_characters,
            streak: year.streak.into(),
        }
    }
}

/// One day of the heatmap.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct JournalHeatmapEntry {
    pub date: String,
    pub character_count: u64,
    pub level: u8,
}

impl From<JournalHeatmapDay> for JournalHeatmapEntry {
    fn from(day: JournalHeatmapDay) -> Self {
        Self {
            date: day.date,
            character_count: day.character_count,
            level: day.level,
        }
    }
}

/// What a body edit addressed by date did.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct JournalEditResult {
    /// The day's record id (an existing id wins over `j<date>`).
    pub id: String,
    pub created: bool,
    pub revived: bool,
    /// `false` when the edit authored nothing; then nothing was written.
    pub changed: bool,
}

impl From<EditDayOutcome> for JournalEditResult {
    fn from(outcome: EditDayOutcome) -> Self {
        Self {
            id: outcome.id,
            created: outcome.created,
            revived: outcome.revived,
            changed: outcome.changed,
        }
    }
}

/// One reminder on a day (D8).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct JournalReminder {
    pub id: String,
    /// The date the reminder points at (`targetId`).
    pub date: String,
    pub remind_at: String,
    pub note: Option<String>,
    pub status: String,
    pub snoozed_until: Option<String>,
    /// `pending` or `snoozed`.
    pub is_active: bool,
}

impl From<Reminder> for JournalReminder {
    fn from(reminder: Reminder) -> Self {
        Self {
            is_active: reminder.is_active(),
            id: reminder.id,
            date: reminder.target_id,
            remind_at: reminder.remind_at,
            note: reminder.note,
            status: reminder.status,
            snoozed_until: reminder.snoozed_until,
        }
    }
}

/// The synced journal template settings (D9).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct JournalSettingsRecord {
    pub default_template: Option<String>,
    /// Seven entries indexed by absolute weekday, 0 = Sunday.
    pub weekday_templates: Vec<Option<String>>,
}

impl From<JournalTemplateSettingsView> for JournalSettingsRecord {
    fn from(view: JournalTemplateSettingsView) -> Self {
        Self {
            default_template: view.default_template,
            weekday_templates: view.weekday_templates.to_vec(),
        }
    }
}

/// The strings a shell formats for seeding a day from a template (D4).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct JournalTemplateStrings {
    /// `{{date}}` without a pattern: long weekday, month, day and year.
    pub long_date: String,
    /// `{{time}}`: the current time.
    pub time: String,
    /// `{{day-of-week}}`: the long weekday name.
    pub day_of_week: String,
}
