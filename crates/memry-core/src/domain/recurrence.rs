//! Recurrence math for repeating tasks: the next occurrence, the series end,
//! and what completing a repeating task produces (spec 004 D3, D5).
//!
//! A port of desktop's `packages/domain-tasks/src/parsing/recurrence.ts` plus
//! `firstOccurrenceFor` from `repeat-phrase.ts`, quirks included, pinned by the
//! `recurrence` and `repeatPhrase.firstOccurrence` sections of the
//! `task-parsing` conformance vectors. Every date is a local calendar date
//! ([`CivilDate`]) and nothing here reads the clock: "now" is passed in.
//!
//! Desktop's JavaScript truthiness is kept on purpose: an `endCount`,
//! `dayOfMonth` or `weekOfMonth` of `0` counts as absent, while
//! `dayOfWeekForMonth` only has to be present (`0` is Sunday).

use super::calendar::{CivilDate, LocalDateTime};
use super::repeat_config::{EndType, Frequency, MonthlyType, RepeatConfig};

/// `generated < 100` in `calculateNextOccurrences`: the hard cap on how many
/// dates one preview produces, whatever `count` asks for.
const MAX_GENERATED_OCCURRENCES: usize = 100;

/// `nth` value `findNthWeekdayOfMonth` reads as "the last one in the month".
const LAST_WEEK_OF_MONTH: i64 = 5;

/// `getRepeatProgress`: how far a count-limited series has run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RepeatProgress {
    pub current: i64,
    pub total: i64,
    /// `Math.round(current / total * 100)`.
    pub percentage: i64,
}

/// What completing a repeating task produces (`RepeatCompletion`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RepeatCompletion {
    /// The next occurrence's due date, or `None` when the series has ended.
    pub next_due_date: Option<CivilDate>,
    /// The `completedCount` the next occurrence carries.
    pub completed_count: i64,
}

/// `getWeekOfMonth`: `ceil(day / 7)`, so days 1-7 are week 1.
pub fn week_of_month(date: CivilDate) -> i64 {
    (i64::from(date.day) + 6) / 7
}

/// `isLastWeekdayOfMonth`: the same weekday a week later is in another month.
pub fn is_last_weekday_of_month(date: CivilDate) -> bool {
    date.add_days(7).month != date.month
}

/// `findNthWeekdayOfMonth`: the `nth` (1-4, or 5 for the last) `day_of_week`
/// (0 = Sunday) of `new Date(year, month0, 1)`'s month. `month0` is zero-based
/// and rolls over like `Date`; an `nth` outside 1-5 is not clamped, so `6` is
/// five weeks past the first match, exactly as desktop computes it.
///
/// Desktop searches day by day and never terminates for a `day_of_week` past
/// 6; here the search is arithmetic and such a value is read modulo 7.
pub fn find_nth_weekday_of_month(year: i64, month0: i64, nth: i64, day_of_week: u32) -> CivilDate {
    let target = i64::from(day_of_week % 7);
    let first = CivilDate::from_js_parts(year, month0, 1);
    if nth == LAST_WEEK_OF_MONTH {
        let last = first.end_of_month();
        let back = (i64::from(last.weekday()) - target).rem_euclid(7);
        return last.add_days(-back);
    }
    let forward = (target - i64::from(first.weekday())).rem_euclid(7);
    first.add_days(forward + (nth - 1) * 7)
}

/// `calculateNextOccurrence`: the occurrence after `from`, or `None` when the
/// series has ended (by date or by count) or the frequency is unknown.
///
/// A `dayOfWeekForMonth` outside 0-6 also yields `None`: desktop's weekday
/// search never terminates for it, so there is no desktop answer to match.
pub fn calculate_next_occurrence(from: CivilDate, config: &RepeatConfig) -> Option<CivilDate> {
    let interval = config.interval;
    let next = match &config.frequency {
        Frequency::Daily => from.add_days(interval),
        Frequency::Weekly => match config.days_of_week.as_deref() {
            Some(days) if !days.is_empty() => next_weekday(from, days, interval),
            _ => from.add_days(interval * 7),
        },
        Frequency::Monthly => next_monthly(from, config)?,
        Frequency::Yearly => from.add_years(interval),
        Frequency::Other(_) => return None,
    };

    if config.end_type == EndType::Date
        && config
            .end_date
            .is_some_and(|end| LocalDateTime::at_start_of(next) > end)
    {
        return None;
    }
    if config.end_type == EndType::Count
        && truthy(config.end_count).is_some_and(|end| config.completed_count >= end)
    {
        return None;
    }
    Some(next)
}

/// `calculateNextOccurrences`: `start` followed by the occurrences after it,
/// until `count` dates, the series end, or the 100-date cap. `start` is always
/// included, even when `count` is 0.
pub fn calculate_next_occurrences(
    start: CivilDate,
    config: &RepeatConfig,
    count: usize,
) -> Vec<CivilDate> {
    let mut occurrences = vec![start];
    let mut current = start;
    let mut generated: usize = 1;

    while occurrences.len() < count && generated < MAX_GENERATED_OCCURRENCES {
        if config.end_type == EndType::Date
            && config
                .end_date
                .is_some_and(|end| LocalDateTime::at_start_of(current) > end)
        {
            break;
        }
        if config.end_type == EndType::Count
            && truthy(config.end_count)
                .is_some_and(|end| i64::try_from(generated).unwrap_or(i64::MAX) >= end)
        {
            break;
        }
        let Some(next) = calculate_next_occurrence(current, config) else {
            break;
        };
        occurrences.push(next);
        current = next;
        generated += 1;
    }
    occurrences
}

/// `shouldCreateNextOccurrence`: whether the series continues at `now`.
pub fn should_create_next_occurrence(config: &RepeatConfig, now: LocalDateTime) -> bool {
    match config.end_type {
        EndType::Never => true,
        EndType::Count => truthy(config.end_count).is_none_or(|end| config.completed_count < end),
        EndType::Date => config.end_date.is_none_or(|end| now <= end),
        EndType::Other(_) => true,
    }
}

/// `getRepeatProgress`: `None` unless the series ends after a (non-zero) count.
pub fn repeat_progress(config: &RepeatConfig) -> Option<RepeatProgress> {
    if config.end_type != EndType::Count {
        return None;
    }
    let total = truthy(config.end_count)?;
    let ratio = config.completed_count as f64 / total as f64 * 100.0;
    Some(RepeatProgress {
        current: config.completed_count,
        total,
        percentage: js_math_round(ratio),
    })
}

/// `completeRepeatingTask`: completing the occurrence due on `due` at
/// `completed_at`.
///
/// `repeat_from == Some("completion")` restarts the interval on the completion
/// day; anything else (`"due"`, `None`, an unknown value) keeps the cadence off
/// the due date. The next date is computed with the config as stored, and the
/// end check with the incremented count, as desktop does.
pub fn complete_repeating_task(
    due: CivilDate,
    config: &RepeatConfig,
    repeat_from: Option<&str>,
    completed_at: LocalDateTime,
) -> RepeatCompletion {
    let completed_count = config.completed_count + 1;
    let anchor = if repeat_from == Some("completion") {
        completed_at.date()
    } else {
        due
    };
    let next = calculate_next_occurrence(anchor, config);
    let counted = RepeatConfig {
        completed_count,
        ..config.clone()
    };
    let should_create = should_create_next_occurrence(&counted, completed_at);
    RepeatCompletion {
        next_due_date: next.filter(|_| should_create),
        completed_count,
    }
}

/// `firstOccurrenceFor` (`repeat-phrase.ts`): the first due date of a freshly
/// captured repeating task. A weekly series with days picked starts on the
/// first picked weekday on or after `from`'s day; anything else starts that day.
pub fn first_occurrence_for(config: &RepeatConfig, from: LocalDateTime) -> CivilDate {
    let start = from.date();
    let days = match (&config.frequency, config.days_of_week.as_deref()) {
        (Frequency::Weekly, Some(days)) if !days.is_empty() => days,
        _ => return start,
    };
    (0..7)
        .map(|offset| start.add_days(offset))
        .find(|candidate| days.contains(&i64::from(candidate.weekday())))
        .unwrap_or(start)
}

/// `findNextWeekday`: with `interval` 1, a later picked day in the same
/// (Sunday-first) week; otherwise the first picked day `interval` weeks on.
fn next_weekday(from: CivilDate, days_of_week: &[i64], interval: i64) -> CivilDate {
    let mut sorted = days_of_week.to_vec();
    sorted.sort_unstable();
    let current_day = i64::from(from.weekday());

    if interval == 1
        && let Some(later) = sorted.iter().find(|&&day| day > current_day)
    {
        return from.add_days(later - current_day);
    }

    let days_to_next_week = (6 - current_day) + 1 + (interval - 1) * 7;
    let start_of_next_week = from.add_days(days_to_next_week);
    // `sortedDays[0]`: the caller only passes a non-empty list.
    let first_day = sorted.first().copied().unwrap_or(0);
    start_of_next_week.add_days(first_day)
}

/// The monthly branch of `calculateNextOccurrence`. `None` only for a week
/// pattern whose weekday is outside 0-6 (see [`calculate_next_occurrence`]).
fn next_monthly(from: CivilDate, config: &RepeatConfig) -> Option<CivilDate> {
    let shifted = from.add_months(config.interval);
    match (
        config.monthly_type,
        truthy(config.day_of_month),
        truthy(config.week_of_month),
    ) {
        (Some(MonthlyType::DayOfMonth), Some(day_of_month), _) => {
            // `setDate(Math.min(dayOfMonth, daysInMonth))`, rolling like `Date`
            // for a negative day.
            let days_in_month = i64::from(shifted.end_of_month().day);
            Some(CivilDate::from_js_parts(
                shifted.year,
                i64::from(shifted.month) - 1,
                day_of_month.min(days_in_month),
            ))
        }
        (Some(MonthlyType::WeekPattern), _, Some(week_of_month))
            if config.day_of_week_for_month.is_some() =>
        {
            let day_of_week = config
                .day_of_week_for_month
                .and_then(|day| u32::try_from(day).ok())
                .filter(|day| *day <= 6)?;
            Some(find_nth_weekday_of_month(
                shifted.year,
                i64::from(shifted.month) - 1,
                week_of_month,
                day_of_week,
            ))
        }
        _ => Some(shifted),
    }
}

/// JavaScript truthiness for an optional number: absent and `0` are falsy.
fn truthy(value: Option<i64>) -> Option<i64> {
    value.filter(|number| *number != 0)
}

/// `Math.round`: halves round toward positive infinity (`-2.5` is `-2`).
fn js_math_round(value: f64) -> i64 {
    let floor = value.floor();
    let rounded = if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    };
    rounded as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(key: &str) -> CivilDate {
        CivilDate::parse_key(key).expect("valid key")
    }

    #[test]
    fn week_of_month_is_ceil_day_over_seven() {
        assert_eq!(week_of_month(d("2026-01-01")), 1);
        assert_eq!(week_of_month(d("2026-01-07")), 1);
        assert_eq!(week_of_month(d("2026-01-08")), 2);
        assert_eq!(week_of_month(d("2026-01-29")), 5);
    }

    #[test]
    fn last_weekday_is_the_one_a_week_before_the_month_ends() {
        assert!(is_last_weekday_of_month(d("2026-01-25")));
        assert!(!is_last_weekday_of_month(d("2026-01-24")));
        assert!(is_last_weekday_of_month(d("2026-02-22")));
    }

    #[test]
    fn math_round_sends_halves_up() {
        assert_eq!(js_math_round(66.666), 67);
        assert_eq!(js_math_round(2.5), 3);
        assert_eq!(js_math_round(-2.5), -2);
        assert_eq!(js_math_round(-2.6), -3);
    }
}
