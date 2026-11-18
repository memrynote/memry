//! Text appended to the end of a day (`appendToJournalEntry` of `journal/update-entry.ts`): the
//! sticky's journal send.

use std::time::Duration;

use super::update::{DayUpdate, DayUpdated};
use crate::notes::error::NotesError;
use crate::notes::service::NotesService;
use crate::session::OpenVault;

/// How long the append waits for the write-back of an open editor's typing.
const SETTLE: Duration = Duration::from_secs(2);

impl NotesService {
    /// Appends `markdown`, trimmed, as its own paragraph after the day's text; a day with no file
    /// is made with it. The caller sends non-blank text.
    ///
    /// An editor open on the day writes its document to the file on a debounce, so the file can
    /// trail the document. The scheduled write-backs run first, so the append does not replace
    /// the body with a file that misses the last keystrokes.
    pub fn append_to_day(
        &self,
        open: &OpenVault,
        date: &str,
        markdown: &str,
    ) -> Result<DayUpdated, NotesError> {
        if !self.tier.flush(SETTLE) {
            tracing::warn!(
                scope = "Journal",
                "a write-back was still running when text was appended to a day"
            );
        }
        let journal = self.journal(open)?;
        let head = super::entry(open, &journal, date)?
            .map(|entry| entry.content.trim_end().to_owned())
            .unwrap_or_default();
        let text = markdown.trim();
        let content = match head.is_empty() {
            true => text.to_owned(),
            false => format!("{head}\n\n{text}"),
        };
        self.update_day(
            open,
            DayUpdate {
                date: date.to_owned(),
                content: Some(content),
                ..DayUpdate::default()
            },
        )
    }
}
