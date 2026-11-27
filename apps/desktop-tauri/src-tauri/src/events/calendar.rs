//! The calendar's change event (`calendar:changed`).

use serde::{Deserialize, Serialize};

/// `CalendarChangeEntityType`: what kind of record changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CalendarChangeEntityType {
    CalendarEvent,
    CalendarSource,
    CalendarBinding,
    CalendarExternalEvent,
    Projection,
}

/// A calendar record changed (`calendar:changed`): the calendar views refetch their range.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct CalendarChangedEvent {
    pub entity_type: CalendarChangeEntityType,
    pub id: String,
}
