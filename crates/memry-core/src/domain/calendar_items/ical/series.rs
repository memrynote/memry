//! One event's instances (split from [`super`] at the 600-line ceiling):
//! a series walked through its rule, RDATEs, EXDATEs and overrides, and a
//! single event placed. Every loop charges [`super::budget`].

use std::collections::{HashMap, HashSet};

use super::parse::{Component, IcalTime, TimeZoneRef, parse_duration, time_of, times_of};
use super::rrule::{Occurrences, Until, parse_rule};
use super::{
    IcalInstance, IcalWindow, InstanceKey, MAX_INSTANCES_PER_SERIES, MAX_RECURRENCE_STEPS,
    Resolver, WallClock,
};
use super::{budget, vevent_extras};
use crate::domain::calendar::CivilDate;
use crate::domain::calendar_items::projection::iso;

pub(super) struct Context<'a> {
    pub uid: &'a str,
    pub unresolved: Option<&'a str>,
    pub key_for: InstanceKey<'a>,
    pub resolver: &'a Resolver<'a>,
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

/// What every instance of one event copies, read once per event.
struct EventText {
    title: String,
    description: Option<String>,
    location: Option<String>,
    /// `None` when the event is cancelled.
    status: Option<&'static str>,
    remote_updated_at: Option<String>,
    attendees: Option<serde_json::Value>,
    reminders: Option<serde_json::Value>,
    visibility: Option<String>,
    color_id: Option<String>,
}

impl EventText {
    fn of(event: &Component, resolver: &Resolver<'_>) -> Self {
        // Each `text` / `first` below scans the event's properties.
        budget::step(event.properties.len());
        let status = event.text("STATUS").map(|s| s.to_ascii_uppercase());
        let updated = event
            .first("LAST-MODIFIED")
            .and_then(time_of)
            .or_else(|| event.first("DTSTAMP").and_then(time_of));
        Self {
            title: event
                .text("SUMMARY")
                .unwrap_or_else(|| "Untitled event".to_owned()),
            description: event.text("DESCRIPTION"),
            location: event.text("LOCATION"),
            status: match status.as_deref() {
                Some("CANCELLED") => None,
                Some("TENTATIVE") => Some("tentative"),
                _ => Some("confirmed"),
            },
            remote_updated_at: updated.map(|u| iso(resolver.instant_ms(&u, None))),
            attendees: vevent_extras::attendees(event),
            reminders: vevent_extras::reminders(event),
            visibility: vevent_extras::visibility(event),
            color_id: vevent_extras::color_id(event),
        }
    }

    /// The instance at `start_ms`, `None` when the event is cancelled.
    fn instance(
        &self,
        key: String,
        start_ms: i64,
        end_ms: i64,
        is_all_day: bool,
        timezone: Option<String>,
    ) -> Option<IcalInstance> {
        Some(IcalInstance {
            remote_event_id: key,
            title: self.title.clone(),
            description: self.description.clone(),
            location: self.location.clone(),
            start_at: iso(start_ms),
            end_at: (end_ms > start_ms).then(|| iso(end_ms)),
            is_all_day,
            timezone,
            status: self.status?.to_owned(),
            remote_updated_at: self.remote_updated_at.clone(),
            attendees: self.attendees.clone(),
            reminders: self.reminders.clone(),
            visibility: self.visibility.clone(),
            color_id: self.color_id.clone(),
        })
    }
}

/// The zone an instance starting at `start` is shown in.
fn timezone_of(start: &IcalTime, context: &Context<'_>) -> Option<String> {
    if start.is_date {
        return None;
    }
    match &start.zone {
        // An undefined TZID reads as floating in `ical.js`.
        TimeZoneRef::Named(id) if context.resolver.known(id).is_some() => Some(id.clone()),
        TimeZoneRef::Named(_) | TimeZoneRef::Floating => context.unresolved.map(str::to_owned),
        TimeZoneRef::Utc => Some("UTC".to_owned()),
    }
}

/// A single event or an override at its own DTSTART; `None` when it is
/// cancelled or misses the window.
pub(super) fn place(
    event: &Component,
    start: &IcalTime,
    key: String,
    context: &Context<'_>,
    window: IcalWindow,
) -> Option<IcalInstance> {
    let (resolver, unresolved) = (context.resolver, context.unresolved);
    let end = start.with_wall_seconds(
        start.wall_seconds() + duration_seconds(event, start, resolver, unresolved),
    );
    EventText::of(event, resolver)
        .instance(
            key,
            resolver.instant_ms(start, unresolved),
            resolver.instant_ms(&end, unresolved),
            start.is_date,
            timezone_of(start, context),
        )
        .filter(|instance| overlaps(instance, window))
}

pub(super) fn overlaps(instance: &IcalInstance, window: IcalWindow) -> bool {
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
pub(super) fn expand_series(
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
    let clock = WallClock {
        zone: resolver.zone_of(&start, unresolved),
        is_date: start.is_date,
    };
    let to_utc_seconds = |wall: i64| clock.instant_ms(wall).div_euclid(1_000);
    let reader = until_reader(&start);
    let rule = master
        .first("RRULE")
        .and_then(|p| parse_rule(&p.value, &reader));
    let mut walls: Vec<i64> = match &rule {
        Some(rule) => Occurrences::new(rule, start.wall_seconds(), &to_utc_seconds)
            .take(MAX_RECURRENCE_STEPS)
            .take_while(|wall| clock.instant_ms(*wall) < window.end_ms)
            .collect(),
        None => vec![start.wall_seconds()],
    };
    for rdate in master.all("RDATE") {
        for time in times_of(rdate) {
            if !budget::step(1) {
                return Vec::new();
            }
            walls.push(if time.is_date {
                time.wall_seconds()
            } else {
                clock.wall_of(resolver.instant_ms(&time, unresolved))
            });
        }
    }
    walls.sort_unstable();
    walls.dedup();

    let mut excluded_days: HashSet<CivilDate> = HashSet::new();
    let mut excluded_ms: HashSet<i64> = HashSet::new();
    for ex in master.all("EXDATE").flat_map(times_of) {
        if !budget::step(1) {
            return Vec::new();
        }
        if ex.is_date {
            excluded_days.insert(ex.date);
        } else {
            excluded_ms.insert(resolver.instant_ms(&ex, unresolved));
        }
    }
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

    let master_text = EventText::of(master, resolver);
    let master_zone = timezone_of(&start, context);
    let mut instances = Vec::new();
    for wall in walls {
        if !budget::step(1) {
            return Vec::new();
        }
        let rid_ms = clock.instant_ms(wall);
        if rid_ms >= window.end_ms {
            break;
        }
        let day = CivilDate::from_days_since_epoch(wall.div_euclid(86_400));
        if excluded_days.contains(&day) || excluded_ms.contains(&rid_ms) {
            continue;
        }
        let exception = override_by_rid.get(&rid_ms);
        let end_ms = clock.instant_ms(wall + duration);
        // An occurrence that ends before the window is never built: its text
        // would be copied only to be dropped. An override can move into it.
        if exception.is_none() && rid_ms.max(end_ms) < window.start_ms {
            continue;
        }
        let key = (context.key_for)(context.uid, Some(&iso(rid_ms)));
        let instance = match exception {
            Some(exception) => {
                let Some(own_start) = exception.first("DTSTART").and_then(time_of) else {
                    continue;
                };
                place(exception, &own_start, key, context, window)
            }
            None => master_text
                .instance(key, rid_ms, end_ms, start.is_date, master_zone.clone())
                .filter(|instance| overlaps(instance, window)),
        };
        let Some(instance) = instance else { continue };
        if !budget::emit(text_bytes(&instance)) {
            return Vec::new();
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
pub(super) fn overrides_moved_into_window(
    overrides: &[&Component],
    expanded: &[IcalInstance],
    context: &Context<'_>,
    window: IcalWindow,
) -> Vec<IcalInstance> {
    let mut placed: HashSet<String> = expanded.iter().map(|i| i.remote_event_id.clone()).collect();
    let mut out = Vec::new();
    for exception in overrides {
        if !budget::step(1) {
            return Vec::new();
        }
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
        if let Some(instance) = place(exception, &start, key.clone(), context, window) {
            if !budget::emit(text_bytes(&instance)) {
                return Vec::new();
            }
            placed.insert(key);
            out.push(instance);
        }
    }
    out
}

/// The text an instance carries, for [`budget::emit`].
pub(super) fn text_bytes(instance: &IcalInstance) -> usize {
    instance.remote_event_id.len()
        + instance.title.len()
        + instance.description.as_ref().map_or(0, String::len)
        + instance.location.as_ref().map_or(0, String::len)
        + instance.timezone.as_ref().map_or(0, String::len)
}
