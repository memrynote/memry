//! `CalendarService`: the native calendar reads and event writes of Electron's
//! `ipc/calendar-handlers.ts`, each over the open vault's `VaultCalendar` (`Search` for linked
//! notes). Inputs are checked as the handlers' zod schemas check them
//! (`packages/contracts/src/calendar-api.ts`). Every write queues its own sync row in the core
//! (`sync/calendar_push.rs`), so nothing here touches the outbox.

use std::sync::Arc;

use memry_core::api::calendar::VaultCalendar;
use memry_core::api::calendar_records::{
    CalendarEventChanges, CalendarEventDraft, CalendarTextChange,
};
use memry_core::api::errors::{AuthError, StorageError};
use memry_core::domain::calendar_items::projection::RangeInput;
use memry_core::seams::secure_store::SecureStore;
use memry_core::storage::repositories::instants;
use serde::{Deserialize, Deserializer};

use super::views::{
    CalendarEventColor, CalendarEventSearchItemView, CalendarEventView, CalendarExternalEventView,
    CalendarLinkedNoteView, CalendarProjectionItemView, CalendarSourceKind, CalendarSourceView,
};
use super::zone::system_zone;
use crate::error::{CoreError, FailureKind};
use crate::notes::property_definitions::PropertyDefinitions;
use crate::session::OpenVault;
use crate::settings::{SettingsError, SettingsService};

#[derive(Debug, thiserror::Error)]
pub enum CalendarError {
    /// The event or source is gone; the handlers answer `success: false` with their message.
    #[error("{0}")]
    NotFound(String),
    /// The input breaks the contract's schema, or the core refused the change.
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Storage(#[from] StorageError),
    #[error(transparent)]
    Auth(#[from] AuthError),
    #[error(transparent)]
    Settings(#[from] SettingsError),
}

impl CoreError for CalendarError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        match self {
            Self::NotFound(_) => (FailureKind::NotFound, "calendar_not_found"),
            Self::Invalid(_) => (FailureKind::Invalid, "invalid"),
            Self::Storage(error) => error.kind_and_code(),
            Self::Auth(error) => error.kind_and_code(),
            Self::Settings(_) => (FailureKind::Storage, "settings_failed"),
        }
    }
}

/// The core's `NotFound` is the handlers' not-found answer; its `Invalid` a refusal.
fn refused(error: StorageError) -> CalendarError {
    match error {
        StorageError::NotFound { what } => CalendarError::NotFound(what),
        StorageError::Invalid { what } => CalendarError::Invalid(what),
        other => CalendarError::Storage(other),
    }
}

fn invalid(what: &str) -> CalendarError {
    CalendarError::Invalid(what.to_owned())
}

/// zod's `.max(n)`: UTF-16 code units.
fn at_most(field: &str, text: Option<&str>, max: usize) -> Result<(), CalendarError> {
    match text {
        Some(text) if text.encode_utf16().count() > max => Err(CalendarError::Invalid(format!(
            "{field} is longer than {max} characters"
        ))),
        _ => Ok(()),
    }
}

/// zod's `z.iso.datetime()`, as far as the core's instant parser reads it.
fn instant(field: &str, text: &str) -> Result<i64, CalendarError> {
    instants::to_epoch_ms(text)
        .ok_or_else(|| CalendarError::Invalid(format!("{field} is not an ISO date-time")))
}

fn title(text: &str) -> Result<(), CalendarError> {
    if text.is_empty() {
        return Err(invalid("an event needs a title"));
    }
    at_most("the title", Some(text), 200)
}

/// A key the renderer sent, `null` included: `Some(None)` clears, an absent key stays `None`.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(deserializer).map(Some)
}

fn text_change(change: Option<Option<String>>) -> CalendarTextChange {
    match change {
        None => CalendarTextChange::Keep,
        Some(None) => CalendarTextChange::Clear,
        Some(Some(value)) => CalendarTextChange::Set { value },
    }
}

/// `GetCalendarRangeSchema`.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarRangeInput {
    pub start_at: String,
    pub end_at: String,
    #[serde(default)]
    pub include_unselected_sources: Option<bool>,
    #[serde(default)]
    pub include_completed_tasks: Option<bool>,
    #[serde(default)]
    pub include_external: Option<bool>,
    #[serde(default)]
    pub external_providers: Option<Vec<String>>,
}

/// `SearchCalendarEventsSchema`.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSearchInput {
    pub query: String,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub include_external: Option<bool>,
}

/// `CreateCalendarEventSchema`. `recurrenceRule` and `recurrenceExceptions` are not taken:
/// the core's event has no field for them, and no renderer path sends them.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarCreateEventInput {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    pub start_at: String,
    #[serde(default)]
    pub end_at: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub is_all_day: Option<bool>,
    #[serde(default)]
    pub target_calendar_id: Option<String>,
    #[serde(default)]
    pub color: Option<CalendarEventColor>,
}

/// `UpdateCalendarEventSchema`: an absent key keeps the field, `null` clears it.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarUpdateEventInput {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[specta(type = Option<String>)]
    pub description: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    #[specta(type = Option<String>)]
    pub location: Option<Option<String>>,
    #[serde(default)]
    pub start_at: Option<String>,
    #[serde(default, deserialize_with = "present")]
    #[specta(type = Option<String>)]
    pub end_at: Option<Option<String>>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub is_all_day: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    #[specta(type = Option<String>)]
    pub target_calendar_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    #[specta(type = Option<CalendarEventColor>)]
    pub color: Option<Option<CalendarEventColor>>,
}

/// `ListLinkedNotesSchema.sourceType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CalendarLinkedSourceType {
    Event,
    ExternalEvent,
}

/// `ListCalendarSourcesSchema`.
#[derive(Debug, Clone, Default, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarListSourcesInput {
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub kind: Option<CalendarSourceKind>,
    #[serde(default)]
    pub selected_only: Option<bool>,
}

/// `SearchCalendarEventsSchema.limit`'s default and bound.
const DEFAULT_SEARCH_LIMIT: u32 = 20;
const MAX_SEARCH_LIMIT: u32 = 100;

pub struct CalendarService {
    store: Arc<dyn SecureStore>,
    settings: SettingsService,
}

impl CalendarService {
    pub fn new(store: Arc<dyn SecureStore>, settings: SettingsService) -> Self {
        Self { store, settings }
    }

    fn calendar(&self, open: &OpenVault) -> Result<Arc<VaultCalendar>, CalendarError> {
        Ok(open.vault.calendar(self.store.clone())?)
    }

    /// `GET_RANGE`: the projection over the system zone, with the calendar's enabled date
    /// properties (`getCalendarEnabledPropertyNames`) and `showNotesOnCalendar`.
    pub fn range(
        &self,
        open: &OpenVault,
        input: CalendarRangeInput,
    ) -> Result<Vec<CalendarProjectionItemView>, CalendarError> {
        let start = instant("startAt", &input.start_at)?;
        let end = instant("endAt", &input.end_at)?;
        if input
            .external_providers
            .as_ref()
            .is_some_and(|p| p.len() > 64 || p.iter().any(String::is_empty))
        {
            return Err(invalid("externalProviders holds at most 64 provider ids"));
        }
        let enabled_property_names =
            PropertyDefinitions::open(open, self.store.clone())?.calendar_names();
        let settings = self.settings.read_group(Some(open), "calendar")?.value;
        let zone = system_zone(start, end);
        let range = RangeInput {
            start_at: input.start_at,
            end_at: input.end_at,
            include_unselected_sources: input.include_unselected_sources.unwrap_or(false),
            include_completed_tasks: input.include_completed_tasks.unwrap_or(false),
            include_external: input.include_external != Some(false),
            external_providers: input.external_providers,
            enabled_property_names,
            show_notes_by_created: settings
                .get("showNotesOnCalendar")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            local_timezone: zone.identifier.clone(),
        };
        Ok(self
            .calendar(open)?
            .project(range, zone)?
            .into_iter()
            .filter_map(CalendarProjectionItemView::from_core)
            .collect())
    }

    /// `SEARCH_EVENTS`, nearest to now first.
    pub fn search_events(
        &self,
        open: &OpenVault,
        input: CalendarSearchInput,
    ) -> Result<Vec<CalendarEventSearchItemView>, CalendarError> {
        if input.query.is_empty() {
            return Err(invalid("a search needs a query"));
        }
        let limit = input.limit.unwrap_or(DEFAULT_SEARCH_LIMIT);
        if !(1..=MAX_SEARCH_LIMIT).contains(&limit) {
            return Err(invalid("a search returns 1 to 100 events"));
        }
        let now = instants::to_iso8601(
            i64::try_from(crate::telemetry::time::now_ms()).unwrap_or(i64::MAX),
        )
        .ok_or_else(|| invalid("the system clock is out of range"))?;
        let hits = self.calendar(open)?.search_titles(
            input.query,
            limit as usize,
            now,
            input.include_external.unwrap_or(false),
        )?;
        Ok(hits.into_iter().map(Into::into).collect())
    }

    /// `CREATE_EVENT`.
    pub fn create_event(
        &self,
        open: &OpenVault,
        input: CalendarCreateEventInput,
    ) -> Result<CalendarEventView, CalendarError> {
        title(&input.title)?;
        at_most("the description", input.description.as_deref(), 5000)?;
        at_most("the location", input.location.as_deref(), 500)?;
        instant("startAt", &input.start_at)?;
        if let Some(end) = &input.end_at {
            instant("endAt", end)?;
        }
        if input.timezone.as_deref() == Some("") {
            return Err(invalid("an event needs a time zone"));
        }
        let draft = CalendarEventDraft {
            title: input.title,
            description: input.description,
            location: input.location,
            start_at: input.start_at,
            end_at: input.end_at,
            timezone: input.timezone.unwrap_or_else(|| "UTC".to_owned()),
            is_all_day: input.is_all_day.unwrap_or(false),
            target_calendar_id: input.target_calendar_id,
            color: input.color.map(CalendarEventColor::name),
        };
        let created = self.calendar(open)?.create_event(draft).map_err(refused)?;
        Ok(created.into())
    }

    /// `GET_EVENT`.
    pub fn event(
        &self,
        open: &OpenVault,
        id: String,
    ) -> Result<Option<CalendarEventView>, CalendarError> {
        Ok(self.calendar(open)?.event(id)?.map(Into::into))
    }

    /// `UPDATE_EVENT`: the event, and how many fields changed (`itemCount`).
    pub fn update_event(
        &self,
        open: &OpenVault,
        input: CalendarUpdateEventInput,
    ) -> Result<(CalendarEventView, usize), CalendarError> {
        if input.id.is_empty() {
            return Err(invalid("an update needs an event id"));
        }
        if let Some(text) = &input.title {
            title(text)?;
        }
        at_most(
            "the description",
            input.description.clone().flatten().as_deref(),
            5000,
        )?;
        at_most(
            "the location",
            input.location.clone().flatten().as_deref(),
            500,
        )?;
        if let Some(start) = &input.start_at {
            instant("startAt", start)?;
        }
        if let Some(Some(end)) = &input.end_at {
            instant("endAt", end)?;
        }
        if input.timezone.as_deref() == Some("") {
            return Err(invalid("an event needs a time zone"));
        }
        let changes = CalendarEventChanges {
            title: input.title,
            description: text_change(input.description),
            location: text_change(input.location),
            start_at: input.start_at,
            end_at: text_change(input.end_at),
            timezone: input.timezone,
            is_all_day: input.is_all_day,
            target_calendar_id: text_change(input.target_calendar_id),
            color: text_change(input.color.map(|c| c.map(CalendarEventColor::name))),
        };
        let (event, changed) = self
            .calendar(open)?
            .update_event_fields(input.id, changes)
            .map_err(refused)?;
        Ok((event.into(), changed.len()))
    }

    /// `DELETE_EVENT`.
    pub fn delete_event(&self, open: &OpenVault, id: String) -> Result<(), CalendarError> {
        self.calendar(open)?.delete_event(id).map_err(refused)
    }

    /// `LIST_LINKED_NOTES`.
    pub fn linked_notes(
        &self,
        open: &OpenVault,
        source_type: CalendarLinkedSourceType,
        source_id: &str,
    ) -> Result<Vec<CalendarLinkedNoteView>, CalendarError> {
        let source_type = match source_type {
            CalendarLinkedSourceType::Event => "event",
            CalendarLinkedSourceType::ExternalEvent => "external_event",
        };
        let notes = open.search.calendar_linked_notes(source_type, source_id)?;
        Ok(notes.into_iter().map(Into::into).collect())
    }

    /// `GET_EXTERNAL_EVENT`.
    pub fn external_event(
        &self,
        open: &OpenVault,
        id: String,
    ) -> Result<Option<CalendarExternalEventView>, CalendarError> {
        Ok(self.calendar(open)?.external_event(id)?.map(Into::into))
    }

    /// `PROMOTE_EXTERNAL_EVENT`: the editable copy's id. A refusal is `NotFound` or `Invalid`
    /// with the reason.
    pub fn promote(&self, open: &OpenVault, external_id: String) -> Result<String, CalendarError> {
        self.calendar(open)?.promote(external_id).map_err(refused)
    }

    /// `LIST_SOURCES`, filtered as `listCalendarSourceRows` filters.
    pub fn sources(
        &self,
        open: &OpenVault,
        input: CalendarListSourcesInput,
    ) -> Result<Vec<CalendarSourceView>, CalendarError> {
        Ok(self
            .calendar(open)?
            .sources()?
            .into_iter()
            .filter_map(CalendarSourceView::from_core)
            .filter(|s| input.provider.as_ref().is_none_or(|p| *p == s.provider))
            .filter(|s| input.kind.is_none_or(|k| k == s.kind))
            .filter(|s| !input.selected_only.unwrap_or(false) || s.is_selected)
            .collect())
    }

    /// `UPDATE_SOURCE_SELECTION`: the source after the change.
    pub fn set_source_selected(
        &self,
        open: &OpenVault,
        id: String,
        selected: bool,
    ) -> Result<CalendarSourceView, CalendarError> {
        let calendar = self.calendar(open)?;
        calendar
            .set_source_selected(id.clone(), selected)
            .map_err(refused)?;
        calendar
            .sources()?
            .into_iter()
            .find(|s| s.id == id)
            .and_then(CalendarSourceView::from_core)
            .ok_or_else(|| CalendarError::NotFound(format!("no calendar source {id}")))
    }
}
