//! Inbox statistics and capture patterns, as desktop computes them
//! (`apps/desktop/src/main/inbox/stats.ts`, `queries.ts` `handleGetStats` /
//! `handleGetPatterns`, the Insights view `pages/inbox/inbox-health-view.tsx`).
//!
//! Desktop's `inbox_stats` table is rebuilt from the rows
//! (`rebuildInboxStatsTable`): a capture counts on the **UTC** date of its
//! `createdAt`, a filing on the UTC date of its `filedAt`. The same derivation
//! runs here over the synced rows, so two devices holding the same rows show
//! the same numbers. Like desktop's table, it counts eight types: `video` has
//! no capture column there (`incrementCaptureColumn`).
//!
//! Desktop subtracts days with `setDate` in local time before taking the UTC
//! date; this takes whole 24-hour days off the instant. They differ only in
//! the hour a DST change moves.

use std::collections::BTreeMap;

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::domain::notes::failed;

const DAY_MS: i64 = 86_400_000;

/// The eight types `inbox_stats` has a capture column for.
const COUNTED_TYPES: [&str; 8] = [
    "link", "note", "image", "voice", "clip", "pdf", "social", "reminder",
];

/// Desktop's `DEFAULT_STALE_DAYS`.
pub const DEFAULT_STALE_DAYS: i64 = 7;

/// `InboxStats` plus the Insights view's derived process rate.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct InboxStats {
    pub total_items: i64,
    pub stale_count: i64,
    pub snoozed_count: i64,
    pub captured_today: i64,
    pub processed_today: i64,
    /// Minutes, rounded.
    pub avg_time_to_process: i64,
    pub captured_this_week: i64,
    pub processed_this_week: i64,
    /// `captured / processed` to one decimal, times ten (desktop's
    /// `captureProcessRatio`, as an integer so it compares exactly).
    pub capture_process_ratio_tenths: i64,
    /// `processedThisWeek / capturedThisWeek` in percent (Insights).
    pub process_rate: i64,
    pub age_fresh: i64,
    pub age_aging: i64,
    pub age_stale: i64,
    pub oldest_item_days: i64,
    pub current_streak: i64,
    /// Filed in the last seven days, the Inbox Zero line.
    pub filed_this_week: i64,
}

/// `CapturePattern`: `heatmap[hour][day]` with Monday = 0, over the last 84
/// days; types over the same window, most captured first.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CapturePattern {
    pub heatmap: Vec<Vec<i64>>,
    /// `(type, count, percentage)`.
    pub types: Vec<(String, i64, i64)>,
    /// The busiest `(day, hour)` cell, `None` with no captures (Insights'
    /// `computePeakInfo`: first maximum in hour-then-day order).
    pub peak: Option<(u32, u32)>,
}

struct Row {
    item_type: String,
    created_at: i64,
    filed_at: Option<i64>,
    snoozed_until: Option<i64>,
    archived_at: Option<i64>,
}

impl Row {
    fn is_pending(&self) -> bool {
        self.filed_at.is_none() && self.snoozed_until.is_none() && self.archived_at.is_none()
    }
}

fn rows(conn: &Connection) -> Result<Vec<Row>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT type, created_at, filed_at, snoozed_until, archived_at FROM inbox_items
              WHERE deleted_at IS NULL",
        )
        .map_err(failed)?;
    let mapped = statement
        .query_map([], |row| {
            Ok(Row {
                item_type: row.get(0)?,
                created_at: row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                filed_at: row.get(2)?,
                snoozed_until: row.get(3)?,
                archived_at: row.get(4)?,
            })
        })
        .map_err(failed)?;
    mapped.collect::<Result<Vec<_>, _>>().map_err(failed)
}

/// The UTC day number of an instant.
fn day(ms: i64) -> i64 {
    ms.div_euclid(DAY_MS)
}

/// Every statistic the list subtitle, Insights and Inbox Zero read.
pub fn stats(conn: &Connection, now_ms: i64, stale_days: i64) -> Result<InboxStats, StorageError> {
    let rows = rows(conn)?;
    let stale_cutoff = now_ms - stale_days.clamp(1, 365) * DAY_MS;
    let three_days_ago = now_ms - 3 * DAY_MS;
    let today = day(now_ms);
    let week_start = day(now_ms - 7 * DAY_MS);

    let mut captured_by_day: BTreeMap<i64, i64> = BTreeMap::new();
    let mut processed_by_day: BTreeMap<i64, i64> = BTreeMap::new();
    let mut out = InboxStats::default();
    let mut oldest: Option<i64> = None;
    let (mut process_minutes, mut process_count) = (0.0_f64, 0_i64);

    for row in &rows {
        if COUNTED_TYPES.contains(&row.item_type.as_str()) {
            *captured_by_day.entry(day(row.created_at)).or_default() += 1;
        }
        if let Some(filed) = row.filed_at {
            *processed_by_day.entry(day(filed)).or_default() += 1;
            if filed > now_ms - 30 * DAY_MS {
                let minutes = (filed - row.created_at) as f64 / 60_000.0;
                if minutes >= 0.0 {
                    process_minutes += minutes;
                    process_count += 1;
                }
            }
            if filed >= now_ms - 7 * DAY_MS {
                out.filed_this_week += 1;
            }
        }
        if row.snoozed_until.is_some() && row.archived_at.is_none() {
            out.snoozed_count += 1;
        }
        if row.is_pending() {
            out.total_items += 1;
            if row.created_at < stale_cutoff {
                out.stale_count += 1;
                out.age_stale += 1;
            } else if row.created_at < three_days_ago {
                out.age_aging += 1;
            } else {
                out.age_fresh += 1;
            }
            oldest = Some(oldest.map_or(row.created_at, |o| o.min(row.created_at)));
        }
    }

    out.captured_today = captured_by_day.get(&today).copied().unwrap_or(0);
    out.processed_today = processed_by_day.get(&today).copied().unwrap_or(0);
    out.captured_this_week = captured_by_day.range(week_start..).map(|(_, n)| n).sum();
    out.processed_this_week = processed_by_day.range(week_start..).map(|(_, n)| n).sum();
    out.avg_time_to_process = if process_count > 0 {
        (process_minutes / process_count as f64).round() as i64
    } else {
        0
    };
    out.capture_process_ratio_tenths = if out.processed_this_week > 0 {
        ((out.captured_this_week as f64 / out.processed_this_week as f64) * 10.0).round() as i64
    } else {
        out.captured_this_week * 10
    };
    out.process_rate = if out.captured_this_week > 0 {
        ((out.processed_this_week as f64 / out.captured_this_week as f64) * 100.0).round() as i64
    } else {
        0
    };
    out.oldest_item_days = oldest.map_or(0, |o| (now_ms - o).div_euclid(DAY_MS));
    out.current_streak = streak(&processed_by_day, today);
    Ok(out)
}

/// `getProcessingStreak`, step for step: consecutive days with a filing,
/// counted back from today; an empty today still counts when yesterday had
/// one. Bounded at 90 days like desktop's `limit(90)` read.
fn streak(processed: &BTreeMap<i64, i64>, today: i64) -> i64 {
    let has = |d: i64| processed.get(&d).copied().unwrap_or(0) > 0;
    let mut streak = 0;
    let mut check = today;
    let mut i = 0;
    while i < 90 {
        if has(check) {
            streak += 1;
        } else if i > 0 {
            break;
        } else if has(check - 1) {
            check -= 2;
            streak += 1;
            i += 1;
            continue;
        } else {
            break;
        }
        check -= 1;
        i += 1;
    }
    streak
}

/// `handleGetPatterns`: the last 84 days of captures by UTC hour and weekday,
/// and by type.
pub fn patterns(conn: &Connection, now_ms: i64) -> Result<CapturePattern, StorageError> {
    let cutoff = now_ms - 84 * DAY_MS;
    let mut heatmap = vec![vec![0_i64; 7]; 24];
    let mut by_type: Vec<(String, i64)> = Vec::new();
    for row in rows(conn)?.into_iter().filter(|r| r.created_at >= cutoff) {
        let ms_of_day = row.created_at.rem_euclid(DAY_MS);
        let hour = (ms_of_day / 3_600_000) as usize;
        // 1970-01-01 was a Thursday: `%w` = (days + 4) mod 7, Sunday = 0.
        let dow = (day(row.created_at) + 4).rem_euclid(7);
        let day_idx = ((dow + 6) % 7) as usize;
        heatmap[hour][day_idx] += 1;
        match by_type.iter_mut().find(|(t, _)| *t == row.item_type) {
            Some((_, n)) => *n += 1,
            None => by_type.push((row.item_type, 1)),
        }
    }
    by_type.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let total: i64 = by_type.iter().map(|(_, n)| n).sum();
    let types = by_type
        .into_iter()
        .map(|(t, n)| {
            let pct = if total > 0 {
                ((n as f64 / total as f64) * 100.0).round() as i64
            } else {
                0
            };
            (t, n, pct)
        })
        .collect();
    let mut peak: Option<(u32, u32)> = None;
    let mut max = 0;
    for (hour, row) in heatmap.iter().enumerate() {
        for (day_idx, count) in row.iter().enumerate() {
            if *count > max {
                max = *count;
                peak = Some((day_idx as u32, hour as u32));
            }
        }
    }
    Ok(CapturePattern {
        heatmap,
        types,
        peak,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_streak_counts_back_from_today_or_yesterday() {
        let mut p = BTreeMap::new();
        assert_eq!(streak(&p, 100), 0);
        p.insert(100, 1);
        p.insert(99, 2);
        p.insert(97, 1);
        assert_eq!(streak(&p, 100), 2);
        p.remove(&100);
        // today empty, yesterday counts, then the gap at 98 ends it.
        assert_eq!(streak(&p, 100), 1);
        p.insert(98, 1);
        assert_eq!(streak(&p, 100), 3);
    }

    #[test]
    fn a_utc_weekday_is_monday_first() {
        // 2026-09-21 is a Monday.
        let monday = 1_789_948_800_000_i64;
        assert_eq!(((day(monday) + 4).rem_euclid(7) + 6) % 7, 0);
    }
}
