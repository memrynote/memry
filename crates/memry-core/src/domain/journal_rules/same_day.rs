//! "This day in other years" (`packages/domain-notes/src/journal/same-day.ts`):
//! the days the On this day section puts next to a journal day.
//!
//! Feb 29 has no day of its own in a non-leap year. Its entries show on Feb 28
//! of a non-leap year, and a Feb 29 shows the Feb 28 of non-leap years, so a
//! leap-day entry never drops out of sight for three years.
//!
//! Dates are `YYYY-MM-DD`.

use crate::domain::calendar::is_leap_year;

const LEAP_DAY: &str = "02-29";
const DAY_BEFORE_LEAP_DAY: &str = "02-28";

/// `(year, "MM-DD")`. Callers validate the date first.
fn split(date: &str) -> (i64, &str) {
    let year = date.get(..4).and_then(|y| y.parse().ok()).unwrap_or(0);
    (year, date.get(5..).unwrap_or(""))
}

/// `sameDayMonthDays`: the `MM-DD` values whose entries can match `date` in
/// another year.
pub fn same_day_month_days(date: &str) -> Vec<&str> {
    let (year, month_day) = split(date);
    if month_day == LEAP_DAY {
        return vec![LEAP_DAY, DAY_BEFORE_LEAP_DAY];
    }
    if month_day == DAY_BEFORE_LEAP_DAY && !is_leap_year(year) {
        return vec![DAY_BEFORE_LEAP_DAY, LEAP_DAY];
    }
    vec![month_day]
}

/// `isSameDayInOtherYear`: `candidate` is in another year and shows as the
/// same day as `date`.
pub fn is_same_day_in_other_year(date: &str, candidate: &str) -> bool {
    let (year, month_day) = split(date);
    let (other_year, other_month_day) = split(candidate);
    if other_year == year {
        return false;
    }
    if other_month_day == month_day {
        return true;
    }
    if month_day == LEAP_DAY {
        return other_month_day == DAY_BEFORE_LEAP_DAY && !is_leap_year(other_year);
    }
    if month_day == DAY_BEFORE_LEAP_DAY && !is_leap_year(year) {
        return other_month_day == LEAP_DAY;
    }
    false
}
