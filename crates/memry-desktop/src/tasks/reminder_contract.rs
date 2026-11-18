//! The shapes of the reminder commands: the zod schemas and response records of
//! `packages/contracts/src/reminders-api.ts` as Rust structs. Inputs are checked here only for
//! their shape (an unknown `targetType` or `status` is refused by serde); the value rules live
//! in [`super::reminder_service`].

use memry_core::domain::reminders::{Reminder, Target};
use memry_core::storage::repositories::instants;
use serde::{Deserialize, Serialize};

use crate::templates::present;

/// `ReminderTargetTypeSchema`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ReminderTargetType {
    Note,
    Journal,
    Highlight,
    Task,
    NoteDate,
}

impl ReminderTargetType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Note => "note",
            Self::Journal => "journal",
            Self::Highlight => "highlight",
            Self::Task => "task",
            Self::NoteDate => "note_date",
        }
    }
}

/// `ReminderStatusSchema`. `triggered` is this device's fire, never a synced status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum ReminderStatus {
    Pending,
    Triggered,
    Dismissed,
    Snoozed,
}

impl ReminderStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Triggered => "triggered",
            Self::Dismissed => "dismissed",
            Self::Snoozed => "snoozed",
        }
    }
}

/// `CreateReminderSchema`, flattened: the arm `targetType` names decides which of the optional
/// fields it needs.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReminderCreateInput {
    pub target_type: ReminderTargetType,
    pub target_id: String,
    pub remind_at: String,
    #[serde(default)]
    #[specta(optional)]
    pub title: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub note: Option<String>,
    /// The `highlight` arm.
    #[serde(default)]
    #[specta(optional)]
    pub highlight_text: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub highlight_start: Option<i64>,
    #[serde(default)]
    #[specta(optional)]
    pub highlight_end: Option<i64>,
    /// The `note_date` arm.
    #[serde(default)]
    #[specta(optional)]
    pub anchor_id: Option<String>,
}

/// `UpdateReminderSchema`. An absent field is left alone; `title` and `note` take `null` as a
/// clear.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReminderUpdateInput {
    pub id: String,
    #[serde(default)]
    #[specta(optional)]
    pub remind_at: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[specta(optional, type = Option<String>)]
    pub title: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    #[specta(optional, type = Option<String>)]
    pub note: Option<Option<String>>,
}

/// `SnoozeReminderSchema`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReminderSnoozeInput {
    pub id: String,
    pub snooze_until: String,
}

/// `ListRemindersSchema.status`: one status or several.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(untagged)]
pub enum ReminderStatusFilter {
    One(ReminderStatus),
    Many(Vec<ReminderStatus>),
}

/// `ListRemindersSchema`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReminderListInput {
    #[serde(default)]
    #[specta(optional)]
    pub target_type: Option<ReminderTargetType>,
    #[serde(default)]
    #[specta(optional)]
    pub target_id: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub status: Option<ReminderStatusFilter>,
    #[serde(default)]
    #[specta(optional)]
    pub from_date: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub to_date: Option<String>,
    /// 1 to 200, 50 when absent.
    #[serde(default)]
    #[specta(optional)]
    pub limit: Option<u32>,
    #[serde(default)]
    #[specta(optional)]
    pub offset: Option<u32>,
}

/// `GetForTargetSchema`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReminderTargetInput {
    pub target_type: ReminderTargetType,
    pub target_id: String,
}

/// `Reminder`. `status` and `targetType` are carried verbatim: a newer build may write a value
/// this one does not know.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReminderView {
    pub id: String,
    pub target_type: String,
    pub target_id: String,
    pub remind_at: String,
    pub anchor_id: Option<String>,
    pub highlight_text: Option<String>,
    pub highlight_start: Option<i64>,
    pub highlight_end: Option<i64>,
    pub title: Option<String>,
    pub note: Option<String>,
    pub status: String,
    /// When this device fired the reminder for its current instant.
    pub triggered_at: Option<String>,
    pub dismissed_at: Option<String>,
    pub snoozed_until: Option<String>,
    pub created_at: String,
    pub modified_at: String,
}

impl From<&Reminder> for ReminderView {
    fn from(reminder: &Reminder) -> Self {
        let iso = |ms: Option<i64>| ms.and_then(instants::to_iso8601);
        let created_at = iso(reminder.created_at_ms).unwrap_or_default();
        Self {
            id: reminder.id.clone(),
            target_type: reminder.target_type.clone(),
            target_id: reminder.target_id.clone(),
            remind_at: reminder.remind_at.clone(),
            anchor_id: reminder.anchor_id.clone(),
            highlight_text: reminder.highlight_text.clone(),
            highlight_start: reminder.highlight_start,
            highlight_end: reminder.highlight_end,
            title: reminder.title.clone(),
            note: reminder.note.clone(),
            status: reminder.shown_status().to_owned(),
            triggered_at: iso(reminder.fired_at_ms),
            dismissed_at: reminder.dismissed_at.clone(),
            snoozed_until: reminder.snoozed_until.clone(),
            modified_at: iso(reminder.modified_at_ms).unwrap_or_else(|| created_at.clone()),
            created_at,
        }
    }
}

/// `ReminderWithTarget`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReminderWithTargetView {
    #[serde(flatten)]
    pub reminder: ReminderView,
    pub target_title: Option<String>,
    pub target_exists: bool,
    /// Set for a highlight only: whether its note is still there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub highlight_exists: Option<bool>,
    /// Set for a task only: the project it belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub project_id: Option<String>,
}

impl ReminderWithTargetView {
    pub fn new(reminder: &Reminder, target: Target) -> Self {
        Self {
            reminder: ReminderView::from(reminder),
            highlight_exists: (reminder.target_type == "highlight").then_some(target.exists),
            target_title: target.title,
            target_exists: target.exists,
            project_id: target.project_id,
        }
    }
}

/// `ReminderListResponse`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReminderListView {
    pub reminders: Vec<ReminderWithTargetView>,
    pub total: u32,
    pub has_more: bool,
}
