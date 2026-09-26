//! The day sets of one RRULE period (split from [`super::rrule`] at the
//! 600-line ceiling): BYxxx expansion inside a year, month or week, and the
//! same rules as limits on a single day.

use super::rrule::Rule;
use crate::domain::calendar::{CivilDate, days_in_month, is_leap_year};

/// BYMONTH / BYMONTHDAY / BYYEARDAY / BYDAY as limits on one day.
pub(super) fn day_allowed(rule: &Rule, day: CivilDate) -> bool {
    (rule.by_month.is_empty() || rule.by_month.contains(&day.month))
        && (rule.by_month_day.is_empty() || matches_month_day(&rule.by_month_day, day))
        && (rule.by_year_day.is_empty() || matches_year_day(&rule.by_year_day, day))
        && (rule.by_day.is_empty() || rule.by_day.iter().any(|(_, wd)| *wd == day.weekday()))
}

fn matches_month_day(list: &[i64], day: CivilDate) -> bool {
    let len = i64::from(days_in_month(day.year, day.month));
    list.iter().any(|n| {
        let target = if *n > 0 { *n } else { len + n + 1 };
        target == i64::from(day.day)
    })
}

fn year_length(year: i64) -> i64 {
    if is_leap_year(year) { 366 } else { 365 }
}

fn day_of_year(day: CivilDate) -> i64 {
    day.days_since_epoch() - CivilDate::new(day.year, 1, 1).map_or(0, CivilDate::days_since_epoch)
        + 1
}

fn matches_year_day(list: &[i64], day: CivilDate) -> bool {
    let len = year_length(day.year);
    let ordinal = day_of_year(day);
    list.iter()
        .any(|n| (if *n > 0 { *n } else { len + n + 1 }) == ordinal)
}

/// The days of `[first, last]` that are weekday `wd`, taking the ordinal
/// (`2` = second, `-1` = last) inside that span.
fn nth_weekdays(first: CivilDate, last: CivilDate, ordinal: i64, wd: u32) -> Vec<CivilDate> {
    let mut all = Vec::new();
    let mut day = first;
    while day.days_since_epoch() <= last.days_since_epoch() {
        if day.weekday() == wd {
            all.push(day);
        }
        day = day.add_days(1);
    }
    if ordinal == 0 {
        return all;
    }
    let len = i64::try_from(all.len()).unwrap_or(0);
    let index = if ordinal > 0 {
        ordinal - 1
    } else {
        len + ordinal
    };
    usize::try_from(index)
        .ok()
        .and_then(|i| all.get(i).copied())
        .into_iter()
        .collect()
}

fn month_span(year: i64, month: u32) -> Option<(CivilDate, CivilDate)> {
    Some((
        CivilDate::new(year, month, 1)?,
        CivilDate::new(year, month, days_in_month(year, month))?,
    ))
}

pub(super) fn monthly_days(rule: &Rule, start: CivilDate, first: CivilDate) -> Vec<CivilDate> {
    if !rule.by_month.is_empty() && !rule.by_month.contains(&first.month) {
        return Vec::new();
    }
    let Some((from, to)) = month_span(first.year, first.month) else {
        return Vec::new();
    };
    let mut days: Vec<CivilDate> = if !rule.by_day.is_empty() {
        rule.by_day
            .iter()
            .flat_map(|(n, wd)| nth_weekdays(from, to, *n, *wd))
            .collect()
    } else if !rule.by_month_day.is_empty() {
        let mut day = from;
        let mut out = Vec::new();
        while day.days_since_epoch() <= to.days_since_epoch() {
            if matches_month_day(&rule.by_month_day, day) {
                out.push(day);
            }
            day = day.add_days(1);
        }
        out
    } else {
        CivilDate::new(first.year, first.month, start.day)
            .into_iter()
            .collect()
    };
    if !rule.by_day.is_empty() && !rule.by_month_day.is_empty() {
        days.retain(|day| matches_month_day(&rule.by_month_day, *day));
    }
    days
}

pub(super) fn weekly_days(rule: &Rule, start: CivilDate, week: CivilDate) -> Vec<CivilDate> {
    (0..7)
        .map(|offset| week.add_days(offset))
        .filter(|day| {
            let weekday_ok = if rule.by_day.is_empty() {
                day.weekday() == start.weekday()
            } else {
                rule.by_day.iter().any(|(_, wd)| *wd == day.weekday())
            };
            weekday_ok && (rule.by_month.is_empty() || rule.by_month.contains(&day.month))
        })
        .collect()
}

pub(super) fn yearly_days(rule: &Rule, start: CivilDate, year: i64) -> Vec<CivilDate> {
    let (Some(jan1), Some(dec31)) = (CivilDate::new(year, 1, 1), CivilDate::new(year, 12, 31))
    else {
        return Vec::new();
    };
    let mut days: Vec<CivilDate> = if !rule.by_year_day.is_empty() {
        let mut out = Vec::new();
        let mut day = jan1;
        while day.days_since_epoch() <= dec31.days_since_epoch() {
            if matches_year_day(&rule.by_year_day, day) {
                out.push(day);
            }
            day = day.add_days(1);
        }
        out
    } else if !rule.by_month.is_empty() {
        rule.by_month
            .iter()
            .flat_map(|month| {
                let Some((from, to)) = month_span(year, *month) else {
                    return Vec::new();
                };
                if !rule.by_day.is_empty() {
                    rule.by_day
                        .iter()
                        .flat_map(|(n, wd)| nth_weekdays(from, to, *n, *wd))
                        .collect()
                } else if !rule.by_month_day.is_empty() {
                    let mut out = Vec::new();
                    let mut day = from;
                    while day.days_since_epoch() <= to.days_since_epoch() {
                        if matches_month_day(&rule.by_month_day, day) {
                            out.push(day);
                        }
                        day = day.add_days(1);
                    }
                    out
                } else {
                    CivilDate::new(year, *month, start.day)
                        .into_iter()
                        .collect()
                }
            })
            .collect()
    } else if !rule.by_day.is_empty() {
        rule.by_day
            .iter()
            .flat_map(|(n, wd)| nth_weekdays(jan1, dec31, *n, *wd))
            .collect()
    } else if !rule.by_month_day.is_empty() {
        CivilDate::new(year, start.month, 1)
            .and_then(|first| month_span(first.year, first.month))
            .map(|(from, to)| {
                let mut out = Vec::new();
                let mut day = from;
                while day.days_since_epoch() <= to.days_since_epoch() {
                    if matches_month_day(&rule.by_month_day, day) {
                        out.push(day);
                    }
                    day = day.add_days(1);
                }
                out
            })
            .unwrap_or_default()
    } else {
        CivilDate::new(year, start.month, start.day)
            .into_iter()
            .collect()
    };
    if !rule.by_day.is_empty() && !rule.by_month_day.is_empty() {
        days.retain(|day| matches_month_day(&rule.by_month_day, *day));
    }
    days
}
