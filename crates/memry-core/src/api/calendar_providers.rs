//! Provider runtime on `VaultCalendar` (spec 007 CL070, CL073): the parts two
//! devices must agree on, as pure calls over what the shell fetched. The
//! shell owns HTTP, OAuth and the keychain (Constitution I).

use std::collections::HashMap;

use crate::api::calendar::VaultCalendar;
use crate::api::calendar_records::CalendarZone;
use crate::api::errors::StorageError;
use crate::domain::calendar_items::ical::{self, IcalZones};
use crate::domain::calendar_items::ics::{self, Validators};

/// One subscribed feed as this device sees it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CalendarFeedState {
    pub source_id: String,
    /// `idle` | `ok` | `error`.
    pub sync_status: String,
    pub last_synced_at: Option<String>,
    /// An `IcsFeedErrorCode`.
    pub last_error: Option<String>,
    pub next_refresh_ms: Option<i64>,
    pub event_count: i64,
    pub first_start_at: Option<String>,
    pub last_start_at: Option<String>,
}

/// A feed to fetch, with the validators of this device's last response.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CalendarFeedDue {
    pub source_id: String,
    pub url: String,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

/// A 200 response.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CalendarFetchedFeed {
    pub text: String,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

/// The zones a feed names that the shell resolved, and the device's own.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CalendarFeedZones {
    pub named: Vec<CalendarZone>,
    pub local: CalendarZone,
}

impl From<CalendarFeedZones> for IcalZones {
    fn from(zones: CalendarFeedZones) -> Self {
        Self {
            named: zones
                .named
                .into_iter()
                .map(|z| (z.identifier.clone(), z))
                .collect::<HashMap<_, _>>(),
            local: zones.local,
        }
    }
}

/// `normalizeIcsUrl`; `None` for anything that is not an http(s) link.
#[uniffi::export]
pub fn calendar_feed_normalize_url(input: String) -> Option<String> {
    ics::normalize_url(&input)
}

/// Every TZID (and `X-WR-TIMEZONE`) the text names, for the shell to resolve
/// into [`CalendarFeedZones`].
#[uniffi::export]
pub fn calendar_feed_zone_ids(text: String) -> Vec<String> {
    ical::zone_ids(&text)
}

fn not_a_calendar() -> StorageError {
    StorageError::Invalid {
        what: "not_a_calendar".to_owned(),
    }
}

fn parse(
    feed: &CalendarFetchedFeed,
    zones: CalendarFeedZones,
    now_ms: i64,
) -> Result<(ical::IcalFeed, Validators), StorageError> {
    let zones: IcalZones = zones.into();
    let parsed =
        ical::parse_feed(&feed.text, ics::window(now_ms), &zones).map_err(|_| not_a_calendar())?;
    Ok((
        parsed,
        Validators {
            etag: feed.etag.clone(),
            last_modified: feed.last_modified.clone(),
        },
    ))
}

#[uniffi::export]
impl VaultCalendar {
    /// `subscribeIcsCalendar` after the shell fetched `url` (normalised):
    /// parses first, so a link that is not a calendar saves nothing, then
    /// writes the synced source and this device's mirror. Returns the id.
    pub fn feed_subscribe(
        &self,
        url: String,
        title: Option<String>,
        feed: CalendarFetchedFeed,
        zones: CalendarFeedZones,
    ) -> Result<String, StorageError> {
        let url = ics::normalize_url(&url).ok_or(StorageError::Invalid {
            what: "invalid_url".to_owned(),
        })?;
        self.write(move |conn, device, now| {
            let (parsed, validators) = parse(&feed, zones, now)?;
            ics::subscribe(
                conn,
                &url,
                title.as_deref(),
                &parsed,
                &validators,
                device,
                now,
            )
        })
    }

    /// A 200 for a refresh: the mirror follows the feed. A body that does
    /// not parse is recorded as `not_a_calendar` and returned as that error.
    pub fn feed_record_fetch(
        &self,
        source_id: String,
        feed: CalendarFetchedFeed,
        zones: CalendarFeedZones,
    ) -> Result<u32, StorageError> {
        self.write(move |conn, _, now| match parse(&feed, zones, now) {
            Ok((parsed, validators)) => {
                let changed = ics::record_fetch(conn, &source_id, Ok((&parsed, &validators)), now)?;
                Ok(u32::try_from(changed).unwrap_or(u32::MAX))
            }
            Err(error) => {
                ics::record_fetch(conn, &source_id, Err("not_a_calendar"), now)?;
                Err(error)
            }
        })
    }

    /// A 304.
    pub fn feed_record_not_modified(&self, source_id: String) -> Result<(), StorageError> {
        self.write(move |conn, _, now| ics::record_not_modified(conn, &source_id, now))
    }

    /// A failed fetch: `unreachable`, `timeout`, `not_found`, … (desktop's
    /// `IcsFeedErrorCode`). The mirror stays as it was.
    pub fn feed_record_error(&self, source_id: String, code: String) -> Result<(), StorageError> {
        self.write(move |conn, _, now| {
            ics::record_fetch(conn, &source_id, Err(&code), now).map(|_| ())
        })
    }

    /// `updateIcsCalendar`: a synced rename or recolour (a colour name).
    pub fn feed_update(
        &self,
        source_id: String,
        title: Option<String>,
        color: Option<String>,
    ) -> Result<(), StorageError> {
        self.write(move |conn, device, now| {
            ics::update(
                conn,
                &source_id,
                title.as_deref(),
                color.as_deref(),
                device,
                now,
            )
        })
    }

    /// `unsubscribeIcsCalendar`.
    pub fn feed_unsubscribe(&self, source_id: String) -> Result<(), StorageError> {
        self.write(move |conn, device, now| ics::unsubscribe(conn, &source_id, device, now))
    }

    /// The feeds due for a fetch (all live ones with `force`); removed or
    /// hidden ones lose this device's mirror on the way.
    pub fn feeds_due(&self, force: bool) -> Result<Vec<CalendarFeedDue>, StorageError> {
        self.write(move |conn, _, now| {
            Ok(ics::due(conn, now, force)?
                .into_iter()
                .map(|d| CalendarFeedDue {
                    source_id: d.source_id,
                    url: d.url,
                    etag: d.validators.etag,
                    last_modified: d.validators.last_modified,
                })
                .collect())
        })
    }

    /// Every live subscription's state on this device.
    pub fn feed_states(&self) -> Result<Vec<CalendarFeedState>, StorageError> {
        self.write(|conn, _, _| {
            Ok(ics::states(conn)?
                .into_iter()
                .map(|s| CalendarFeedState {
                    source_id: s.source_id,
                    sync_status: s.sync_status,
                    last_synced_at: s.last_synced_at,
                    last_error: s.last_error,
                    next_refresh_ms: s.next_refresh_ms,
                    event_count: s.event_count,
                    first_start_at: s.first_start_at,
                    last_start_at: s.last_start_at,
                })
                .collect())
        })
    }
}
