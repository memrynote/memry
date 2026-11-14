//! "This day in other years" (`journal:getSameDayEntries` of `ipc/journal-handlers.ts`): the
//! days the On this day section and the All years view put next to a journal day.
//!
//! The core lists the days in one query over every year
//! ([`memry_core::domain::journal_ops::reads::same_day_calendar_days`]), Feb 29 shown on Feb 28
//! of a non-leap year as `packages/domain-notes/src/journal/same-day.ts` does.
//!
//! The days are the live journal records, as the calendar's ([`super::calendar`]): a day with a
//! file reads its text from the file. A day no file row names yet (synced from another device,
//! its file written on its first open) is listed from its record's plain text; Electron reads
//! files only, so it shows that day once its sync wrote the file. This matches the Tauri
//! calendar. A day whose text is empty is left out, and a day file past the note ceiling is
//! logged and left out rather than failing the list.

use memry_core::api::journal::Journal;
use memry_core::domain::journal_ops::reads::DayHeld;
use memry_core::domain::journal_rules::{count_words, extract_journal_preview};
use serde::Serialize;

use super::{SCOPE, entry};
use crate::notes::error::NotesError;
use crate::session::OpenVault;

/// Electron's handler cuts the preview at 160 (`extractPreview(entry.content, 160)`).
const SAME_DAY_PREVIEW_LENGTH: usize = 160;

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
    let mut out = Vec::new();
    for day in journal.same_day_calendar_days(date)? {
        let (id, content) = match day.held {
            DayHeld::File(_) => match entry(open, journal, &day.date) {
                Ok(Some(view)) => (view.id, view.content),
                Ok(None) => continue,
                Err(NotesError::TooLarge(ceiling)) => {
                    tracing::warn!(
                        scope = SCOPE,
                        date = %day.date,
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
            date: day.date,
        });
    }
    Ok(out)
}
