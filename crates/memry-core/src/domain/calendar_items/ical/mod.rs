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

pub mod parse;
pub mod rrule;
mod rrule_days;
pub mod vtimezone;

use std::collections::HashMap;

use parse::{
    Component, IcalTime, NotACalendar, TimeZoneRef, parse_calendar, parse_duration, time_of,
    times_of,
};
use rrule::{Occurrences, Until, parse_rule};
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

/// The zones the shell resolved: IANA names it knows, and the device's.
pub struct IcalZones {
    pub named: HashMap<String, CalendarZone>,
    pub local: CalendarZone,
}

/// Every TZID and `X-WR-TIMEZONE` the text names, for the shell to resolve.
pub fn zone_ids(text: &str) -> Vec<String> {
    let Ok(root) = parse_calendar(text) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = Vec::new();
    let mut push = |id: String| {
        if !ids.contains(&id) {
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

/// `parseIcsFeed`.
pub fn parse_feed(
    text: &str,
    window: IcalWindow,
    zones: &IcalZones,
) -> Result<IcalFeed, NotACalendar> {
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
        events: expand_calendar_events(&root, window, calendar_zone.as_deref(), &key, zones),
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
        if time.is_date {
            return time.date.days_since_epoch() * 86_400_000;
        }
        match self.zone_of(time, unresolved) {
            None => time.wall_seconds() * 1_000,
            Some(zone) => wall_to_utc_ms(zone, time.wall_seconds()),
        }
    }

    fn to_wall(&self, utc_ms: i64, reference: &IcalTime, unresolved: Option<&str>) -> i64 {
        match self.zone_of(reference, unresolved) {
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

/// `expandCalendarEvents`.
pub fn expand_calendar_events(
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
            let end = end_of(event, &start, &resolver, unresolved);
            if let Some(instance) = to_instance(event, &start, end.as_ref(), key, &context)
                && overlaps(&instance, window)
            {
                events.push(instance);
            }
        }
    }
    events
}

struct Context<'a> {
    uid: &'a str,
    unresolved: Option<&'a str>,
    key_for: InstanceKey<'a>,
    resolver: &'a Resolver<'a>,
}

/// DTEND, else DTSTART + DURATION, else DTSTART (+ 1 day for a DATE).
fn end_of(
    event: &Component,
    start: &IcalTime,
    resolver: &Resolver<'_>,
    unresolved: Option<&str>,
) -> Option<IcalTime> {
    let seconds = duration_seconds(event, start, resolver, unresolved);
    Some(start.with_wall_seconds(start.wall_seconds() + seconds))
}

/// `event.duration`: DTEND − DTSTART as instants (so two zones subtract
/// right), else DURATION, else a day for a DATE and nothing for a time.
fn duration_seconds(
    event: &Component,
    start: &IcalTime,
    resolver: &Resolver<'_>,
    unresolved: Option<&str>,
) -> i64 {
    if let Some(end) = event.first("DTEND").and_then(time_of) {
        if start.is_date {
            return end.wall_seconds() - start.wall_seconds();
        }
        return (resolver.instant_ms(&end, unresolved) - resolver.instant_ms(start, unresolved))
            .div_euclid(1_000);
    }
    if let Some(seconds) = event
        .first("DURATION")
        .and_then(|p| parse_duration(&p.value))
    {
        return seconds;
    }
    if start.is_date { 86_400 } else { 0 }
}

fn to_instance(
    event: &Component,
    start: &IcalTime,
    end: Option<&IcalTime>,
    key: String,
    context: &Context<'_>,
) -> Option<IcalInstance> {
    let status = event.text("STATUS").map(|s| s.to_ascii_uppercase());
    if status.as_deref() == Some("CANCELLED") {
        return None;
    }
    let resolver = context.resolver;
    let updated = event
        .first("LAST-MODIFIED")
        .and_then(time_of)
        .or_else(|| event.first("DTSTAMP").and_then(time_of));
    let start_ms = resolver.instant_ms(start, context.unresolved);
    let end_ms = end.map(|e| resolver.instant_ms(e, context.unresolved));
    let timezone = if start.is_date {
        None
    } else {
        match &start.zone {
            // An undefined TZID reads as floating in `ical.js`.
            TimeZoneRef::Named(id) if context.resolver.known(id).is_some() => Some(id.clone()),
            TimeZoneRef::Named(_) => context.unresolved.map(str::to_owned),
            TimeZoneRef::Utc => Some("UTC".to_owned()),
            TimeZoneRef::Floating => context.unresolved.map(str::to_owned),
        }
    };
    Some(IcalInstance {
        remote_event_id: key,
        title: event
            .text("SUMMARY")
            .unwrap_or_else(|| "Untitled event".to_owned()),
        description: event.text("DESCRIPTION"),
        location: event.text("LOCATION"),
        start_at: iso(start_ms),
        end_at: end_ms.filter(|e| *e > start_ms).map(iso),
        is_all_day: start.is_date,
        timezone,
        status: if status.as_deref() == Some("TENTATIVE") {
            "tentative"
        } else {
            "confirmed"
        }
        .to_owned(),
        remote_updated_at: updated.map(|u| iso(resolver.instant_ms(&u, None))),
    })
}

fn overlaps(instance: &IcalInstance, window: IcalWindow) -> bool {
    let start = iso(window.start_ms);
    let end = iso(window.end_ms);
    instance.start_at < end
        && instance.end_at.as_deref().unwrap_or(&instance.start_at) >= start.as_str()
}

fn until_reader(start: &IcalTime) -> impl Fn(&str) -> Option<Until> + '_ {
    move |raw: &str| {
        let date = CivilDate::new(
            raw.get(..4)?.parse().ok()?,
            raw.get(4..6)?.parse().ok()?,
            raw.get(6..8)?.parse().ok()?,
        )?;
        if raw.len() <= 8 {
            return Some(Until::Date(date));
        }
        let clock = raw.get(9..15)?;
        let seconds = date.days_since_epoch() * 86_400
            + clock.get(..2)?.parse::<i64>().ok()? * 3_600
            + clock.get(2..4)?.parse::<i64>().ok()? * 60
            + clock.get(4..6)?.parse::<i64>().ok()?;
        if start.is_date {
            return Some(Until::Date(date));
        }
        Some(if raw.ends_with(['Z', 'z']) {
            Until::Instant(seconds)
        } else {
            Until::Wall(seconds)
        })
    }
}

/// `expandSeries`: walk the rule (plus RDATEs), skip EXDATEs, swap in
/// overrides, stop at the window's end.
fn expand_series(
    master: &Component,
    overrides: &[&Component],
    context: &Context<'_>,
    window: IcalWindow,
) -> Vec<IcalInstance> {
    let Some(start) = master.first("DTSTART").and_then(time_of) else {
        return Vec::new();
    };
    let resolver = context.resolver;
    let unresolved = context.unresolved;
    let to_utc_seconds = |wall: i64| {
        resolver
            .instant_ms(&start.with_wall_seconds(wall), unresolved)
            .div_euclid(1_000)
    };
    let reader = until_reader(&start);
    let rule = master
        .first("RRULE")
        .and_then(|p| parse_rule(&p.value, &reader));
    let mut walls: Vec<i64> = match &rule {
        Some(rule) => Occurrences::new(rule, start.wall_seconds(), &to_utc_seconds)
            .take(MAX_RECURRENCE_STEPS)
            .take_while(|wall| {
                resolver.instant_ms(&start.with_wall_seconds(*wall), unresolved) < window.end_ms
            })
            .collect(),
        None => vec![start.wall_seconds()],
    };
    for rdate in master.all("RDATE") {
        for time in times_of(rdate) {
            let ms = resolver.instant_ms(&time, unresolved);
            walls.push(if time.is_date {
                time.wall_seconds()
            } else {
                resolver.to_wall(ms, &start, unresolved)
            });
        }
    }
    walls.sort_unstable();
    walls.dedup();

    let exdates: Vec<IcalTime> = master.all("EXDATE").flat_map(times_of).collect();
    let override_by_rid: HashMap<i64, &Component> = overrides
        .iter()
        .filter_map(|o| {
            Some((
                resolver.instant_ms(&o.first("RECURRENCE-ID").and_then(time_of)?, unresolved),
                *o,
            ))
        })
        .collect();
    let duration = duration_seconds(master, &start, resolver, unresolved);

    let mut instances = Vec::new();
    for wall in walls {
        let occurrence = start.with_wall_seconds(wall);
        let rid_ms = resolver.instant_ms(&occurrence, unresolved);
        if rid_ms >= window.end_ms {
            break;
        }
        let excluded = exdates.iter().any(|ex| {
            if ex.is_date {
                ex.date == occurrence.date
            } else {
                resolver.instant_ms(ex, unresolved) == rid_ms
            }
        });
        if excluded {
            continue;
        }
        let key = (context.key_for)(context.uid, Some(&iso(rid_ms)));
        let instance = match override_by_rid.get(&rid_ms) {
            Some(exception) => {
                let Some(own_start) = exception.first("DTSTART").and_then(time_of) else {
                    continue;
                };
                let end = end_of(exception, &own_start, resolver, unresolved);
                to_instance(exception, &own_start, end.as_ref(), key, context)
            }
            None => {
                let end = occurrence.with_wall_seconds(wall + duration);
                to_instance(master, &occurrence, Some(&end), key, context)
            }
        };
        let Some(instance) = instance else { continue };
        if !overlaps(&instance, window) {
            continue;
        }
        instances.push(instance);
        if instances.len() >= MAX_INSTANCES_PER_SERIES {
            break;
        }
    }
    instances
}

/// Overrides whose original date lies past the window but which moved the
/// instance into it: placed on their own, keyed by that original date.
fn overrides_moved_into_window(
    overrides: &[&Component],
    expanded: &[IcalInstance],
    context: &Context<'_>,
    window: IcalWindow,
) -> Vec<IcalInstance> {
    let mut placed: Vec<String> = expanded.iter().map(|i| i.remote_event_id.clone()).collect();
    let mut out = Vec::new();
    for exception in overrides {
        let (Some(start), Some(rid)) = (
            exception.first("DTSTART").and_then(time_of),
            exception.first("RECURRENCE-ID").and_then(time_of),
        ) else {
            continue;
        };
        let rid_ms = context.resolver.instant_ms(&rid, context.unresolved);
        if rid_ms < window.end_ms {
            continue;
        }
        let key = (context.key_for)(context.uid, Some(&iso(rid_ms)));
        if placed.contains(&key) {
            continue;
        }
        let end = end_of(exception, &start, context.resolver, context.unresolved);
        if let Some(instance) = to_instance(exception, &start, end.as_ref(), key.clone(), context)
            && overlaps(&instance, window)
        {
            placed.push(key);
            out.push(instance);
        }
    }
    out
}
