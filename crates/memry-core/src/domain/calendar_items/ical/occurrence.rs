//! One occurrence of a stored series (desktop `ical-write.ts`
//! `recurrenceIdMatches` / `occurrenceLine`): which VEVENT overrides it, and
//! the RECURRENCE-ID or EXDATE line that names it in the value type the
//! series uses, since clients match occurrences by that value.

use super::parse::{Component, TimeZoneRef, time_of};
use super::vtimezone;
use super::{IcalZones, Resolver};
use crate::domain::calendar::CivilDate;
use crate::domain::calendar_items::zone::LocalZone;

/// The zones one object resolves its times in.
pub struct ObjectTimes<'a> {
    resolver: Resolver<'a>,
}

impl<'a> ObjectTimes<'a> {
    pub fn new(root: &Component, zones: &'a IcalZones) -> Self {
        // Far enough out for any occurrence a phone edits.
        let last_year = 2100;
        Self {
            resolver: Resolver {
                zones,
                defined: root
                    .children_named("VTIMEZONE")
                    .filter_map(|tz| vtimezone::zone_from_vtimezone(tz, last_year))
                    .map(|zone| (zone.identifier.clone(), zone))
                    .collect(),
            },
        }
    }

    /// Whether `vevent` is the override for the occurrence at `rid_ms`.
    pub fn overrides(&self, vevent: &Component, rid_ms: i64) -> bool {
        vevent
            .first("RECURRENCE-ID")
            .and_then(time_of)
            .is_some_and(|rid| self.resolver.instant_ms(&rid, None) == rid_ms)
    }

    /// `occurrenceLine`: a DATE for an all-day series, the series' TZID when
    /// the object defines that zone, UTC otherwise.
    pub fn line(&self, name: &str, root: &Component, master: &Component, rid_ms: i64) -> String {
        let start = master.first("DTSTART").and_then(time_of);
        let utc = CivilDate::from_days_since_epoch(rid_ms.div_euclid(86_400_000));
        if start.as_ref().is_some_and(|s| s.is_date) {
            return format!("{name};VALUE=DATE:{}", utc.key().replace('-', ""));
        }
        if let Some(TimeZoneRef::Named(tzid)) = start.map(|s| s.zone)
            && tzid != "UTC"
            && tzid != "Etc/UTC"
            && root
                .children_named("VTIMEZONE")
                .any(|tz| tz.text("TZID").as_deref() == Some(tzid.as_str()))
            && let Some(zone) = self.resolver.known(&tzid)
        {
            return format!(
                "{name};TZID={tzid}:{}",
                stamp(rid_ms + zone.offset_ms(rid_ms), false)
            );
        }
        format!("{name}:{}", stamp(rid_ms, true))
    }
}

fn stamp(ms: i64, utc: bool) -> String {
    let day = CivilDate::from_days_since_epoch(ms.div_euclid(86_400_000));
    let rest = ms.rem_euclid(86_400_000) / 1000;
    format!(
        "{}T{:02}{:02}{:02}{}",
        day.key().replace('-', ""),
        rest / 3600,
        rest / 60 % 60,
        rest % 60,
        if utc { "Z" } else { "" }
    )
}
