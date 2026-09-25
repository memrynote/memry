//! Month and year arithmetic for the journal's Month and Year views.
//!
//! Mirrors `domain-notes/src/journal/stats.ts`. `today` is a `YYYY-MM-DD`
//! argument; month names stay in the shells.

use std::collections::BTreeMap;

use super::{ActivityLevel, calculate_activity_level};
use crate::domain::calendar::CivilDate;

/// One day of a month, relative to `today`.
#[derive(Debug, Clone, PartialEq)]
pub struct JournalMonthDay {
    /// `YYYY-MM-DD`
    pub date: String,
    pub is_today: bool,
    pub is_future: bool,
}

/// One day of the heatmap: its characters and their activity level.
#[derive(Debug, Clone, PartialEq)]
pub struct JournalHeatmapDay {
    pub date: String,
    pub character_count: u64,
    pub level: ActivityLevel,
}

/// The Year view's card for one month (`getMonthStats` without its label).
#[derive(Debug, Clone, PartialEq)]
pub struct JournalMonthActivity {
    /// 0-11
    pub month: u32,
    /// Days of the month whose entry has at least one character.
    pub entry_count: u32,
    pub total_chars: u64,
    /// Highest level per 7-day block from the 1st, at most 5 blocks.
    pub activity_dots: Vec<ActivityLevel>,
}

/// One day's counts, as the index row carries them.
#[derive(Debug, Clone, PartialEq)]
pub struct JournalDayCounts {
    pub date: String,
    pub word_count: Option<u64>,
    pub character_count: Option<u64>,
}

/// `getJournalYearStats`' row for one month that has entries.
#[derive(Debug, Clone, PartialEq)]
pub struct JournalYearMonthStats {
    /// 1-12
    pub month: u32,
    pub entry_count: u32,
    pub total_word_count: u64,
    pub total_character_count: u64,
    /// Mean of the per-day activity levels, rounded to two decimals.
    pub average_level: f64,
}

/// `daysInMonth`: days in `month0` (0-11) of `year`.
pub fn days_in_month(year: i64, month0: u32) -> u32 {
    CivilDate::from_js_parts(year, i64::from(month0) + 1, 0).day
}

/// `` `${year}-${pad2(month0 + 1)}-${pad2(day)}` ``.
fn day_key(year: i64, month0: u32, day: u32) -> String {
    format!("{year}-{:02}-{day:02}", month0 + 1)
}

/// `monthDays`: every day of `month0` (0-11), flagged against `today`.
pub fn month_days(year: i64, month0: u32, today: &str) -> Vec<JournalMonthDay> {
    (1..=days_in_month(year, month0))
        .map(|day| {
            let date = day_key(year, month0, day);
            JournalMonthDay {
                is_today: date == today,
                is_future: date.as_str() > today,
                date,
            }
        })
        .collect()
}

/// `heatmapDay`: the heatmap entry for one day's character count.
pub fn heatmap_day(date: &str, character_count: u64) -> JournalHeatmapDay {
    JournalHeatmapDay {
        date: date.to_owned(),
        character_count,
        level: calculate_activity_level(character_count),
    }
}

/// `monthActivity`: the twelve Year-view cards for `year`. Levels are read
/// from the heatmap as given, never recomputed.
pub fn month_activity(year: i64, heatmap: &[JournalHeatmapDay]) -> Vec<JournalMonthActivity> {
    (0..12)
        .map(|month0| {
            let prefix = format!("{year}-{:02}", month0 + 1);
            let entries: Vec<&JournalHeatmapDay> = heatmap
                .iter()
                .filter(|entry| entry.date.starts_with(&prefix))
                .collect();
            let entry_count = entries
                .iter()
                .filter(|entry| entry.character_count > 0)
                .count();
            let total_chars = entries.iter().map(|entry| entry.character_count).sum();

            let count = days_in_month(year, month0);
            let activity_dots = (0..count.div_ceil(7).min(5))
                .map(|week| {
                    let week_start = week * 7 + 1;
                    let week_end = (week_start + 6).min(count);
                    (week_start..=week_end)
                        .filter_map(|day| {
                            let date = day_key(year, month0, day);
                            entries.iter().find(|entry| entry.date == date)
                        })
                        .map(|entry| entry.level)
                        .fold(0, ActivityLevel::max)
                })
                .collect();

            JournalMonthActivity {
                month: month0,
                entry_count: u32::try_from(entry_count).unwrap_or(u32::MAX),
                total_chars,
                activity_dots,
            }
        })
        .collect()
}

/// `averageActivityLevel`: mean level of a set of days, rounded to two
/// decimals (`Math.round(x * 100) / 100`); a missing count is 0; 0 when empty.
pub fn average_activity_level(character_counts: &[Option<u64>]) -> f64 {
    if character_counts.is_empty() {
        return 0.0;
    }
    let sum: u64 = character_counts
        .iter()
        .map(|count| u64::from(calculate_activity_level(count.unwrap_or(0))))
        .sum();
    // Levels are non-negative, where `f64::round` and `Math.round` agree.
    (sum as f64 / character_counts.len() as f64 * 100.0).round() / 100.0
}

/// `Number(date.slice(5, 7))` for the dates `yearMonthStats` can group: an
/// empty slice is 0, a non-numeric one (JS `NaN`) is `None`.
fn month_of(date: &str) -> Option<u32> {
    let slice: String = date.chars().skip(5).take(2).collect();
    let slice = super::js_trim(&slice);
    if slice.is_empty() {
        return Some(0);
    }
    slice.parse().ok()
}

/// `yearMonthStats`: `getJournalYearStats` over already-selected rows of one
/// year, one row per month that has at least one entry, in month order. A row
/// whose date has no numeric month (JS groups those under `NaN`) is skipped.
pub fn year_month_stats(days: &[JournalDayCounts]) -> Vec<JournalYearMonthStats> {
    let mut by_month: BTreeMap<u32, Vec<&JournalDayCounts>> = BTreeMap::new();
    for day in days {
        if let Some(month) = month_of(&day.date) {
            by_month.entry(month).or_default().push(day);
        }
    }
    by_month
        .into_iter()
        .map(|(month, rows)| {
            let counts: Vec<Option<u64>> = rows.iter().map(|row| row.character_count).collect();
            JournalYearMonthStats {
                month,
                entry_count: u32::try_from(rows.len()).unwrap_or(u32::MAX),
                total_word_count: rows.iter().map(|row| row.word_count.unwrap_or(0)).sum(),
                total_character_count: counts.iter().map(|count| count.unwrap_or(0)).sum(),
                average_level: average_activity_level(&counts),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_in_month_handles_leap_years() {
        assert_eq!(days_in_month(2096, 1), 29);
        assert_eq!(days_in_month(2100, 1), 28);
        assert_eq!(days_in_month(2000, 1), 29);
        assert_eq!(days_in_month(2099, 11), 31);
    }

    #[test]
    fn average_rounds_like_math_round() {
        assert_eq!(average_activity_level(&[]), 0.0);
        assert_eq!(average_activity_level(&[Some(1), None, Some(2000)]), 1.67);
    }

    #[test]
    fn month_of_mirrors_number_of_slice() {
        assert_eq!(month_of("2099-06-01"), Some(6));
        assert_eq!(month_of("2099"), Some(0));
        assert_eq!(month_of("2099-xx-01"), None);
    }
}
