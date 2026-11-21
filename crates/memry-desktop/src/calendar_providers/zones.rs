//! The IANA zones a feed names, resolved into the core's offset tables
//! ([`CalendarFeedZones`]). Electron's `ical-events.ts` resolved them through `Intl`; here the
//! zone database is jiff's (the system zoneinfo, or its bundled copy on Windows). A name it does
//! not know stays out, and the core reads that time as floating, as Electron did.

use jiff::Timestamp;
use jiff::tz::TimeZone;
use memry_core::api::calendar_providers::CalendarFeedZones;
use memry_core::api::calendar_records::{CalendarZone, CalendarZoneTransition};
use memry_core::domain::calendar_items::ical;

const DAY_MS: i64 = 86_400_000;
/// Wider than the mirror's window (90 days back, 365 ahead), as the iOS shell takes it.
const BEFORE_MS: i64 = 400 * DAY_MS;
const AFTER_MS: i64 = 800 * DAY_MS;

pub(super) fn feed_zones(text: &str, now_ms: i64) -> CalendarFeedZones {
    let (from, to) = (now_ms - BEFORE_MS, now_ms + AFTER_MS);
    let named = ical::zone_ids(text)
        .into_iter()
        .filter_map(|id| {
            let zone = TimeZone::get(&id).ok()?;
            Some(table(id, &zone, from, to))
        })
        .collect();
    let system = TimeZone::system();
    let local_name = system.iana_name().unwrap_or("UTC").to_owned();
    CalendarFeedZones {
        named,
        local: table(local_name, &system, from, to),
    }
}

/// The offset at `from_ms`, then every transition up to `to_ms`.
fn table(identifier: String, zone: &TimeZone, from_ms: i64, to_ms: i64) -> CalendarZone {
    let at = |ms: i64| Timestamp::from_millisecond(ms).unwrap_or(Timestamp::UNIX_EPOCH);
    let (from, to) = (at(from_ms), at(to_ms));
    let transitions = zone
        .following(from)
        .take_while(|t| t.timestamp() <= to)
        .map(|t| CalendarZoneTransition {
            at_ms: t.timestamp().as_millisecond(),
            offset_ms: i64::from(t.offset().seconds()) * 1000,
        })
        .collect();
    CalendarZone {
        identifier,
        base_offset_ms: i64::from(zone.to_offset(from).seconds()) * 1000,
        transitions,
    }
}

#[cfg(test)]
mod tests {
    use memry_core::domain::calendar_items::zone::LocalZone;

    use super::*;

    const HOUR: i64 = 3_600_000;
    /// 2026-03-29T01:00:00Z and 2026-10-25T01:00:00Z: Europe's changes.
    const SPRING: i64 = 1_774_746_000_000;
    const AUTUMN: i64 = 1_792_890_000_000;

    #[test]
    fn a_named_zone_carries_its_transitions_and_an_unknown_one_stays_out() {
        let text = "BEGIN:VCALENDAR\r\nX-WR-TIMEZONE:Europe/Berlin\r\nBEGIN:VEVENT\r\n\
            DTSTART;TZID=Not/AZone:20260601T090000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let zones = feed_zones(text, SPRING);
        assert_eq!(zones.named.len(), 1, "{:?}", zones.named);
        let berlin = &zones.named[0];
        assert_eq!(berlin.identifier, "Europe/Berlin");
        assert_eq!(berlin.offset_ms(SPRING - 1), HOUR);
        assert_eq!(berlin.offset_ms(SPRING), 2 * HOUR);
        assert_eq!(berlin.offset_ms(AUTUMN), HOUR);
        assert!(
            berlin
                .transitions
                .windows(2)
                .all(|w| w[0].at_ms < w[1].at_ms)
        );
        assert!(!zones.local.identifier.is_empty());
    }
}
