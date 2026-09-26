//! Google and CalDAV on `VaultCalendar` (spec 007 CL070, CL071, CL074,
//! CL075): the push queue and each push's plan, connect / disconnect, and a
//! pull's answer applied. The shell makes the requests (Constitution I).

use std::collections::HashMap;

use serde_json::{Value, json};

use crate::api::calendar::VaultCalendar;
use crate::api::calendar_providers::CalendarFeedZones;
use crate::api::calendar_records::CalendarZone;
use crate::api::errors::StorageError;
use crate::domain::calendar_items::ical::{IcalWindow, IcalZones};
use crate::domain::calendar_items::ics;
use crate::domain::calendar_items::providers::{
    self, CALDAV, GOOGLE, Target, bindings, caldav, google, ical_write,
};
use crate::domain::calendar_items::write::mint_id;
use crate::storage::repositories::instants;

/// One item waiting to be written out.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CalendarPushItem {
    pub source_type: String,
    pub source_id: String,
    pub attempts: i64,
}

/// What to send for one item.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CalendarPushPlan {
    /// `none` (nothing to write; the item leaves the queue), `wait` (another
    /// provider or an account this device does not hold: stays queued),
    /// `upsert`, `delete`, `exclude` (CalDAV: PUT `body`, which drops one
    /// occurrence of a series, then retire the binding) or `fetch` (CalDAV:
    /// GET `href` and plan again with it as `base`).
    pub action: String,
    pub provider: String,
    /// Google calendar id or CalDAV collection URL.
    pub calendar_id: String,
    /// The remote event (Google id, or CalDAV object URL with
    /// `::recurrenceId` for one occurrence); `nil` for a new Google event.
    pub remote_event_id: Option<String>,
    /// CalDAV: the object URL to PUT, DELETE or GET.
    pub href: Option<String>,
    pub if_match: Option<String>,
    /// Google: the event resource as JSON. CalDAV: the iCalendar object.
    pub body: Option<String>,
    /// The binding a delete retires.
    pub binding_id: Option<String>,
}

/// A CalDAV object as the server answered it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CalendarCaldavObject {
    pub href: String,
    pub etag: Option<String>,
    pub data: String,
}

/// A calendar discovery found.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CalendarCaldavCalendar {
    pub url: String,
    pub display_name: String,
    pub color: Option<String>,
    pub timezone: Option<String>,
    pub supports_sync_collection: bool,
}

/// `connectCaldavAccount`'s input after discovery.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CalendarCaldavConnect {
    pub server_url: String,
    pub username: String,
    pub principal_url: String,
    pub home_url: String,
    pub preset: Option<String>,
    pub calendars: Vec<CalendarCaldavCalendar>,
    pub selected: Option<Vec<String>>,
}

/// A Google calendar from `calendarList`.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CalendarGoogleCalendar {
    pub id: String,
    pub title: String,
    pub timezone: Option<String>,
    pub color: Option<String>,
    pub is_primary: bool,
}

impl From<CalendarGoogleCalendar> for google::GoogleCalendar {
    fn from(c: CalendarGoogleCalendar) -> Self {
        Self {
            id: c.id,
            title: c.title,
            timezone: c.timezone,
            color: c.color,
            is_primary: c.is_primary,
        }
    }
}

/// `normalizeCaldavServerUrl`.
#[uniffi::export]
pub fn calendar_caldav_normalize_server(input: String) -> Option<String> {
    caldav::normalize_server_url(&input)
}

/// `caldavAccountId`: the keychain key for the account's password.
#[uniffi::export]
pub fn calendar_caldav_account_id(server_url: String, username: String) -> String {
    caldav::account_id(&server_url, &username)
}

fn target(source_type: String, source_id: String) -> Target {
    Target {
        source_type,
        source_id,
    }
}

fn plan(action: &str, provider: &str) -> CalendarPushPlan {
    CalendarPushPlan {
        action: action.to_owned(),
        provider: provider.to_owned(),
        calendar_id: String::new(),
        remote_event_id: None,
        href: None,
        if_match: None,
        body: None,
        binding_id: None,
    }
}

#[uniffi::export]
impl VaultCalendar {
    /// The items this device changed and has not written out yet.
    pub fn push_queue(&self) -> Result<Vec<CalendarPushItem>, StorageError> {
        self.write(|conn, _, _| {
            Ok(providers::queue(conn)?
                .into_iter()
                .map(|q| CalendarPushItem {
                    source_type: q.target.source_type,
                    source_id: q.target.source_id,
                    attempts: q.attempts,
                })
                .collect())
        })
    }

    /// What to send for one queued item. `held` lists the providers whose
    /// accounts this device holds (`google`, `caldav`); `zones` are the IANA
    /// zones the shell resolved (the device's first); `base` is the CalDAV
    /// object a `fetch` plan asked for.
    pub fn push_plan(
        &self,
        source_type: String,
        source_id: String,
        held: Vec<String>,
        zones: CalendarFeedZones,
        base: Option<CalendarCaldavObject>,
    ) -> Result<CalendarPushPlan, StorageError> {
        let target = target(source_type, source_id);
        self.write(move |conn, _, now| {
            let route = providers::route(conn, &target)?;
            let provider = route.provider.clone();
            if provider != GOOGLE && provider != CALDAV {
                return Ok(plan("none", &provider));
            }
            if !held.contains(&provider) {
                return Ok(plan("wait", &provider));
            }
            let device: &dyn crate::domain::calendar_items::zone::LocalZone = &zones.local;
            let named: HashMap<String, CalendarZone> = zones
                .named
                .iter()
                .map(|z| (z.identifier.clone(), z.clone()))
                .collect();
            let input =
                providers::upsert_input(conn, &target, device, &zones.local.identifier, &named)?;
            let binding = bindings::find(conn, &provider, &target)?;
            let stored =
                |b: &bindings::Binding| -> Result<Option<(String, Option<String>)>, StorageError> {
                    if let Some(base) = base.as_ref() {
                        return Ok(Some((base.data.clone(), base.etag.clone())));
                    }
                    Ok(
                        bindings::stored_object(conn, b)?
                            .map(|raw| (raw, b.remote_version.clone())),
                    )
                };
            let Some(input) = input else {
                let Some(binding) = binding else {
                    return Ok(plan("none", &provider));
                };
                let (href, rid) = bindings::caldav_parts(&binding.remote_event_id);
                let delete = CalendarPushPlan {
                    calendar_id: binding.remote_calendar_id.clone(),
                    remote_event_id: Some(binding.remote_event_id.clone()),
                    href: (provider == CALDAV).then(|| href.to_owned()),
                    if_match: binding.remote_version.clone(),
                    binding_id: Some(binding.id.clone()),
                    ..plan("delete", &provider)
                };
                // One occurrence of a CalDAV series: exclude it, keep the series.
                let Some(rid_ms) = rid
                    .filter(|_| provider == CALDAV)
                    .and_then(instants::to_epoch_ms)
                else {
                    return Ok(delete);
                };
                return Ok(match stored(&binding)? {
                    None => CalendarPushPlan {
                        action: "fetch".into(),
                        ..delete
                    },
                    Some((raw, etag)) => {
                        let ical_zones: IcalZones = zones.clone().into();
                        match ical_write::exclude_occurrence(&raw, rid_ms, &ical_zones, now) {
                            // Not a series any more: nothing left to drop.
                            Err(_) => CalendarPushPlan {
                                action: "none".into(),
                                ..delete
                            },
                            Ok(body) => CalendarPushPlan {
                                action: "exclude".into(),
                                if_match: Some(etag.unwrap_or_else(|| "*".to_owned())),
                                body: Some(body),
                                ..delete
                            },
                        }
                    }
                });
            };
            if binding
                .as_ref()
                .is_some_and(|b| bindings::same_as_snapshot(b, &input))
            {
                return Ok(plan("none", &provider));
            }
            let Some(calendar_id) = binding
                .as_ref()
                .map(|b| b.remote_calendar_id.clone())
                .or(route.remote_calendar_id.clone())
            else {
                // Desktop's last resort creates a managed "memrynote" calendar
                // in Google; the phone leaves that to desktop (§6 CL071).
                return Ok(plan("wait", &provider));
            };
            let item_zone = input["timezone"]
                .as_str()
                .and_then(|id| named.get(id))
                .or_else(|| {
                    (input["timezone"].as_str() == Some(zones.local.identifier.as_str()))
                        .then_some(&zones.local)
                });
            if provider == GOOGLE {
                return Ok(CalendarPushPlan {
                    calendar_id,
                    remote_event_id: binding.as_ref().map(|b| b.remote_event_id.clone()),
                    body: Some(google::event_body(&input, device).to_string()),
                    ..plan("upsert", GOOGLE)
                });
            }
            let mut if_match = binding.as_ref().and_then(|b| b.remote_version.clone());
            let (remote, body) = match binding.as_ref() {
                Some(b) => {
                    let (href, rid) = bindings::caldav_parts(&b.remote_event_id);
                    let rid_ms = rid.and_then(instants::to_epoch_ms);
                    let Some((raw, etag)) = stored(b)? else {
                        // `patchICalendar` needs what the server holds.
                        return Ok(CalendarPushPlan {
                            calendar_id,
                            remote_event_id: Some(b.remote_event_id.clone()),
                            href: Some(href.to_owned()),
                            ..plan("fetch", CALDAV)
                        });
                    };
                    // An object that exists is never created again (`etag ?? '*'`).
                    if_match = Some(etag.unwrap_or_else(|| "*".to_owned()));
                    let ical_zones: IcalZones = zones.clone().into();
                    let occurrence = rid_ms.map(|ms| (ms, &ical_zones));
                    let body = match ical_write::patch_object(
                        &raw, &input, item_zone, device, occurrence, now,
                    ) {
                        Ok(patched) => patched,
                        // A stored object that no longer parses: a whole
                        // series is rewritten, one occurrence is left alone.
                        Err(_) if rid.is_some() => return Ok(plan("none", CALDAV)),
                        Err(_) => {
                            ical_write::new_object(&input, &uid_of(href), item_zone, device, now)
                        }
                    };
                    (b.remote_event_id.clone(), body)
                }
                None => {
                    let uid = format!("memry-{}", mint_id());
                    let base = if calendar_id.ends_with('/') {
                        calendar_id.clone()
                    } else {
                        format!("{calendar_id}/")
                    };
                    (
                        format!("{base}{uid}.ics"),
                        ical_write::new_object(&input, &uid, item_zone, device, now),
                    )
                }
            };
            Ok(CalendarPushPlan {
                calendar_id,
                href: Some(bindings::caldav_parts(&remote).0.to_owned()),
                remote_event_id: Some(remote),
                if_match,
                body: Some(body),
                ..plan("upsert", CALDAV)
            })
        })
    }

    /// A push landed: the binding records the remote (`body` is what was
    /// sent; CalDAV keeps it as `caldavRaw`), the item leaves the queue.
    #[allow(clippy::too_many_arguments)]
    pub fn push_done(
        &self,
        source_type: String,
        source_id: String,
        provider: String,
        calendar_id: String,
        remote_event_id: String,
        etag: Option<String>,
        body: Option<String>,
        zones: CalendarFeedZones,
    ) -> Result<(), StorageError> {
        let target = target(source_type, source_id);
        self.write(move |conn, device, now| {
            let local: &dyn crate::domain::calendar_items::zone::LocalZone = &zones.local;
            let named: HashMap<String, CalendarZone> = zones
                .named
                .iter()
                .map(|z| (z.identifier.clone(), z.clone()))
                .collect();
            let mut snapshot =
                providers::upsert_input(conn, &target, local, &zones.local.identifier, &named)?
                    .unwrap_or_else(|| json!({}));
            if provider == CALDAV
                && let Some(body) = body
            {
                snapshot["caldavRaw"] = json!(body);
            }
            let written = bindings::Written {
                calendar_id,
                event_id: remote_event_id,
                etag,
            };
            bindings::record_push(conn, &provider, &target, &written, snapshot, device, now)?;
            providers::dequeue(conn, &target)
        })
    }

    /// A delete landed (or the remote was already gone).
    pub fn push_deleted(
        &self,
        source_type: String,
        source_id: String,
        binding_id: String,
    ) -> Result<(), StorageError> {
        let target = target(source_type, source_id);
        self.write(move |conn, device, now| {
            bindings::record_delete(conn, &binding_id, device, now)?;
            providers::dequeue(conn, &target)
        })
    }

    /// Nothing to write for the item.
    pub fn push_skip(&self, source_type: String, source_id: String) -> Result<(), StorageError> {
        let target = target(source_type, source_id);
        self.write(move |conn, _, _| providers::dequeue(conn, &target))
    }

    /// A push failed; the item stays queued with the reason.
    pub fn push_failed(
        &self,
        source_type: String,
        source_id: String,
        error: String,
    ) -> Result<(), StorageError> {
        let target = target(source_type, source_id);
        self.write(move |conn, _, _| providers::mark_failed(conn, &target, &error))
    }

    /// `connectCaldavAccount` after discovery. Returns the account id.
    pub fn caldav_connect(&self, input: CalendarCaldavConnect) -> Result<String, StorageError> {
        self.write(move |conn, device, now| {
            let connect = caldav::Connect {
                server_url: input.server_url,
                username: input.username,
                principal_url: input.principal_url,
                home_url: input.home_url,
                preset: input.preset,
                calendars: input
                    .calendars
                    .into_iter()
                    .map(|c| caldav::DiscoveredCalendar {
                        url: c.url,
                        display_name: c.display_name,
                        color: c.color,
                        timezone: c.timezone,
                        supports_sync_collection: c.supports_sync_collection,
                    })
                    .collect(),
                selected: input.selected,
            };
            caldav::connect(conn, &connect, device, now)
        })
    }

    pub fn caldav_disconnect(&self, account_id: String) -> Result<(), StorageError> {
        self.write(move |conn, device, now| caldav::disconnect(conn, &account_id, device, now))
    }

    /// A CalDAV pull applied: changed objects, removed hrefs, whether the
    /// listing was the whole window, the next cursor (`sync-token:…` /
    /// `ctag:…`).
    #[allow(clippy::too_many_arguments)]
    pub fn caldav_apply_pull(
        &self,
        source_id: String,
        calendar_url: String,
        objects: Vec<CalendarCaldavObject>,
        removed: Vec<String>,
        full: bool,
        cursor: Option<String>,
        zones: CalendarFeedZones,
    ) -> Result<u32, StorageError> {
        self.write(move |conn, device, now| {
            let local = zones.local.clone();
            let zone_id = local.identifier.clone();
            let ical_zones: IcalZones = zones.clone().into();
            let pull = caldav::Pull {
                objects: objects
                    .into_iter()
                    .map(|o| caldav::Object {
                        href: o.href,
                        etag: o.etag,
                        data: o.data,
                    })
                    .collect(),
                removed,
                full,
                cursor,
            };
            let window: IcalWindow = ics::window(now);
            let changed = caldav::apply_pull(
                conn,
                &source_id,
                &calendar_url,
                &pull,
                window,
                &ical_zones,
                &local,
                &zone_id,
                device,
                now,
            )?;
            Ok(u32::try_from(changed).unwrap_or(u32::MAX))
        })
    }

    /// A Google account connected on this device: its synced rows.
    pub fn google_connect(
        &self,
        email: String,
        name: Option<String>,
        primary: CalendarGoogleCalendar,
        calendars: Vec<CalendarGoogleCalendar>,
        device_zone_id: String,
    ) -> Result<(), StorageError> {
        self.write(move |conn, device, now| {
            let calendars: Vec<google::GoogleCalendar> =
                calendars.into_iter().map(Into::into).collect();
            google::connect(
                conn,
                &email,
                name.as_deref(),
                &primary.into(),
                &calendars,
                &device_zone_id,
                device,
                now,
            )
        })
    }

    pub fn google_disconnect(&self, email: String) -> Result<(), StorageError> {
        self.write(move |conn, device, now| google::disconnect(conn, &email, device, now))
    }

    /// One `events.list` answer (every page) applied. `events_json` is the
    /// array of Google event resources.
    pub fn google_apply_pull(
        &self,
        source_id: String,
        calendar_id: String,
        events_json: String,
        next_cursor: Option<String>,
        zones: CalendarFeedZones,
    ) -> Result<u32, StorageError> {
        let events: Vec<Value> =
            serde_json::from_str(&events_json).map_err(|e| StorageError::Invalid {
                what: e.to_string(),
            })?;
        self.write(move |conn, device, now| {
            let zone_id = zones.local.identifier.clone();
            let named: HashMap<String, CalendarZone> = zones
                .named
                .iter()
                .map(|z| (z.identifier.clone(), z.clone()))
                .collect();
            let changed = google::apply_pull(
                conn,
                &source_id,
                &calendar_id,
                &events,
                next_cursor.as_deref(),
                &zones.local,
                &zone_id,
                &named,
                device,
                now,
            )?;
            Ok(u32::try_from(changed).unwrap_or(u32::MAX))
        })
    }

    /// A source's pull failed; the synced row says so (`recordSyncError`).
    pub fn provider_source_error(
        &self,
        source_id: String,
        error: String,
    ) -> Result<(), StorageError> {
        let _ = error;
        self.write(move |conn, device, now| {
            let cursor: Option<String> = conn
                .query_row(
                    "SELECT sync_cursor FROM calendar_sources WHERE id = ?1",
                    [&source_id],
                    |row| row.get(0),
                )
                .map_err(crate::domain::notes::failed)?;
            google::set_source_cursor(conn, &source_id, cursor.as_deref(), "error", device, now)
        })
    }
}

/// `<href>` → the object's UID (its file name, as Memry names them).
fn uid_of(href: &str) -> String {
    href.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(href)
        .trim_end_matches(".ics")
        .to_owned()
}
