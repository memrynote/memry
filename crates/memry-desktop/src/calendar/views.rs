//! The calendar's IPC shapes, field for field `packages/contracts/src/calendar-api.ts`, built
//! from the core's records. The core keeps rich fields as JSON text and times as epoch
//! milliseconds; these carry them as JSON values and ISO strings, as Electron's handlers did.

use memry_core::api::calendar_records::{
    CalendarEventRecord, CalendarExternalEventRecord, CalendarSourceRecord,
};
use memry_core::domain::calendar_items::event_search::EventSearchHit;
use memry_core::domain::calendar_items::linked_notes::LinkedNote;
use memry_core::domain::calendar_items::projection::ProjectionItem;
use memry_core::storage::repositories::instants;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One of the contract's string unions, from the text the core stores.
fn parse<T: DeserializeOwned>(text: &str) -> Option<T> {
    serde_json::from_value(Value::String(text.to_owned())).ok()
}

/// A rich field's JSON text. Text that does not parse is logged and sent as `null`.
fn json(field: &str, text: Option<String>) -> Option<Value> {
    let text = text?;
    serde_json::from_str(&text)
        .inspect_err(|error| tracing::warn!("a calendar {field} is not JSON: {error}"))
        .ok()
}

fn iso(ms: Option<i64>) -> Option<String> {
    ms.and_then(instants::to_iso8601)
}

/// `CalendarProjectionSourceType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CalendarProjectionSourceType {
    Event,
    Task,
    Reminder,
    InboxSnooze,
    ExternalEvent,
    Note,
    NoteDate,
}

/// `CalendarProjectionVisualType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CalendarProjectionVisualType {
    Event,
    Task,
    Reminder,
    Snooze,
    ExternalEvent,
    Note,
    NoteDate,
}

/// `CalendarSourceKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CalendarSourceKind {
    Account,
    Calendar,
}

/// `CalendarSourceSyncStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CalendarSourceSyncStatus {
    Idle,
    Ok,
    Error,
    Pending,
}

/// `CalendarEventColor` (`calendar-colors.ts` `CALENDAR_EVENT_COLORS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CalendarEventColor {
    Tomato,
    Flamingo,
    Tangerine,
    Banana,
    Sage,
    Basil,
    Peacock,
    Blueberry,
    Lavender,
    Grape,
    Graphite,
}

impl CalendarEventColor {
    pub fn name(self) -> String {
        serde_json::to_value(self)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_default()
    }
}

/// `CalendarProjectionEditability`.
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEditabilityView {
    pub can_move: bool,
    pub can_resize: bool,
    pub can_edit_text: bool,
    pub can_delete: bool,
}

/// `CalendarProjectionSourceMeta`.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarItemSourceView {
    pub provider: Option<String>,
    pub calendar_source_id: Option<String>,
    pub title: Option<String>,
    pub color: Option<String>,
    pub kind: Option<CalendarSourceKind>,
    pub is_memry_managed: bool,
}

/// `CalendarProjectionBinding`.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarBindingView {
    pub provider: String,
    pub remote_calendar_id: String,
    pub remote_event_id: String,
    pub ownership_mode: String,
    pub writeback_mode: String,
}

/// `CalendarProjectionItem.task`.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarTaskMetaView {
    pub project_id: String,
    pub status_id: Option<String>,
    pub is_completed: bool,
}

/// `CalendarProjectionItem`. The keys the contract marks optional are left out when unset.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarProjectionItemView {
    pub projection_id: String,
    pub source_type: CalendarProjectionSourceType,
    pub source_id: String,
    pub title: String,
    pub description_preview: Option<String>,
    pub start_at: String,
    pub end_at: Option<String>,
    pub is_all_day: bool,
    pub timezone: String,
    pub visual_type: CalendarProjectionVisualType,
    pub editability: CalendarEditabilityView,
    pub source: CalendarItemSourceView,
    pub binding: Option<CalendarBindingView>,
    pub snooze_offset_minutes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub note_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub anchor_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub is_triggered: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub color: Option<CalendarEventColor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub display_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub task: Option<CalendarTaskMetaView>,
}

impl CalendarProjectionItemView {
    /// `None`, logged, for a source or visual type this build does not know.
    pub fn from_core(item: ProjectionItem) -> Option<Self> {
        let (Some(source_type), Some(visual_type)) =
            (parse(&item.source_type), parse(&item.visual_type))
        else {
            tracing::warn!(
                "calendar item {} has an unknown type {}/{}",
                item.projection_id,
                item.source_type,
                item.visual_type
            );
            return None;
        };
        Some(Self {
            projection_id: item.projection_id,
            source_type,
            source_id: item.source_id,
            title: item.title,
            description_preview: item.description_preview,
            start_at: item.start_at,
            end_at: item.end_at,
            is_all_day: item.is_all_day,
            timezone: item.timezone,
            visual_type,
            editability: CalendarEditabilityView {
                can_move: item.editability.can_move,
                can_resize: item.editability.can_resize,
                can_edit_text: item.editability.can_edit_text,
                can_delete: item.editability.can_delete,
            },
            source: CalendarItemSourceView {
                provider: item.source.provider,
                calendar_source_id: item.source.calendar_source_id,
                title: Some(item.source.title),
                color: item.source.color,
                kind: item.source.kind.as_deref().and_then(parse),
                is_memry_managed: item.source.is_memry_managed,
            },
            binding: item.binding.map(|b| CalendarBindingView {
                provider: b.provider,
                remote_calendar_id: b.remote_calendar_id,
                remote_event_id: b.remote_event_id,
                ownership_mode: b.ownership_mode,
                writeback_mode: b.writeback_mode,
            }),
            snooze_offset_minutes: item.snooze_offset_minutes,
            note_id: item.note_id,
            anchor_id: item.anchor_id,
            is_triggered: item.is_triggered,
            color: item.color.as_deref().and_then(parse),
            display_color: item.display_color,
            task: item.task.map(|t| CalendarTaskMetaView {
                project_id: t.project_id,
                status_id: t.status_id,
                is_completed: t.is_completed,
            }),
        })
    }
}

/// `CalendarEventRecord`. The core keeps no recurrence exceptions, parent event, original
/// start, archive or sync time on an event, so those are always `null`.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEventView {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub start_at: String,
    pub end_at: Option<String>,
    pub timezone: String,
    pub is_all_day: bool,
    pub recurrence_rule: Option<Value>,
    pub recurrence_exceptions: Option<Vec<String>>,
    pub attendees: Option<Value>,
    pub reminders: Option<Value>,
    pub visibility: Option<String>,
    pub color_id: Option<String>,
    pub color: Option<CalendarEventColor>,
    pub conference_data: Option<Value>,
    pub parent_event_id: Option<String>,
    pub original_start_time: Option<String>,
    pub target_calendar_id: Option<String>,
    pub archived_at: Option<String>,
    pub synced_at: Option<String>,
    pub created_at: String,
    pub modified_at: String,
}

impl From<CalendarEventRecord> for CalendarEventView {
    fn from(e: CalendarEventRecord) -> Self {
        Self {
            recurrence_rule: json("recurrence rule", e.recurrence_rule_json),
            attendees: json("attendee list", e.attendees_json),
            reminders: json("reminder list", e.reminders_json),
            conference_data: json("conference", e.conference_data_json),
            color: e.color.as_deref().and_then(parse),
            // Every event row has both times (desktop's columns are NOT NULL).
            created_at: iso(e.created_at).unwrap_or_default(),
            modified_at: iso(e.modified_at).unwrap_or_default(),
            id: e.id,
            title: e.title,
            description: e.description,
            location: e.location,
            start_at: e.start_at,
            end_at: e.end_at,
            timezone: e.timezone,
            is_all_day: e.is_all_day,
            recurrence_exceptions: None,
            visibility: e.visibility,
            color_id: e.color_id,
            parent_event_id: None,
            original_start_time: None,
            target_calendar_id: e.target_calendar_id,
            archived_at: None,
            synced_at: None,
        }
    }
}

/// `CalendarSourceRecord`. The core's source record has no sync, creation or change time, so
/// those are `null`; nothing in the renderer reads them.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSourceView {
    pub id: String,
    pub provider: String,
    pub kind: CalendarSourceKind,
    pub account_id: Option<String>,
    pub remote_id: String,
    pub title: String,
    pub timezone: Option<String>,
    pub color: Option<String>,
    pub is_primary: bool,
    pub is_selected: bool,
    pub is_memry_managed: bool,
    pub sync_cursor: Option<String>,
    pub sync_status: CalendarSourceSyncStatus,
    pub last_synced_at: Option<String>,
    pub last_error: Option<String>,
    pub metadata: Option<Value>,
    pub archived_at: Option<String>,
    pub synced_at: Option<String>,
    pub created_at: Option<String>,
    pub modified_at: Option<String>,
}

impl CalendarSourceView {
    /// `None`, logged, for a kind this build does not know.
    pub fn from_core(s: CalendarSourceRecord) -> Option<Self> {
        let Some(kind) = parse(&s.kind) else {
            tracing::warn!("calendar source {} has an unknown kind {}", s.id, s.kind);
            return None;
        };
        let sync_status = parse(&s.sync_status).unwrap_or_else(|| {
            tracing::warn!("calendar source {} has an unknown sync status", s.id);
            CalendarSourceSyncStatus::Idle
        });
        Some(Self {
            metadata: json("source metadata", s.metadata_json),
            id: s.id,
            provider: s.provider,
            kind,
            account_id: s.account_id,
            remote_id: s.remote_id,
            title: s.title,
            timezone: s.timezone,
            color: s.color,
            is_primary: s.is_primary,
            is_selected: s.is_selected,
            is_memry_managed: s.is_memry_managed,
            sync_cursor: s.sync_cursor,
            sync_status,
            last_synced_at: s.last_synced_at,
            last_error: s.last_error,
            archived_at: s.archived_at,
            synced_at: None,
            created_at: None,
            modified_at: None,
        })
    }
}

/// `CalendarExternalEventDetails.source`.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarExternalSourceView {
    pub id: String,
    pub provider: String,
    pub title: String,
    pub color: Option<String>,
    pub account_title: Option<String>,
}

/// `CalendarExternalEventDetails`.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarExternalEventView {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub start_at: String,
    pub end_at: Option<String>,
    pub timezone: Option<String>,
    pub is_all_day: bool,
    pub status: String,
    pub recurrence_rule: Option<Value>,
    pub attendees: Option<Value>,
    pub reminders: Option<Value>,
    pub conference_data: Option<Value>,
    pub source: Option<CalendarExternalSourceView>,
}

impl From<CalendarExternalEventRecord> for CalendarExternalEventView {
    fn from(e: CalendarExternalEventRecord) -> Self {
        let source = match (e.source_id, e.source_provider, e.source_title) {
            (Some(id), Some(provider), Some(title)) => Some(CalendarExternalSourceView {
                id,
                provider,
                title,
                color: e.source_color,
                account_title: e.account_title,
            }),
            _ => None,
        };
        Self {
            recurrence_rule: json("recurrence rule", e.recurrence_rule_json),
            attendees: json("attendee list", e.attendees_json),
            reminders: json("reminder list", e.reminders_json),
            conference_data: json("conference", e.conference_data_json),
            id: e.id,
            title: e.title,
            description: e.description,
            location: e.location,
            start_at: e.start_at,
            end_at: e.end_at,
            timezone: e.timezone,
            is_all_day: e.is_all_day,
            status: e.status,
            source,
        }
    }
}

/// `CalendarEventSearchItem.kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CalendarEventSearchKind {
    Event,
    ExternalEvent,
}

/// `CalendarEventSearchItem`: native events carry no `kind`.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEventSearchItemView {
    pub id: String,
    pub title: String,
    pub start_at: String,
    pub end_at: Option<String>,
    pub is_all_day: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub kind: Option<CalendarEventSearchKind>,
}

impl From<EventSearchHit> for CalendarEventSearchItemView {
    fn from(hit: EventSearchHit) -> Self {
        Self {
            id: hit.id,
            title: hit.title,
            start_at: hit.start_at,
            end_at: hit.end_at,
            is_all_day: hit.is_all_day,
            kind: hit
                .external
                .then_some(CalendarEventSearchKind::ExternalEvent),
        }
    }
}

/// `CalendarLinkedNote`.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarLinkedNoteView {
    pub id: String,
    pub title: String,
    pub emoji: Option<String>,
}

impl From<LinkedNote> for CalendarLinkedNoteView {
    fn from(n: LinkedNote) -> Self {
        Self {
            id: n.id,
            title: n.title,
            emoji: n.emoji,
        }
    }
}
