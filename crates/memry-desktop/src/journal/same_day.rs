//! "This day in other years" (`journal:getSameDayEntries` of `ipc/journal-handlers.ts`): the
//! days the On this day section and the All years view put next to a journal day.
//!
//! Feb 29 has no day of its own in a non-leap year (`packages/domain-notes/src/journal/
//! same-day.ts`). Its entries show on Feb 28 of a non-leap year, and a Feb 29 shows the Feb 28
//! of non-leap years, so a leap-day entry never drops out of sight for three years.
//!
//! The days are the live journal records, as the calendar's ([`super::calendar`]): a day with a
//! file reads its text from the file. A day no file row names yet (synced from another device,
//! its file written on its first open) is listed from its record's plain text; Electron reads
//! files only, so it shows that day once its sync wrote the file. This matches the Tauri
//! calendar. A day whose text is empty is left out, and a day file past the note ceiling is
//! logged and left out rather than failing the list.

use memry_core::api::journal::Journal;
use memry_core::domain::journal::valid_date;
use memry_core::domain::journal_ops::reads::DayHeld;
use memry_core::domain::journal_rules::{count_words, extract_journal_preview};
use serde::Serialize;

use super::{SCOPE, entry};
use crate::notes::error::NotesError;
use crate::session::OpenVault;

/// Electron's handler cuts the preview at 160 (`extractPreview(entry.content, 160)`).
const SAME_DAY_PREVIEW_LENGTH: usize = 160;

const LEAP_DAY: &str = "02-29";
const DAY_BEFORE_LEAP_DAY: &str = "02-28";

/// `SameDayEntry` (`packages/contracts/src/journal-api.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SameDayEntryView {
    pub id: String,
    /// `YYYY-MM-DD`
    pub date: String,
    pub preview: String,
    /// The markdown below the frontmatter, trimmed.
    pub content: String,
    pub word_count: u32,
}

/// The live days of other years that show as the same day as `date`, newest first, each with
/// its text. A day without text is left out.
pub fn same_day_entries(
    open: &OpenVault,
    journal: &Journal,
    date: &str,
) -> Result<Vec<SameDayEntryView>, NotesError> {
    let date = valid_date(date)?;
    let mut out = Vec::new();
    for candidate in journal
        .days_with_entries("0001-01-01".into(), "9999-12-31".into())?
        .into_iter()
        .rev()
        .filter(|candidate| is_same_day_in_other_year(date, candidate))
    {
        let Some(day) = journal
            .calendar_days(&candidate, &candidate)?
            .into_iter()
            .next()
        else {
            continue;
        };
        let (id, content) = match day.held {
            DayHeld::File(_) => match entry(open, journal, &candidate) {
                Ok(Some(view)) => (view.id, view.content),
                Ok(None) => continue,
                Err(NotesError::TooLarge(ceiling)) => {
                    tracing::warn!(
                        scope = SCOPE,
                        date = %candidate,
                        ceiling,
                        "a same-day file is past the note ceiling; left out of On this day"
                    );
                    continue;
                }
                Err(error) => return Err(error),
            },
            DayHeld::Record { text } => (day.id, text.trim().to_owned()),
        };
        if content.trim().is_empty() {
            continue;
        }
        out.push(SameDayEntryView {
            id,
            preview: extract_journal_preview(&content, SAME_DAY_PREVIEW_LENGTH),
            word_count: u32::try_from(count_words(&content)).unwrap_or(u32::MAX),
            content,
            date: candidate,
        });
    }
    Ok(out)
}

fn is_leap_year(year: u32) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}

/// `(year, "MM-DD")` of a valid `YYYY-MM-DD`.
fn split(date: &str) -> (u32, &str) {
    (date[..4].parse().unwrap_or(0), &date[5..])
}

/// True when `candidate` is in another year and shows as the same day as `date`
/// (`isSameDayInOtherYear`). Both are valid `YYYY-MM-DD` dates.
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
    use super::is_same_day_in_other_year as same;

    // The cases of `same-day.test.ts`.
    #[test]
    fn matches_the_same_month_and_day_in_another_year_only() {
        assert!(same("2026-11-10", "2025-11-10"));
        assert!(!same("2026-11-10", "2026-11-10"));
        assert!(!same("2026-11-10", "2025-11-11"));
    }

    #[test]
    fn shows_a_leap_day_on_feb_28_of_a_non_leap_year() {
        assert!(same("2027-02-28", "2024-02-29"));
        assert!(same("2027-02-28", "2024-02-28"));
    }

    #[test]
    fn keeps_a_leap_year_feb_28_to_its_own_day() {
        assert!(!same("2028-02-28", "2024-02-29"));
        assert!(same("2028-02-28", "2027-02-28"));
    }

    #[test]
    fn shows_non_leap_feb_28s_on_a_leap_day_but_not_leap_year_feb_28s() {
        assert!(same("2028-02-29", "2024-02-29"));
        assert!(same("2028-02-29", "2027-02-28"));
        assert!(!same("2028-02-29", "2024-02-28"));
    }

    #[test]
    fn century_years_follow_the_gregorian_rule() {
        // 2100 is not a leap year, 2000 is.
        assert!(same("2100-02-28", "2096-02-29"));
        assert!(!same("2000-02-28", "1996-02-29"));
    }
}
