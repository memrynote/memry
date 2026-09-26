//! Local time for the projection (spec 007 §6 CL002).
//!
//! Desktop's projection turns a task's `dueDate` + `dueTime` into an instant
//! with `new Date(y, m - 1, d, h, min)` and finds a range's local days with
//! `getFullYear()`/`getMonth()`/`getDate()`. Both read the process's time
//! zone. The core has no zone database, so the shell supplies one fact — the
//! UTC offset in force at an instant — and this module rebuilds JavaScript's
//! two conversions from it, including its DST rules: a wall time inside a
//! spring-forward gap resolves with the offset **before** the transition (so
//! 02:30 becomes 03:30), and a wall time inside a fall-back overlap takes the
//! earlier of its two instants (ECMA-262 `UTC(t)`).

use crate::domain::calendar::{CivilDate, MS_PER_DAY};

/// The UTC offset in force at an instant, in milliseconds (east positive).
pub trait LocalZone: Send + Sync {
    fn offset_ms(&self, utc_ms: i64) -> i64;
}

/// A fixed offset (tests, UTC).
#[derive(Debug, Clone, Copy)]
pub struct FixedZone(pub i64);

impl LocalZone for FixedZone {
    fn offset_ms(&self, _utc_ms: i64) -> i64 {
        self.0
    }
}

/// `new Date(y, m - 1, d, h, min)`: a local wall time as epoch milliseconds.
pub fn local_to_utc(zone: &dyn LocalZone, date: CivilDate, hour: u32, minute: u32) -> i64 {
    let wall = date.days_since_epoch() * MS_PER_DAY
        + i64::from(hour) * 3_600_000
        + i64::from(minute) * 60_000;
    let before = zone.offset_ms(wall - MS_PER_DAY / 2);
    let after = zone.offset_ms(wall + MS_PER_DAY / 2);
    if before == after {
        return wall - before;
    }
    let with_before = wall - before;
    if zone.offset_ms(with_before) == before {
        return with_before;
    }
    let with_after = wall - after;
    if zone.offset_ms(with_after) == after {
        return with_after;
    }
    // A gap: no instant shows this wall time; JavaScript uses the earlier offset.
    with_before
}

/// The local calendar day an instant falls on.
pub fn local_date(zone: &dyn LocalZone, utc_ms: i64) -> CivilDate {
    let local = utc_ms + zone.offset_ms(utc_ms);
    CivilDate::from_days_since_epoch(local.div_euclid(MS_PER_DAY))
}

/// Minutes since local midnight at an instant.
pub fn local_minutes(zone: &dyn LocalZone, utc_ms: i64) -> i64 {
    let local = utc_ms + zone.offset_ms(utc_ms);
    local.rem_euclid(MS_PER_DAY) / 60_000
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// America/New_York since 2007: DST from the second Sunday of March 02:00
    /// local to the first Sunday of November 02:00 local.
    pub struct NewYork;

    fn nth_sunday(year: i64, month: u32, n: i64) -> CivilDate {
        let first = CivilDate::from_js_parts(year, i64::from(month) - 1, 1);
        let to_sunday = (7 - i64::from(first.weekday())) % 7;
        first.add_days(to_sunday + 7 * (n - 1))
    }

    impl LocalZone for NewYork {
        fn offset_ms(&self, utc_ms: i64) -> i64 {
            let year = CivilDate::from_days_since_epoch(utc_ms.div_euclid(MS_PER_DAY)).year;
            // 02:00 EST = 07:00Z; 02:00 EDT = 06:00Z.
            let start = nth_sunday(year, 3, 2).days_since_epoch() * MS_PER_DAY + 7 * 3_600_000;
            let end = nth_sunday(year, 11, 1).days_since_epoch() * MS_PER_DAY + 6 * 3_600_000;
            if utc_ms >= start && utc_ms < end {
                -4 * 3_600_000
            } else {
                -5 * 3_600_000
            }
        }
    }

    fn day(y: i64, m: u32, d: u32) -> CivilDate {
        CivilDate::new(y, m, d).expect("valid")
    }

    #[test]
    fn a_gap_moves_forward_and_an_overlap_takes_the_earlier_instant() {
        // 2026-03-08 02:30 does not exist in New York: 03:30 EDT = 07:30Z.
        let gap = local_to_utc(&NewYork, day(2026, 3, 8), 2, 30);
        assert_eq!(
            crate::storage::repositories::instants::to_iso8601(gap).as_deref(),
            Some("2026-03-08T07:30:00.000Z")
        );
        // 2026-11-01 01:30 happens twice: the EDT one, 05:30Z.
        let overlap = local_to_utc(&NewYork, day(2026, 11, 1), 1, 30);
        assert_eq!(
            crate::storage::repositories::instants::to_iso8601(overlap).as_deref(),
            Some("2026-11-01T05:30:00.000Z")
        );
        // A normal hour on the fall-back day: 10:00 EST = 15:00Z.
        let later = local_to_utc(&NewYork, day(2026, 11, 1), 10, 0);
        assert_eq!(
            crate::storage::repositories::instants::to_iso8601(later).as_deref(),
            Some("2026-11-01T15:00:00.000Z")
        );
    }

    #[test]
    fn local_date_reads_the_wall_day() {
        let ms = crate::storage::repositories::instants::to_epoch_ms("2026-09-25T02:00:00.000Z")
            .expect("iso");
        assert_eq!(local_date(&NewYork, ms), day(2026, 9, 24));
    }
}
