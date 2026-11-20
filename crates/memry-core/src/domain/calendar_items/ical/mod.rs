//! VEVENT → concrete instances, shared by subscribed feeds and CalDAV (spec
//! 007 CL070, desktop `ical/ical-events.ts` + `ics/ics-feed.ts`): series
//! expansion (RRULE, RDATE, EXDATE, RECURRENCE-ID overrides), cancelled
//! instances dropped, runaway rules capped.
//!
//! Zones: the core has no zone database. The shell hands in the IANA zones a
//! feed names (see [`zone_ids`]) and the device's own; a TZID the object
//! defines in a VTIMEZONE uses that definition, as `ical.js` does. A TZID
//! neither side knows falls back to floating time, which reads in the
//! object's `X-WR-TIMEZONE` when that is a known zone, else on the device.

pub mod budget;
pub mod occurrence;
pub mod parse;
pub mod rrule;
mod rrule_days;
mod series;
pub mod vtimezone;

use std::collections::{HashMap, HashSet};

use parse::{
    Component, IcalTime, MAX_TZID_LEN, NotACalendar, TimeZoneRef, parse_calendar, parse_duration,
    time_of,
};
use series::{Context, expand_series, overrides_moved_into_window, place};
use sha2::{Digest, Sha256};

use super::projection::iso;
use super::zone::{LocalZone, local_to_utc};
use crate::api::calendar_records::CalendarZone;
use crate::domain::calendar::CivilDate;

const MAX_RECURRENCE_STEPS: usize = 50_000;
const MAX_INSTANCES_PER_SERIES: usize = 5_000;

/// `ICalExpansionWindow`, as epoch milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IcalWindow {
    pub start_ms: i64,
    pub end_ms: i64,
}

/// `ICalEventInstance`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IcalInstance {
    pub remote_event_id: String,
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub start_at: String,
    pub end_at: Option<String>,
    pub is_all_day: bool,
    pub timezone: Option<String>,
    /// `confirmed` | `tentative`.
    pub status: String,
    pub remote_updated_at: Option<String>,
}

/// `IcsFeed`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IcalFeed {
    pub name: Option<String>,
    pub timezone: Option<String>,
    pub refresh_interval_ms: Option<i64>,
    pub events: Vec<IcalInstance>,
}

/// Why a feed or object reads as nothing. The codes are desktop's
/// `IcsFeedErrorCode`s.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeedError {
    NotACalendar,
    /// Reading it would pass [`budget::MAX_STEPS`],
    /// [`budget::MAX_OUTPUT_BYTES`] or [`budget::MAX_INSTANCES_PER_READ`].
    TooLarge,
}

impl FeedError {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotACalendar => "not_a_calendar",
            Self::TooLarge => "too_large",
        }
    }
}

impl From<NotACalendar> for FeedError {
    fn from(_: NotACalendar) -> Self {
        Self::NotACalendar
    }
}

/// The zones the shell resolved: IANA names it knows, and the device's.
pub struct IcalZones {
    pub named: HashMap<String, CalendarZone>,
    pub local: CalendarZone,
}

/// Every TZID and `X-WR-TIMEZONE` the text names, for the shell to resolve.
/// A name past [`MAX_TZID_LEN`] is no zone and is left out.
pub fn zone_ids(text: &str) -> Vec<String> {
    let Ok(root) = parse_calendar(text) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut push = |id: String| {
        if id.len() <= MAX_TZID_LEN && seen.insert(id.clone()) {
            ids.push(id);
        }
    };
    if let Some(zone) = root.text("X-WR-TIMEZONE") {
        push(zone);
    }
    fn walk(component: &Component, push: &mut dyn FnMut(String)) {
        for property in &component.properties {
            if let Some(tzid) = property.param("TZID") {
                push(tzid.trim_start_matches('/').to_owned());
            }
        }
        for child in &component.children {
            walk(child, push);
        }
    }
    walk(&root, &mut push);
    ids
}

/// How an instance is keyed: `(uid, recurrence id as ISO)`.
pub type InstanceKey<'a> = &'a dyn Fn(&str, Option<&str>) -> String;

/// `uidInstanceKey`.
pub fn uid_instance_key(uid: &str, recurrence_id: Option<&str>) -> String {
    recurrence_id.map_or_else(|| uid.to_owned(), |rid| format!("{uid}::{rid}"))
}

/// `parseIcsFeed`, within [`budget`].
pub fn parse_feed(
    text: &str,
    window: IcalWindow,
    zones: &IcalZones,
) -> Result<IcalFeed, FeedError> {
    let _scope = budget::Scope::enter();
    let root = parse_calendar(text)?;
    let calendar_zone = root.text("X-WR-TIMEZONE");
    let duration = |name: &str| {
        root.first(name)
            .and_then(|p| parse_duration(&p.value))
            .map(|s| s * 1_000)
    };
    let key = uid_instance_key;
    Ok(IcalFeed {
        name: root.text("X-WR-CALNAME").or_else(|| root.text("NAME")),
        timezone: calendar_zone.clone(),
        refresh_interval_ms: duration("REFRESH-INTERVAL").or_else(|| duration("X-PUBLISHED-TTL")),
        events: expand_calendar_events(&root, window, calendar_zone.as_deref(), &key, zones)?,
    })
}

/// Resolves times for one object.
struct Resolver<'a> {
    zones: &'a IcalZones,
    defined: HashMap<String, CalendarZone>,
}

impl Resolver<'_> {
    fn known(&self, id: &str) -> Option<&CalendarZone> {
        self.defined.get(id).or_else(|| self.zones.named.get(id))
    }

    /// The zone floating wall times read in.
    fn fallback<'z>(&'z self, unresolved: Option<&str>) -> &'z CalendarZone {
        unresolved
            .and_then(|id| self.zones.named.get(id))
            .unwrap_or(&self.zones.local)
    }

    fn zone_of<'z>(
        &'z self,
        time: &IcalTime,
        unresolved: Option<&str>,
    ) -> Option<&'z CalendarZone> {
        match &time.zone {
            TimeZoneRef::Utc => None,
            TimeZoneRef::Named(id) => {
                Some(self.known(id).unwrap_or_else(|| self.fallback(unresolved)))
            }
            TimeZoneRef::Floating => Some(self.fallback(unresolved)),
        }
    }

    /// `toInstant`, in epoch milliseconds (DATE → UTC midnight).
    fn instant_ms(&self, time: &IcalTime, unresolved: Option<&str>) -> i64 {
        WallClock {
            zone: self.zone_of(time, unresolved),
            is_date: time.is_date,
        }
        .instant_ms(time.wall_seconds())
    }
}

/// The wall clock of one time's zone, looked up once: a series turns each
/// occurrence's wall seconds into an instant without resolving its zone again.
#[derive(Clone, Copy)]
struct WallClock<'z> {
    /// `None` for UTC.
    zone: Option<&'z CalendarZone>,
    is_date: bool,
}

impl WallClock<'_> {
    fn instant_ms(self, wall: i64) -> i64 {
        if self.is_date {
            return wall.div_euclid(86_400) * 86_400_000;
        }
        match self.zone {
            None => wall * 1_000,
            Some(zone) => wall_to_utc_ms(zone, wall),
        }
    }

    fn wall_of(self, utc_ms: i64) -> i64 {
        match self.zone {
            None => utc_ms.div_euclid(1_000),
            Some(zone) => (utc_ms + zone.offset_ms(utc_ms)).div_euclid(1_000),
        }
    }
}

fn wall_to_utc_ms(zone: &dyn LocalZone, wall: i64) -> i64 {
    let date = CivilDate::from_days_since_epoch(wall.div_euclid(86_400));
    let rest = wall.rem_euclid(86_400);
    let hour = u32::try_from(rest / 3_600).unwrap_or(0);
    let minute = u32::try_from(rest % 3_600 / 60).unwrap_or(0);
    local_to_utc(zone, date, hour, minute) + (rest % 60) * 1_000
}

fn event_uid(event: &Component) -> String {
    if let Some(uid) = event.text("UID") {
        return uid;
    }
    // `ICAL.Time#toString()`: `2026-04-03`, `2026-04-03T10:00:00`, `…Z` for UTC.
    let start = event
        .first("DTSTART")
        .and_then(time_of)
        .map_or_else(String::new, |t| {
            if t.is_date {
                return t.date.key();
            }
            let utc = if t.zone == TimeZoneRef::Utc { "Z" } else { "" };
            format!(
                "{}T{:02}:{:02}:{:02}{utc}",
                t.date.key(),
                t.hour,
                t.minute,
                t.second
            )
        });
    let fingerprint = format!("{start}|{}", event.text("SUMMARY").unwrap_or_default());
    let digest = hex::encode(Sha256::digest(fingerprint.as_bytes()));
    format!("no-uid:{}", &digest[..16])
}

/// A TZID or calendar zone the shell knows, for floating fallbacks.
fn unresolved_zone<'a>(
    event: &'a Component,
    calendar_zone: Option<&'a str>,
    zones: &IcalZones,
) -> Option<&'a str> {
    let candidate = event
        .first("DTSTART")
        .and_then(|p| p.param("TZID"))
        .map(|id| id.trim_start_matches('/'))
        .or(calendar_zone);
    candidate.filter(|id| zones.named.contains_key(*id))
}

struct Series<'a> {
    master: Option<&'a Component>,
    overrides: Vec<&'a Component>,
}

/// `expandCalendarEvents`, within [`budget`]: `TooLarge` once it is spent.
pub fn expand_calendar_events(
    root: &Component,
    window: IcalWindow,
    calendar_zone: Option<&str>,
    key_for: InstanceKey<'_>,
    zones: &IcalZones,
) -> Result<Vec<IcalInstance>, FeedError> {
    let _scope = budget::Scope::enter();
    let events = expand(root, window, calendar_zone, key_for, zones);
    if budget::spent() {
        return Err(FeedError::TooLarge);
    }
    Ok(events)
}

fn expand(
    root: &Component,
    window: IcalWindow,
    calendar_zone: Option<&str>,
    key_for: InstanceKey<'_>,
    zones: &IcalZones,
) -> Vec<IcalInstance> {
    let last_year = CivilDate::from_days_since_epoch(window.end_ms.div_euclid(86_400_000)).year + 1;
    let resolver = Resolver {
        zones,
        defined: root
            .children_named("VTIMEZONE")
            .filter_map(|tz| vtimezone::zone_from_vtimezone(tz, last_year))
            .map(|zone| (zone.identifier.clone(), zone))
            .collect(),
    };
    let mut order: Vec<String> = Vec::new();
    let mut series: HashMap<String, Series<'_>> = HashMap::new();
    for event in root.children_named("VEVENT") {
        if !budget::step(1 + event.properties.len()) {
            return Vec::new();
        }
        let uid = event_uid(event);
        let entry = series.entry(uid.clone()).or_insert_with(|| {
            order.push(uid.clone());
            Series {
                master: None,
                overrides: Vec::new(),
            }
        });
        if event.has("RECURRENCE-ID") {
            entry.overrides.push(event);
        } else {
            entry.master = Some(event);
        }
    }

    let mut events = Vec::new();
    for uid in &order {
        let Some(entry) = series.get(uid) else {
            continue;
        };
        if let Some(master) = entry.master {
            if !master.has("DTSTART") {
                continue;
            }
            if master.has("RRULE") || master.has("RDATE") {
                let unresolved = unresolved_zone(master, calendar_zone, zones);
                let context = Context {
                    uid,
                    unresolved,
                    key_for,
                    resolver: &resolver,
                };
                let expanded = expand_series(master, &entry.overrides, &context, window);
                let moved =
                    overrides_moved_into_window(&entry.overrides, &expanded, &context, window);
                events.extend(expanded);
                events.extend(moved);
                continue;
            }
        }
        let singles: Vec<&Component> = entry
            .master
            .map_or_else(|| entry.overrides.clone(), |m| vec![m]);
        for event in singles {
            let Some(start) = event.first("DTSTART").and_then(time_of) else {
                continue;
            };
            let unresolved = unresolved_zone(event, calendar_zone, zones);
            let context = Context {
                uid,
                unresolved,
                key_for,
                resolver: &resolver,
            };
            let key = match event.first("RECURRENCE-ID").and_then(time_of) {
                Some(rid) => key_for(uid, Some(&iso(resolver.instant_ms(&rid, unresolved)))),
                None => key_for(uid, None),
            };
            if let Some(instance) = place(event, &start, key, &context, window) {
                if !budget::emit(series::text_bytes(&instance)) {
                    return Vec::new();
                }
                events.push(instance);
            }
        }
    }
    events
}
