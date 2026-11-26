//! One book of a run (`sync-service.ts` `writeBook`): the link bookkeeping, the plan and the
//! writer. A child of `engine`, so it reads the run's state.

use memry_core::domain::readwise::{LinkKey, LinkState};

use super::super::plan_note::BookPlan;
use super::super::run_types::{BookEvent, BookResult};
use super::super::types::{ReadwiseBook, SavedImages};
use super::super::writer::{Outcome, SkipReason, UpsertOptions, Writer};
use super::{Run, SCOPE, Written};
use crate::web::extract::utils::js::trim as js_trim;

impl Run<'_> {
    pub(super) fn write_book(
        &self,
        writer: &Writer<'_>,
        book: &ReadwiseBook,
        incremental: bool,
    ) -> Written {
        let title = book_title(book);
        let result = match self.plan_and_write(writer, book, incremental, &title) {
            Ok(Outcome::NeedsFull) => return Written::NeedsFull,
            Ok(outcome) => to_result(outcome),
            Err(reason) => {
                // The writer reports its own failures. This catches the planner and the link
                // bookkeeping: the cursor moves on without this book, so it goes on the list.
                tracing::warn!(
                    scope = SCOPE,
                    book_id = book.user_book_id,
                    "a Readwise book could not be processed: {reason}"
                );
                if let Err(error) = writer.state.add_retry(book.user_book_id, &reason) {
                    tracing::error!(
                        scope = SCOPE,
                        book_id = book.user_book_id,
                        "the Readwise retry list could not be updated: {error}"
                    );
                }
                BookResult::Failed(reason)
            }
        };
        Written::Event(BookEvent { title, result })
    }

    fn plan_and_write(
        &self,
        writer: &Writer<'_>,
        book: &ReadwiseBook,
        incremental: bool,
        title: &str,
    ) -> Result<Outcome, String> {
        let store = self.library.store();
        let id = book.user_book_id;
        let external = book.external_id.as_deref().filter(|id| !id.is_empty());
        // Before any skip: a deleted or category-off book still tells which Reader document it
        // covers (D11).
        if let Some(link) = store
            .link_for_book(id, external)
            .map_err(|e| e.to_string())?
        {
            store
                .complete_link(&link, id, external)
                .map_err(|e| e.to_string())?;
        }
        match writer.base.plan(book, &SavedImages::new())? {
            BookPlan::Skipped => {
                writer.state.remove_retry(id).map_err(|e| e.to_string())?;
                Ok(Outcome::Skipped {
                    reason: SkipReason::CategoryOff,
                    note_id: None,
                })
            }
            BookPlan::Deleted { .. } => {
                // D9: the note stays, and the book stops syncing.
                store
                    .mark_link_state(LinkKey::Book(id), LinkState::SourceDeleted)
                    .map_err(|e| e.to_string())?;
                writer.state.remove_retry(id).map_err(|e| e.to_string())?;
                Ok(Outcome::Skipped {
                    reason: SkipReason::SourceDeleted,
                    note_id: None,
                })
            }
            BookPlan::Note(plan) => {
                self.observer.writing(title);
                let options = UpsertOptions {
                    incremental,
                    ..UpsertOptions::default()
                };
                Ok(writer.upsert(book, &plan, options))
            }
        }
    }
}

fn to_result(outcome: Outcome) -> BookResult {
    match outcome {
        Outcome::Created(_) => BookResult::Created,
        Outcome::Updated(_) => BookResult::Updated,
        Outcome::Appended(_) => BookResult::Appended,
        Outcome::Unchanged(_) => BookResult::Unchanged,
        Outcome::Skipped {
            reason: SkipReason::CategoryOff,
            ..
        } => BookResult::CategoryOff,
        Outcome::Skipped { reason, .. } => BookResult::Skipped(reason),
        Outcome::Failed(reason) => BookResult::Failed(reason),
        Outcome::NeedsFull => BookResult::Unchanged,
    }
}

/// `bookTitle`.
pub(super) fn book_title(book: &ReadwiseBook) -> String {
    let title = [book.readable_title.as_deref(), book.title.as_deref()]
        .into_iter()
        .flatten()
        .find(|title| !title.is_empty())
        .unwrap_or("");
    match js_trim(title) {
        "" => "Untitled".to_owned(),
        title => title.to_owned(),
    }
}
