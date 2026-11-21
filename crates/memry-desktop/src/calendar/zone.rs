//! The system time zone over a range, as the core's projection takes it ([`CalendarZone`]):
//! Electron's main process read the same zone through `Intl` and `Date`.

use chrono::{Local, Offset, TimeZone};
use memry_core::api::calendar_records::{CalendarZone, CalendarZoneTransition};

/// Offsets are sampled this far apart; two transitions closer than this are not seen apart.
const STEP_MS: i64 = 12 * 3_600_000;
/// The range is padded by two days on each side, as local-day keys reach past it.
const PAD_MS: i64 = 2 * 86_400_000;

/// The system zone's offsets over `[start_ms, end_ms]`, named by its IANA identifier.
pub fn system_zone(start_ms: i64, end_ms: i64) -> CalendarZone {
    let identifier = iana_time_zone::get_timezone().unwrap_or_else(|error| {
        tracing::warn!("the system time zone has no IANA name ({error}); naming it UTC");
        "UTC".to_owned()
    });
    zone_over(identifier, start_ms, end_ms, local_offset_ms)
}

fn local_offset_ms(utc_ms: i64) -> i64 {
    Local.timestamp_millis_opt(utc_ms).single().map_or(0, |at| {
        i64::from(at.offset().fix().local_minus_utc()) * 1000
    })
}

/// The offset before the padded range, then each change: sampled every [`STEP_MS`], and each
/// change found to the millisecond by a binary search between the two samples around it.
pub fn zone_over(
    identifier: String,
    start_ms: i64,
    end_ms: i64,
    offset: impl Fn(i64) -> i64,
) -> CalendarZone {
    let (from, to) = (start_ms - PAD_MS, end_ms.max(start_ms) + PAD_MS);
    let base_offset_ms = offset(from);
    let mut transitions = Vec::new();
    let (mut at, mut current) = (from, base_offset_ms);
    while at < to {
        let next = (at + STEP_MS).min(to);
        let next_offset = offset(next);
        if next_offset != current {
            // offset(lo) == current, offset(hi) == next_offset.
            let (mut lo, mut hi) = (at, next);
            while hi - lo > 1 {
                let mid = lo + (hi - lo) / 2;
                if offset(mid) == current {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            transitions.push(CalendarZoneTransition {
                at_ms: hi,
                offset_ms: next_offset,
            });
            current = next_offset;
        }
        at = next;
    }
    CalendarZone {
        identifier,
        base_offset_ms,
        transitions,
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use memry_core::domain::calendar_items::zone::LocalZone;

    use super::*;

    const HOUR: i64 = 3_600_000;
    /// 2026-03-29T01:00:00Z: Europe's spring change.
    const SPRING: i64 = 1_774_746_000_000;
    /// 2026-10-25T01:00:00Z: Europe's autumn change.
    const AUTUMN: i64 = 1_792_890_000_000;

    fn berlin(ms: i64) -> i64 {
        if (SPRING..AUTUMN).contains(&ms) {
            2 * HOUR
        } else {
            HOUR
        }
    }

    #[test]
    fn each_change_is_found_to_the_millisecond() {
        let zone = zone_over(
            "Europe/Berlin".into(),
            SPRING - 30 * 86_400_000,
            AUTUMN,
            berlin,
        );
        assert_eq!(zone.identifier, "Europe/Berlin");
        assert_eq!(zone.base_offset_ms, HOUR);
        assert_eq!(
            zone.transitions,
            [
                CalendarZoneTransition {
                    at_ms: SPRING,
                    offset_ms: 2 * HOUR
                },
                CalendarZoneTransition {
                    at_ms: AUTUMN,
                    offset_ms: HOUR
                },
            ]
        );
        assert_eq!(zone.offset_ms(SPRING - 1), HOUR);
        assert_eq!(zone.offset_ms(SPRING), 2 * HOUR);
        assert_eq!(zone.offset_ms(AUTUMN), HOUR);
    }

    #[test]
    fn a_month_without_a_change_samples_linearly() {
        let calls = Cell::new(0_usize);
        let zone = zone_over("Etc/GMT-3".into(), 0, 31 * 86_400_000, |_| {
            calls.set(calls.get() + 1);
            3 * HOUR
        });
        assert!(zone.transitions.is_empty());
        assert_eq!(zone.base_offset_ms, 3 * HOUR);
        // 35 days at two samples a day, plus the base.
        assert!(calls.get() <= 71, "{} offset reads", calls.get());
    }
}
