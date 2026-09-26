//! A VTIMEZONE → the offsets it defines (RFC 5545 §3.6.5), for TZIDs the
//! shell cannot name (Outlook's "Pacific Standard Time"): each STANDARD /
//! DAYLIGHT observance's onsets, from its DTSTART, RRULE and RDATEs, become
//! transitions of a [`CalendarZone`].

use super::parse::{Component, time_of, times_of};
use super::rrule::{Occurrences, Until, parse_rule};
use crate::api::calendar_records::{CalendarZone, CalendarZoneTransition};
use crate::domain::calendar::CivilDate;

/// `+0200` / `-0530` / `+023000` in seconds.
fn offset_seconds(raw: &str) -> Option<i64> {
    let raw = raw.trim();
    let (sign, digits) = match raw.as_bytes().first()? {
        b'-' => (-1, &raw[1..]),
        b'+' => (1, &raw[1..]),
        _ => (1, raw),
    };
    let hours: i64 = digits.get(..2)?.parse().ok()?;
    let minutes: i64 = digits.get(2..4)?.parse().ok()?;
    let seconds: i64 = digits.get(4..6).and_then(|s| s.parse().ok()).unwrap_or(0);
    Some(sign * (hours * 3_600 + minutes * 60 + seconds))
}

struct Onset {
    utc: i64,
    to: i64,
}

/// The zone a VTIMEZONE describes through `last_year`; `None` without a
/// usable observance.
pub fn zone_from_vtimezone(tz: &Component, last_year: i64) -> Option<CalendarZone> {
    let tzid = tz.text("TZID")?;
    let mut onsets: Vec<Onset> = Vec::new();
    let mut earliest: Option<(i64, i64)> = None;
    let limit = CivilDate::new(last_year + 1, 1, 1)?.days_since_epoch() * 86_400;
    for observance in tz
        .children
        .iter()
        .filter(|c| c.name == "STANDARD" || c.name == "DAYLIGHT")
    {
        let (Some(from), Some(to)) = (
            observance
                .first("TZOFFSETFROM")
                .and_then(|p| offset_seconds(&p.value)),
            observance
                .first("TZOFFSETTO")
                .and_then(|p| offset_seconds(&p.value)),
        ) else {
            continue;
        };
        let Some(start) = observance.first("DTSTART").and_then(time_of) else {
            continue;
        };
        let start_wall = start.wall_seconds();
        if earliest.is_none_or(|(wall, _)| start_wall < wall) {
            earliest = Some((start_wall, from));
        }
        let mut walls = vec![start_wall];
        if let Some(rule) = observance.first("RRULE").and_then(|p| {
            parse_rule(&p.value, |raw| {
                let date = CivilDate::new(
                    raw.get(..4)?.parse().ok()?,
                    raw.get(4..6)?.parse().ok()?,
                    raw.get(6..8)?.parse().ok()?,
                )?;
                let clock = raw.get(9..15).unwrap_or("000000");
                let secs = clock.get(..2)?.parse::<i64>().ok()? * 3_600
                    + clock.get(2..4)?.parse::<i64>().ok()? * 60
                    + clock.get(4..6)?.parse::<i64>().ok()?;
                // UNTIL on an observance is UTC; read it on the wall of `from`.
                Some(Until::Wall(date.days_since_epoch() * 86_400 + secs + from))
            })
        }) {
            let identity = |wall: i64| wall;
            walls = Occurrences::new(&rule, start_wall, &identity)
                .take_while(|wall| *wall < limit)
                .take(2_000)
                .collect();
        }
        for rdate in observance.all("RDATE") {
            walls.extend(
                times_of(rdate)
                    .iter()
                    .map(super::parse::IcalTime::wall_seconds),
            );
        }
        onsets.extend(walls.into_iter().filter(|w| *w < limit).map(|wall| Onset {
            utc: wall - from,
            to,
        }));
    }
    let (_, base) = earliest?;
    onsets.sort_by_key(|o| o.utc);
    Some(CalendarZone {
        identifier: tzid,
        base_offset_ms: base * 1_000,
        transitions: onsets
            .into_iter()
            .map(|o| CalendarZoneTransition {
                at_ms: o.utc * 1_000,
                offset_ms: o.to * 1_000,
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::super::parse::parse_calendar;
    use super::*;
    use crate::domain::calendar_items::zone::LocalZone;

    #[test]
    fn us_eastern_from_its_rules() {
        let text = "BEGIN:VCALENDAR\nBEGIN:VTIMEZONE\nTZID:Eastern Standard Time\nBEGIN:STANDARD\nDTSTART:16010101T020000\nTZOFFSETFROM:-0400\nTZOFFSETTO:-0500\nRRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11\nEND:STANDARD\nBEGIN:DAYLIGHT\nDTSTART:16010101T020000\nTZOFFSETFROM:-0500\nTZOFFSETTO:-0400\nRRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3\nEND:DAYLIGHT\nEND:VTIMEZONE\nEND:VCALENDAR\n";
        let root = parse_calendar(text).expect("calendar");
        let tz = root.children_named("VTIMEZONE").next().expect("tz");
        let zone = zone_from_vtimezone(tz, 2027).expect("zone");
        // 2026-07-01T12:00Z is summer (-4h), 2026-12-01T12:00Z is winter (-5h).
        let july =
            CivilDate::new(2026, 7, 1).expect("d").days_since_epoch() * 86_400_000 + 43_200_000;
        let december =
            CivilDate::new(2026, 12, 1).expect("d").days_since_epoch() * 86_400_000 + 43_200_000;
        assert_eq!(zone.offset_ms(july), -4 * 3_600_000);
        assert_eq!(zone.offset_ms(december), -5 * 3_600_000);
    }
}
