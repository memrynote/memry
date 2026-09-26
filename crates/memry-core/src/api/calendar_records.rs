//! The FFI shapes of the calendar surface (spec 007 CL012/CL015).

use crate::domain::calendar_items::projection::{BindingMeta, ProjectionItem, SourceMeta};
use crate::domain::calendar_items::zone::LocalZone;

/// The local zone over a range, as the shell's `TimeZone` reports it: the
/// offset in force before the first transition, then each transition. A
/// record, not a foreign trait, so the seam list stays closed (§6 CL002).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CalendarZone {
    /// IANA name (`Intl…timeZone`), stamped on native items.
    pub identifier: String,
    /// Offset east of UTC, milliseconds, before `transitions[0]`.
    pub base_offset_ms: i64,
    pub transitions: Vec<CalendarZoneTransition>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct CalendarZoneTransition {
    pub at_ms: i64,
    pub offset_ms: i64,
}

impl LocalZone for CalendarZone {
    fn offset_ms(&self, utc_ms: i64) -> i64 {
        self.transitions
            .iter()
            .take_while(|t| t.at_ms <= utc_ms)
            .last()
            .map_or(self.base_offset_ms, |t| t.offset_ms)
    }
}

/// `CalendarProjectionEditability`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct CalendarEditability {
    pub can_move: bool,
    pub can_resize: bool,
    pub can_edit_text: bool,
    pub can_delete: bool,
}

/// `CalendarProjectionSourceMeta`.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CalendarItemSource {
    pub provider: Option<String>,
    pub calendar_source_id: Option<String>,
    pub title: String,
    pub color: Option<String>,
    pub kind: Option<String>,
    pub is_memry_managed: bool,
}

/// `CalendarProjectionBinding`.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CalendarItemBinding {
    pub provider: String,
    pub remote_calendar_id: String,
    pub remote_event_id: String,
    pub ownership_mode: String,
    pub writeback_mode: String,
}

/// `CalendarProjectionItem`.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CalendarItem {
    pub projection_id: String,
    /// `event | task | reminder | inbox_snooze | external_event | note | note_date`.
    pub source_type: String,
    pub source_id: String,
    pub title: String,
    pub description_preview: Option<String>,
    pub start_at: String,
    pub end_at: Option<String>,
    pub is_all_day: bool,
    pub timezone: String,
    /// `event | external_event | task | reminder | snooze | note | note_date`.
    pub visual_type: String,
    pub editability: CalendarEditability,
    pub source: CalendarItemSource,
    pub binding: Option<CalendarItemBinding>,
    pub snooze_offset_minutes: Option<i64>,
    pub color: Option<String>,
    pub display_color: Option<String>,
    pub note_id: Option<String>,
    pub anchor_id: Option<String>,
    pub is_triggered: Option<bool>,
}

impl From<SourceMeta> for CalendarItemSource {
    fn from(s: SourceMeta) -> Self {
        Self {
            provider: s.provider,
            calendar_source_id: s.calendar_source_id,
            title: s.title,
            color: s.color,
            kind: s.kind,
            is_memry_managed: s.is_memry_managed,
        }
    }
}

impl From<BindingMeta> for CalendarItemBinding {
    fn from(b: BindingMeta) -> Self {
        Self {
            provider: b.provider,
            remote_calendar_id: b.remote_calendar_id,
            remote_event_id: b.remote_event_id,
            ownership_mode: b.ownership_mode,
            writeback_mode: b.writeback_mode,
        }
    }
}

impl From<ProjectionItem> for CalendarItem {
    fn from(item: ProjectionItem) -> Self {
        Self {
            projection_id: item.projection_id,
            source_type: item.source_type,
            source_id: item.source_id,
            title: item.title,
            description_preview: item.description_preview,
            start_at: item.start_at,
            end_at: item.end_at,
            is_all_day: item.is_all_day,
            timezone: item.timezone,
            visual_type: item.visual_type,
            editability: CalendarEditability {
                can_move: item.editability.can_move,
                can_resize: item.editability.can_resize,
                can_edit_text: item.editability.can_edit_text,
                can_delete: item.editability.can_delete,
            },
            source: item.source.into(),
            binding: item.binding.map(Into::into),
            snooze_offset_minutes: item.snooze_offset_minutes,
            color: item.color,
            display_color: item.display_color,
            note_id: item.note_id,
            anchor_id: item.anchor_id,
            is_triggered: item.is_triggered,
        }
    }
}

/// A range request (`GetCalendarRangeInput` + desktop's side inputs).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CalendarRangeRequest {
    pub start_at: String,
    pub end_at: String,
    pub include_unselected_sources: bool,
    pub enabled_property_names: Vec<String>,
    pub show_notes_by_created: bool,
}

/// `CalendarSourceRecord`.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CalendarSourceRecord {
    pub id: String,
    pub provider: String,
    pub kind: String,
    pub account_id: Option<String>,
    pub remote_id: String,
    pub title: String,
    pub timezone: Option<String>,
    /// `calendarDisplayHex(color)`.
    pub color: Option<String>,
    pub is_primary: bool,
    pub is_selected: bool,
    pub is_memry_managed: bool,
    pub sync_status: String,
    pub last_synced_at: Option<String>,
    pub last_error: Option<String>,
    /// JSON text of `metadata`.
    pub metadata_json: Option<String>,
    pub archived_at: Option<String>,
    /// Where the provider's pull continues (`sync-token:…`, `ctag:…`, a
    /// Google sync token); on the synced row, as desktop keeps it.
    pub sync_cursor: Option<String>,
}

/// `CalendarEventRecord`, with JSON text for the rich fields.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CalendarEventRecord {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub start_at: String,
    pub end_at: Option<String>,
    pub timezone: String,
    pub is_all_day: bool,
    pub recurrence_rule_json: Option<String>,
    pub attendees_json: Option<String>,
    pub reminders_json: Option<String>,
    pub visibility: Option<String>,
    pub color_id: Option<String>,
    /// The event colour name for `color_id`.
    pub color: Option<String>,
    pub conference_data_json: Option<String>,
    pub target_calendar_id: Option<String>,
    pub binding: Option<CalendarItemBinding>,
    pub created_at: Option<i64>,
    pub modified_at: Option<i64>,
}

/// `CalendarExternalEventDetails`.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CalendarExternalEventRecord {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub start_at: String,
    pub end_at: Option<String>,
    pub timezone: Option<String>,
    pub is_all_day: bool,
    pub status: String,
    pub recurrence_rule_json: Option<String>,
    pub attendees_json: Option<String>,
    pub reminders_json: Option<String>,
    pub conference_data_json: Option<String>,
    pub source_id: Option<String>,
    pub source_provider: Option<String>,
    pub source_title: Option<String>,
    pub source_color: Option<String>,
    /// `metadata.sourceTitle` (the account's name).
    pub account_title: Option<String>,
    /// Whether promotion can make it editable.
    pub is_promotable: bool,
}

/// `CreateCalendarEventSchema`.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CalendarEventDraft {
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub start_at: String,
    pub end_at: Option<String>,
    pub timezone: String,
    pub is_all_day: bool,
    pub target_calendar_id: Option<String>,
    pub color: Option<String>,
}

/// One optional-and-clearable text key of a patch.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum CalendarTextChange {
    Keep,
    Set { value: String },
    Clear,
}

impl CalendarTextChange {
    pub(crate) fn into_patch(self) -> Option<Option<String>> {
        match self {
            CalendarTextChange::Keep => None,
            CalendarTextChange::Set { value } => Some(Some(value)),
            CalendarTextChange::Clear => Some(None),
        }
    }
}

/// `UpdateCalendarEventSchema`.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CalendarEventChanges {
    pub title: Option<String>,
    pub description: CalendarTextChange,
    pub location: CalendarTextChange,
    pub start_at: Option<String>,
    pub end_at: CalendarTextChange,
    pub timezone: Option<String>,
    pub is_all_day: Option<bool>,
    pub target_calendar_id: CalendarTextChange,
    pub color: CalendarTextChange,
}

/// A project linking an event (`tasksService.listForItem('calendar_event')`).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CalendarLinkedProject {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub is_archived: bool,
}
