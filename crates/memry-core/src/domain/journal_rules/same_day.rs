//! "This day in other years" (`packages/domain-notes/src/journal/same-day.ts`):
//! the days the On this day section and the All years view put next to a journal day.
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

#[cfg(test)]
mod tests {
    use super::{is_same_day_in_other_year as same, same_day_month_days as month_days};

    // The cases of `same-day.test.ts`.
    #[test]
    fn matches_the_same_month_and_day_in_another_year_only() {
        assert_eq!(month_days("2026-11-10"), ["11-10"]);
        assert!(same("2026-11-10", "2025-11-10"));
        assert!(!same("2026-11-10", "2026-11-10"));
        assert!(!same("2026-11-10", "2025-11-11"));
    }

    #[test]
    fn shows_a_leap_day_on_feb_28_of_a_non_leap_year() {
        assert_eq!(month_days("2027-02-28"), ["02-28", "02-29"]);
        assert!(same("2027-02-28", "2024-02-29"));
        assert!(same("2027-02-28", "2024-02-28"));
    }

    #[test]
    fn keeps_a_leap_year_feb_28_to_its_own_day() {
        assert_eq!(month_days("2028-02-28"), ["02-28"]);
        assert!(!same("2028-02-28", "2024-02-29"));
        assert!(same("2028-02-28", "2027-02-28"));
    }

    #[test]
    fn shows_non_leap_feb_28s_on_a_leap_day_but_not_leap_year_feb_28s() {
        assert_eq!(month_days("2028-02-29"), ["02-29", "02-28"]);
        assert!(same("2028-02-29", "2024-02-29"));
        assert!(same("2028-02-29", "2027-02-28"));
        assert!(!same("2028-02-29", "2024-02-28"));
    }

    #[test]
    fn century_years_follow_the_gregorian_rule() {
        // 2100 is not a leap year, 2000 is.
        assert_eq!(month_days("2100-02-28"), ["02-28", "02-29"]);
        assert_eq!(month_days("2000-02-28"), ["02-28"]);
        assert!(same("2100-02-28", "2096-02-29"));
        assert!(!same("2000-02-28", "1996-02-29"));
    }
}
