//! `VaultCalendar`: every calendar read and record write over one vault (spec 007
//! CL012, CL013, CL015, CL018). Built by [`crate::api::vault::Vault::calendar`].
//!
//! Reads answer desktop's calendar IPC for the same rows: the range
//! projection (`GET_RANGE`), search, sources, one event, one imported event.
//! Writes emit the record shapes desktop's handlers emit, each in one
//! transaction with its outbox rows; the shell schedules a sync pass after
//! any of them (`requestVaultSync`).

use std::sync::Arc;

use serde_json::Value;

use crate::api::calendar_records::{
    CalendarEventChanges, CalendarEventDraft, CalendarEventRecord, CalendarExternalEventRecord,
    CalendarItem, CalendarLinkedProject, CalendarRangeRequest, CalendarSourceRecord, CalendarZone,
};
use crate::api::errors::{AuthError, StorageError};
use crate::crypto::keys;
use crate::domain::calendar_items::projection::{self, RangeInput};
use crate::domain::calendar_items::reads;
use crate::domain::calendar_items::selection::{self, SelectionRefusal};
use crate::domain::calendar_items::write::{self, EventPatch, NewEvent, PromoteRefusal};
use crate::seams::secure_store::{SecureStore, SecureStoreKey};
use crate::storage::Db;

/// Desktop's `MAX_SEARCH_RESULTS`.
const MAX_SEARCH_RESULTS: usize = 20;

/// Named `VaultCalendar`, not `Calendar`: the generated Swift type would
/// shadow `Foundation.Calendar` across the whole app.
#[derive(uniffi::Object)]
pub struct VaultCalendar {
    pub(crate) db: Db,
    pub(crate) device_id: String,
}

impl VaultCalendar {
    /// The device id comes from the keychain's signing key, as `Tasks` and
    /// `Inbox` derive it, so every write surface ticks the same clock entry.
    pub(crate) fn over(db: Db, store: &Arc<dyn SecureStore>) -> Result<Self, AuthError> {
        let secret =
            store
                .get(SecureStoreKey::DeviceSigningKey)?
                .ok_or(AuthError::MalformedToken {
                    what: "this device has no signing key, so it has no identity to write under"
                        .to_string(),
                })?;
        let public = secret
            .get(32..64)
            .ok_or(AuthError::MalformedToken {
                what: "device signing key is not 64 bytes".to_string(),
            })?
            .to_vec();
        Ok(Self {
            db,
            device_id: keys::local_device_id_hex(&public)?,
        })
    }

    fn write<T, F>(&self, f: F) -> Result<T, StorageError>
    where
        F: FnOnce(&rusqlite::Connection, &str, i64) -> Result<T, StorageError> + Send + 'static,
        T: Send + 'static,
    {
        let device = self.device_id.clone();
        self.db
            .call_blocking(move |conn| f(conn, &device, now_ms()))
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn range_input(request: CalendarRangeRequest, zone: &CalendarZone) -> RangeInput {
    RangeInput {
        start_at: request.start_at,
        end_at: request.end_at,
        include_unselected_sources: request.include_unselected_sources,
        include_external: true,
        external_providers: None,
        enabled_property_names: request.enabled_property_names,
        show_notes_by_created: request.show_notes_by_created,
        local_timezone: zone.identifier.clone(),
    }
}

fn invalid(what: &str) -> StorageError {
    StorageError::Invalid {
        what: what.to_owned(),
    }
}

#[uniffi::export]
impl VaultCalendar {
    /// `GET_RANGE`: every item overlapping `[start_at, end_at)`, sorted.
    pub fn range(
        &self,
        request: CalendarRangeRequest,
        zone: CalendarZone,
    ) -> Result<Vec<CalendarItem>, StorageError> {
        self.db.call_blocking(move |conn| {
            let input = range_input(request, &zone);
            Ok(projection::range(conn, &zone, &input)?
                .into_iter()
                .map(CalendarItem::from)
                .collect())
        })
    }

    /// `CalendarSearch`: the range (unselected sources included) filtered by
    /// title or preview, nearest to `now_ms` first, at most 20.
    pub fn search(
        &self,
        query: String,
        request: CalendarRangeRequest,
        zone: CalendarZone,
        now_ms: i64,
    ) -> Result<Vec<CalendarItem>, StorageError> {
        self.db.call_blocking(move |conn| {
            let mut input = range_input(request, &zone);
            input.include_unselected_sources = true;
            Ok(
                projection::search(conn, &zone, &input, &query, now_ms, MAX_SEARCH_RESULTS)?
                    .into_iter()
                    .map(CalendarItem::from)
                    .collect(),
            )
        })
    }

    /// `LIST_SOURCES`: live accounts and calendars, accounts first.
    pub fn sources(&self) -> Result<Vec<CalendarSourceRecord>, StorageError> {
        self.db.call_blocking(|conn| reads::sources(conn))
    }

    /// `GET_EVENT`, with its live binding.
    pub fn event(&self, id: String) -> Result<Option<CalendarEventRecord>, StorageError> {
        self.db.call_blocking(move |conn| reads::event(conn, &id))
    }

    /// `GET_EXTERNAL_EVENT` (read-only card details).
    pub fn external_event(
        &self,
        id: String,
    ) -> Result<Option<CalendarExternalEventRecord>, StorageError> {
        self.db
            .call_blocking(move |conn| reads::external_event(conn, &id))
    }

    /// Projects linking this event.
    pub fn linked_projects(
        &self,
        event_id: String,
    ) -> Result<Vec<CalendarLinkedProject>, StorageError> {
        self.db
            .call_blocking(move |conn| reads::linked_projects(conn, &event_id))
    }

    /// `CREATE_EVENT`. Returns the new event.
    pub fn create_event(
        &self,
        draft: CalendarEventDraft,
    ) -> Result<CalendarEventRecord, StorageError> {
        self.write(move |conn, device, now| {
            let id = write::create_event(
                conn,
                &NewEvent {
                    title: draft.title,
                    description: draft.description,
                    location: draft.location,
                    start_at: draft.start_at,
                    end_at: draft.end_at,
                    timezone: draft.timezone,
                    is_all_day: draft.is_all_day,
                    target_calendar_id: draft.target_calendar_id,
                    color: draft.color,
                },
                device,
                now,
            )?;
            reads::event(conn, &id)?
                .ok_or_else(|| invalid("the created event could not be read back"))
        })
    }

    /// `UPDATE_EVENT` (also move and resize).
    pub fn update_event(
        &self,
        id: String,
        changes: CalendarEventChanges,
    ) -> Result<CalendarEventRecord, StorageError> {
        self.write(move |conn, device, now| {
            let patch = EventPatch {
                title: changes.title,
                description: changes.description.into_patch(),
                location: changes.location.into_patch(),
                start_at: changes.start_at,
                end_at: changes.end_at.into_patch(),
                timezone: changes.timezone,
                is_all_day: changes.is_all_day,
                target_calendar_id: changes.target_calendar_id.into_patch(),
                color: changes.color.into_patch(),
            };
            write::update_event(conn, &id, &patch, device, now)?;
            reads::event(conn, &id)?.ok_or_else(|| invalid("the event could not be read back"))
        })
    }

    /// `DELETE_EVENT`.
    pub fn delete_event(&self, id: String) -> Result<(), StorageError> {
        self.write(move |conn, device, now| write::delete_event(conn, &id, device, now))
    }

    /// `PROMOTE_EXTERNAL_EVENT`: the id of the editable memrynote copy.
    pub fn promote(&self, external_event_id: String) -> Result<String, StorageError> {
        self.write(move |conn, device, now| {
            match write::promote(conn, &external_event_id, device, now)? {
                Ok(id) => Ok(id),
                Err(PromoteRefusal::NotFound) => Err(StorageError::NotFound {
                    what: "that imported event is no longer here".to_owned(),
                }),
                Err(PromoteRefusal::SourceMissing) => {
                    Err(invalid("that event's calendar is no longer connected"))
                }
                Err(PromoteRefusal::ReadOnly) => {
                    Err(invalid("events from a subscribed calendar are read-only"))
                }
            }
        })
    }

    /// `UPDATE_SOURCE_SELECTION`.
    pub fn set_source_selected(
        &self,
        source_id: String,
        selected: bool,
    ) -> Result<(), StorageError> {
        self.write(move |conn, device, now| {
            match selection::set_source_selection(conn, &source_id, selected, device, now)? {
                Ok(()) => Ok(()),
                Err(SelectionRefusal::NotFound) => Err(StorageError::NotFound {
                    what: "that calendar is no longer here".to_owned(),
                }),
                Err(SelectionRefusal::NotACalendar) => {
                    Err(invalid("only calendars can be shown or hidden"))
                }
            }
        })
    }

    /// A synced calendar setting (D3a) as JSON text, or `nil` when no device
    /// has set it. `path` must start with `calendar.`.
    pub fn setting(&self, path: String) -> Result<Option<String>, StorageError> {
        if !path.starts_with("calendar.") {
            return Err(invalid("only calendar settings are read here"));
        }
        self.db.call_blocking(move |conn| {
            Ok(crate::domain::settings::read(conn, &path)?.map(|value| value.to_string()))
        })
    }

    /// Writes one synced calendar setting (D3a), its own field clock ticked.
    pub fn set_setting(&self, path: String, value_json: String) -> Result<(), StorageError> {
        if !path.starts_with("calendar.") {
            return Err(invalid("only calendar settings are written here"));
        }
        let value: Value =
            serde_json::from_str(&value_json).map_err(|_| invalid("a setting value is JSON"))?;
        self.write(move |conn, device, now| {
            crate::domain::settings::set(conn, &path, value, device, now).map(|_| ())
        })
    }
}
