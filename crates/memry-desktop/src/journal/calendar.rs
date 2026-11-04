//! The journal calendar's reads (Step 13m-4, #3530): the heatmap, a month's entries, a year's
//! month stats and the streak (`journal:getHeatmap`, `getMonthEntries`, `getYearStats` and
//! `getStreak` of `ipc/journal-handlers.ts`).
//!
//! Electron reads every one from its index of the day files (`note_cache` rows with a date).
//! Here the days are the live journal records ([`Journal::calendar_days`]), so a deleted day
//! never shows, whatever file is on disk. A day is measured where it is held:
//! - a day with a file row by the note index's row of that file (`note_stats`, the counts
//!   `syncNoteToCache` stores), 0 until the index measured it, as Electron's tier-0 row reads;
//! - a day no file row names yet (made on another device; its file is written on its first
//!   open) by its text and its record's tags. Electron writes such a day's file when the sync
//!   applies it, so it shows in every view; here it shows too, its counts taken from its text
//!   rather than its markdown until its file is written.

use memry_core::api::errors::StorageError;
use memry_core::api::journal::Journal;
use memry_core::domain::journal_ops::reads::{CalendarDay, DayHeld};
use memry_core::domain::journal_rules::{
    ActivityLevel, JOURNAL_PREVIEW_LENGTH, JournalDayCounts, calculate_activity_level,
    extract_journal_preview, heatmap_day, utf16_len, year_month_stats,
};
use memry_core::domain::note_stats::{FileTags, word_count};
use memry_core::storage::repositories::instants::to_iso8601;
use serde::Serialize;

use super::{SCOPE, read_day_file, view_of};
use crate::notes::error::NotesError;
use crate::session::OpenVault;
use crate::vault::consumer::rows::now_ms;

/// `HeatmapEntry` (`packages/contracts/src/journal-api.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HeatmapEntryView {
    pub date: String,
    pub character_count: u32,
    pub level: ActivityLevel,
}

/// `MonthEntryPreview`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MonthEntryView {
    pub date: String,
    /// `extractPreview(content, 100)` of the day's text, empty when it does not read.
    pub preview: String,
    pub word_count: u32,
    pub character_count: u32,
    pub activity_level: ActivityLevel,
    pub tags: Vec<String>,
}

/// `MonthStats`: one month of a year that has an entry.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MonthStatsView {
    pub year: u32,
    /// 1-12
    pub month: u32,
    pub entry_count: u32,
    pub total_word_count: u32,
    pub total_character_count: u32,
    pub average_level: f64,
}

/// `JournalStreak`, counted from this device's UTC date as Electron's `getJournalStreak`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StreakView {
    pub current_streak: u32,
    pub longest_streak: u32,
    pub last_entry_date: Option<String>,
}

/// A live day with the counts the calendar shows for it.
struct Measured {
    day: CalendarDay,
    word_count: u32,
    character_count: u32,
    /// The index's row of the day's file, for its tags.
    file: Option<FileTags>,
}

/// Every live day of `year`, oldest first.
pub fn heatmap(
    open: &OpenVault,
    journal: &Journal,
    year: u32,
) -> Result<Vec<HeatmapEntryView>, NotesError> {
    let days = measured(open, journal, &year_bounds(year)?)?;
    Ok(days
        .into_iter()
        .map(|it| {
            let day = heatmap_day(&it.day.date, u64::from(it.character_count));
            HeatmapEntryView {
                date: day.date,
                character_count: it.character_count,
                level: day.level,
            }
        })
        .collect())
}

/// Every live day of `month` (1-12) of `year`, newest first, with its preview and tags.
pub fn month_entries(
    open: &OpenVault,
    journal: &Journal,
    year: u32,
    month: u32,
) -> Result<Vec<MonthEntryView>, NotesError> {
    year_bounds(year)?;
    if !(1..=12).contains(&month) {
        return Err(invalid(format!("journal month {month} is not 1-12")));
    }
    let bounds = (
        format!("{year}-{month:02}-01"),
        format!("{year}-{month:02}-31"),
    );
    let mut entries = Vec::new();
    for it in measured(open, journal, &bounds)?.into_iter().rev() {
        let (preview, tags) = match &it.day.held {
            DayHeld::File(path) => {
                let file = it.file.unwrap_or_default();
                let tags = open
                    .search
                    .note_tags(&it.day.id, file.header_tags, file.file_hash)?;
                (
                    file_preview(open, &it.day.date, path),
                    tags.unwrap_or_default(),
                )
            }
            DayHeld::Record { text, tags } => (preview_of(text), tags.clone()),
        };
        entries.push(MonthEntryView {
            preview,
            word_count: it.word_count,
            character_count: it.character_count,
            activity_level: calculate_activity_level(u64::from(it.character_count)),
            tags,
            date: it.day.date,
        });
    }
    Ok(entries)
}

/// One row per month of `year` that has a live day, in month order.
pub fn year_stats(
    open: &OpenVault,
    journal: &Journal,
    year: u32,
) -> Result<Vec<MonthStatsView>, NotesError> {
    let counts: Vec<JournalDayCounts> = measured(open, journal, &year_bounds(year)?)?
        .into_iter()
        .map(|it| JournalDayCounts {
            date: it.day.date,
            word_count: Some(u64::from(it.word_count)),
            character_count: Some(u64::from(it.character_count)),
        })
        .collect();
    let clamp = |n: u64| u32::try_from(n).unwrap_or(u32::MAX);
    Ok(year_month_stats(&counts)
        .into_iter()
        .map(|stats| MonthStatsView {
            year,
            month: stats.month,
            entry_count: stats.entry_count,
            total_word_count: clamp(stats.total_word_count),
            total_character_count: clamp(stats.total_character_count),
            average_level: stats.average_level,
        })
        .collect())
}

/// The current and longest runs of live days.
pub fn streak(journal: &Journal) -> Result<StreakView, NotesError> {
    let today =
        to_iso8601(now_ms()).ok_or_else(|| invalid("the clock is past year 9999".into()))?;
    let streak = journal.streak(today[..10].to_owned())?;
    Ok(StreakView {
        current_streak: streak.current,
        longest_streak: streak.longest,
        last_entry_date: streak.last_entry_date,
    })
}

/// The live days in `bounds`, each measured where it is held (the module docs).
fn measured(
    open: &OpenVault,
    journal: &Journal,
    (from, to): &(String, String),
) -> Result<Vec<Measured>, NotesError> {
    let mut out = Vec::new();
    for day in journal.calendar_days(from, to)? {
        let (word_count, character_count, file) = match &day.held {
            DayHeld::File(_) => match open.search.note_stats(&day.id)? {
                Some(stored) => (
                    stored.stats.word_count,
                    stored.stats.character_count,
                    Some(FileTags {
                        header_tags: stored.stats.header_tags,
                        word_count: stored.stats.word_count,
                        file_hash: stored.file_hash,
                    }),
                ),
                None => (0, 0, None),
            },
            DayHeld::Record { text, .. } => (
                word_count(text),
                u32::try_from(utf16_len(text)).unwrap_or(u32::MAX),
                None,
            ),
        };
        out.push(Measured {
            day,
            word_count,
            character_count,
            file,
        });
    }
    Ok(out)
}

/// The preview of the day file at `rel`, as Electron's handler reads it (`readJournalEntry`,
/// then `extractPreview`); empty when the file is gone or does not read, which is logged.
fn file_preview(open: &OpenVault, date: &str, rel: &str) -> String {
    match read_day_file(&open.path, rel) {
        Ok(Some(raw)) => preview_of(&view_of(date, &raw, None).content),
        Ok(None) => String::new(),
        Err(error) => {
            tracing::warn!(
                scope = SCOPE,
                date,
                "a day's preview does not read: {error}"
            );
            String::new()
        }
    }
}

fn preview_of(text: &str) -> String {
    extract_journal_preview(text, JOURNAL_PREVIEW_LENGTH)
}

/// `GetHeatmapInputSchema`'s year range, and the year's first and last day.
fn year_bounds(year: u32) -> Result<(String, String), NotesError> {
    if !(1970..=2100).contains(&year) {
        return Err(invalid(format!("journal year {year} is not 1970-2100")));
    }
    Ok((format!("{year}-01-01"), format!("{year}-12-31")))
}

fn invalid(what: String) -> NotesError {
    NotesError::Storage(StorageError::Invalid { what })
}
