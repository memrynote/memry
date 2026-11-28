//! The native calendar commands of `ipc/calendar-handlers.ts` (#3546 29b): the range, event
//! search and CRUD, linked notes, an imported event's details and its promotion, and the
//! source list and selection, each one call of `memry_desktop::calendar::service`. A create, an
//! update and a delete send `CalendarChangedEvent` after the write and track their telemetry
//! event, as the handlers did. The mutations answer the handlers' `{ success, ..., error? }`;
//! a missing event or source is `success: false` with the handlers' message, and any other
//! failure throws, which the renderer turns into `success: false` as `withDb` did.

use std::sync::Arc;

use memry_desktop::calendar::service::{
    CalendarCreateEventInput, CalendarError, CalendarLinkedSourceType, CalendarListSourcesInput,
    CalendarRangeInput, CalendarSearchInput, CalendarService, CalendarUpdateEventInput,
};
use memry_desktop::calendar::views::{
    CalendarEventSearchItemView, CalendarEventView, CalendarExternalEventView,
    CalendarLinkedNoteView, CalendarProjectionItemView, CalendarSourceView,
};
use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::session::OpenVault;
use memry_desktop::telemetry::Service;
use memry_desktop::telemetry::events::Metrics;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use super::blocking;
use super::error::CommandError;
use super::notes::open_vault;
use crate::events::{CalendarChangeEntityType, CalendarChangedEvent, broadcast};

/// `CalendarRangeResponse`.
#[derive(Debug, Serialize, specta::Type)]
pub struct CalendarRangeView {
    pub items: Vec<CalendarProjectionItemView>,
}

/// `CalendarEventSearchResponse`.
#[derive(Debug, Serialize, specta::Type)]
pub struct CalendarEventSearchView {
    pub events: Vec<CalendarEventSearchItemView>,
}

/// `CalendarEventMutationResponse`.
#[derive(Debug, Serialize, specta::Type)]
pub struct CalendarEventMutationView {
    pub success: bool,
    pub event: Option<CalendarEventView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub error: Option<String>,
}

/// `CalendarDeleteResponse`.
#[derive(Debug, Serialize, specta::Type)]
pub struct CalendarDeleteView {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub error: Option<String>,
}

/// `ListLinkedNotesSchema`.
#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarLinkedNotesInput {
    pub source_type: CalendarLinkedSourceType,
    pub source_id: String,
}

/// `CalendarLinkedNotesResponse`.
#[derive(Debug, Serialize, specta::Type)]
pub struct CalendarLinkedNotesView {
    pub notes: Vec<CalendarLinkedNoteView>,
}

/// `GetExternalEventSchema` and `PromoteExternalEventSchema`.
#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarExternalEventInput {
    pub external_event_id: String,
}

/// `GetExternalEventResponse`.
#[derive(Debug, Serialize, specta::Type)]
pub struct CalendarExternalEventDetailsView {
    pub event: Option<CalendarExternalEventView>,
}

/// `PromoteExternalEventResponse`.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarPromoteView {
    pub success: bool,
    pub event_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub error: Option<String>,
}

/// `CalendarSourceListResponse`.
#[derive(Debug, Serialize, specta::Type)]
pub struct CalendarSourceListView {
    pub sources: Vec<CalendarSourceView>,
}

/// `UpdateCalendarSourceSelectionSchema`.
#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSourceSelectionInput {
    pub id: String,
    pub is_selected: bool,
}

/// `CalendarSourceMutationResponse`.
#[derive(Debug, Serialize, specta::Type)]
pub struct CalendarSourceMutationView {
    pub success: bool,
    pub source: Option<CalendarSourceView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub error: Option<String>,
}

fn failed(error: &CalendarError) -> CommandError {
    CommandError::from_core(error)
}

fn t<R: Runtime>(app: &AppHandle<R>, key: &str) -> String {
    i18n::t(app.state::<Arc<LocaleService>>().get(), key, &Args::new())
}

/// Runs `work` on the open vault and the calendar service off the async runtime.
async fn on_calendar<R: Runtime, T: Send + 'static>(
    app: AppHandle<R>,
    command: &'static str,
    work: impl FnOnce(&AppHandle<R>, &CalendarService, &OpenVault) -> Result<T, CommandError>
    + Send
    + 'static,
) -> Result<T, CommandError> {
    blocking(command, move || {
        let open = open_vault(&app)?;
        let service = app.state::<Arc<CalendarService>>().inner().clone();
        work(&app, &service, &open)
    })
    .await
}

/// `trackCalendar` and the delete's `trackMainEvent` (`calendar-handlers.ts:211,292,319`).
fn track<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
    action: &str,
    source: Option<&str>,
    item_count: Option<usize>,
) {
    let Some(telemetry) = app.try_state::<Arc<Service>>() else {
        return;
    };
    let mut event = Service::event(name, "calendar", action);
    event.source = source.map(str::to_owned);
    event.result = Some("success".to_owned());
    #[allow(clippy::cast_precision_loss)]
    let metrics = item_count.map(|count| Metrics {
        item_count: Some(count as f64),
        ..Metrics::default()
    });
    event.metrics = metrics;
    telemetry.track_main_event(event);
}

fn changed<R: Runtime>(app: &AppHandle<R>, id: String) {
    broadcast(
        app,
        CalendarChangedEvent {
            entity_type: CalendarChangeEntityType::CalendarEvent,
            id,
        },
    );
}

/// `calendar:get-range`.
#[tauri::command]
#[specta::specta]
pub async fn calendar_get_range<R: Runtime>(
    app: AppHandle<R>,
    input: CalendarRangeInput,
) -> Result<CalendarRangeView, CommandError> {
    on_calendar(app, "calendar_get_range", |_, service, open| {
        let items = service.range(open, input).map_err(|e| failed(&e))?;
        Ok(CalendarRangeView { items })
    })
    .await
}

/// `calendar:search-events`.
#[tauri::command]
#[specta::specta]
pub async fn calendar_search_events<R: Runtime>(
    app: AppHandle<R>,
    input: CalendarSearchInput,
) -> Result<CalendarEventSearchView, CommandError> {
    on_calendar(app, "calendar_search_events", |_, service, open| {
        let events = service.search_events(open, input).map_err(|e| failed(&e))?;
        Ok(CalendarEventSearchView { events })
    })
    .await
}

/// `calendar:create-event`.
#[tauri::command]
#[specta::specta]
pub async fn calendar_create_event<R: Runtime>(
    app: AppHandle<R>,
    input: CalendarCreateEventInput,
) -> Result<CalendarEventMutationView, CommandError> {
    on_calendar(app, "calendar_create_event", |app, service, open| {
        let event = service.create_event(open, input).map_err(|e| failed(&e))?;
        changed(app, event.id.clone());
        track(
            app,
            "calendar_event_created",
            "created",
            Some("calendar_page"),
            None,
        );
        Ok(CalendarEventMutationView {
            success: true,
            event: Some(event),
            error: None,
        })
    })
    .await
}

/// `calendar:get-event`: `null` when there is no such event.
#[tauri::command]
#[specta::specta]
pub async fn calendar_get_event<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<Option<CalendarEventView>, CommandError> {
    on_calendar(app, "calendar_get_event", |_, service, open| {
        service.event(open, id).map_err(|e| failed(&e))
    })
    .await
}

/// `calendar:update-event` (also move and resize).
#[tauri::command]
#[specta::specta]
pub async fn calendar_update_event<R: Runtime>(
    app: AppHandle<R>,
    input: CalendarUpdateEventInput,
) -> Result<CalendarEventMutationView, CommandError> {
    on_calendar(
        app,
        "calendar_update_event",
        |app, service, open| match service.update_event(open, input) {
            Ok((event, count)) => {
                changed(app, event.id.clone());
                track(app, "calendar_event_updated", "updated", None, Some(count));
                Ok(CalendarEventMutationView {
                    success: true,
                    event: Some(event),
                    error: None,
                })
            }
            Err(CalendarError::NotFound(_)) => Ok(CalendarEventMutationView {
                success: false,
                event: None,
                error: Some(t(app, "errors:calendar.eventNotFound")),
            }),
            Err(error) => Err(failed(&error)),
        },
    )
    .await
}

/// `calendar:delete-event`.
#[tauri::command]
#[specta::specta]
pub async fn calendar_delete_event<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<CalendarDeleteView, CommandError> {
    on_calendar(
        app,
        "calendar_delete_event",
        |app, service, open| match service.delete_event(open, id.clone()) {
            Ok(()) => {
                changed(app, id);
                track(
                    app,
                    "calendar_event_deleted",
                    "deleted",
                    Some("calendar_page"),
                    None,
                );
                Ok(CalendarDeleteView {
                    success: true,
                    error: None,
                })
            }
            Err(CalendarError::NotFound(_)) => Ok(CalendarDeleteView {
                success: false,
                error: Some(t(app, "errors:calendar.eventNotFound")),
            }),
            Err(error) => Err(failed(&error)),
        },
    )
    .await
}

/// `calendar:list-linked-notes`.
#[tauri::command]
#[specta::specta]
pub async fn calendar_list_linked_notes<R: Runtime>(
    app: AppHandle<R>,
    input: CalendarLinkedNotesInput,
) -> Result<CalendarLinkedNotesView, CommandError> {
    on_calendar(
        app,
        "calendar_list_linked_notes",
        move |_, service, open| {
            let notes = service
                .linked_notes(open, input.source_type, &input.source_id)
                .map_err(|e| failed(&e))?;
            Ok(CalendarLinkedNotesView { notes })
        },
    )
    .await
}

/// `calendar:get-external-event`.
#[tauri::command]
#[specta::specta]
pub async fn calendar_get_external_event<R: Runtime>(
    app: AppHandle<R>,
    input: CalendarExternalEventInput,
) -> Result<CalendarExternalEventDetailsView, CommandError> {
    on_calendar(app, "calendar_get_external_event", |_, service, open| {
        let event = service
            .external_event(open, input.external_event_id)
            .map_err(|e| failed(&e))?;
        Ok(CalendarExternalEventDetailsView { event })
    })
    .await
}

/// `calendar:promote-external-event`. A gone, read-only or orphaned mirror answers
/// `success: false` with the reason, as the handler's three error classes did. It sends no
/// calendar event, as the handler sent none.
#[tauri::command]
#[specta::specta]
pub async fn calendar_promote_external_event<R: Runtime>(
    app: AppHandle<R>,
    input: CalendarExternalEventInput,
) -> Result<CalendarPromoteView, CommandError> {
    on_calendar(
        app,
        "calendar_promote_external_event",
        |_, service, open| {
            let refused = |error: String| CalendarPromoteView {
                success: false,
                event_id: None,
                error: Some(error),
            };
            match service.promote(open, input.external_event_id) {
                Ok(id) => Ok(CalendarPromoteView {
                    success: true,
                    event_id: Some(id),
                    error: None,
                }),
                Err(CalendarError::NotFound(why)) => {
                    tracing::warn!("promote_external_event: {why}");
                    Ok(refused(why))
                }
                Err(CalendarError::Invalid(why)) => Ok(refused(why)),
                Err(error) => Err(failed(&error)),
            }
        },
    )
    .await
}

/// `calendar:list-sources`.
#[tauri::command]
#[specta::specta]
pub async fn calendar_list_sources<R: Runtime>(
    app: AppHandle<R>,
    input: Option<CalendarListSourcesInput>,
) -> Result<CalendarSourceListView, CommandError> {
    on_calendar(app, "calendar_list_sources", |_, service, open| {
        let sources = service
            .sources(open, input.unwrap_or_default())
            .map_err(|e| failed(&e))?;
        Ok(CalendarSourceListView { sources })
    })
    .await
}

/// `calendar:update-source-selection`. It sends no calendar event, as the handler sent none.
#[tauri::command]
#[specta::specta]
pub async fn calendar_update_source_selection<R: Runtime>(
    app: AppHandle<R>,
    input: CalendarSourceSelectionInput,
) -> Result<CalendarSourceMutationView, CommandError> {
    on_calendar(
        app,
        "calendar_update_source_selection",
        move |app, service, open| {
            let refused = |key: &str| CalendarSourceMutationView {
                success: false,
                source: None,
                error: Some(t(app, key)),
            };
            match service.set_source_selected(open, input.id, input.is_selected) {
                Ok(source) => Ok(CalendarSourceMutationView {
                    success: true,
                    source: Some(source),
                    error: None,
                }),
                Err(CalendarError::NotFound(_)) => Ok(refused("errors:calendar.sourceNotFound")),
                Err(CalendarError::Invalid(_)) => {
                    Ok(refused("errors:calendar.onlySourcesSelectable"))
                }
                Err(error) => Err(failed(&error)),
            }
        },
    )
    .await
}
