//! The run after its books (`sync-service.ts` `recordJournal` and step 4): the highlight index
//! and the journal days, then the Reader pass. A child of `engine`, so it reads the run's state.

use std::collections::HashSet;

use super::super::client::ReadwiseErrorKind;
use super::super::journal_sync::{
    FlushOptions, JournalSwitch, RecordOptions, flush_journal, record_highlights,
};
use super::super::options::ReadwiseOptions;
use super::super::reader_sync::{PassError, ReaderPass, run_reader_pass};
use super::super::run_types::{BookEvent, BookResult, failed};
use super::super::types::ReadwiseBook;
use super::{Run, SCOPE, Stop, is_stopped};

impl Run<'_> {
    /// Keeps the highlight index current and writes the journal days that got a new arrival
    /// (#3476, D17). A failing index write stops the run before the cursor moves, so the same
    /// window is read again and its arrivals are not lost. A journal write problem never fails
    /// the run: the days stay pending.
    pub(super) fn record_journal(
        &mut self,
        books: &[&ReadwiseBook],
        record: &RecordOptions,
    ) -> Result<(), Stop> {
        record_highlights(self.state, books, record).map_err(failed)?;
        if record.journal != JournalSwitch::On {
            return Ok(());
        }
        let retry: HashSet<i64> = (self.state.retry_list().map_err(failed)?)
            .iter()
            .map(|entry| entry.readwise_book_id)
            .collect();
        let options = FlushOptions {
            time_zone: record.time_zone,
            retry_book_ids: &retry,
        };
        let (signal, gate) = (&self.signal, self.engine.gate.as_ref());
        let claim_moved = &mut self.claim_moved;
        let mut stopped = || is_stopped(signal, gate, claim_moved);
        if let Err(error) = flush_journal(self.library, self.state, &options, &mut stopped) {
            tracing::warn!(
                scope = SCOPE,
                "the Readwise journal could not be written: {error}"
            );
        }
        Ok(())
    }

    /// Step 4: saved Reader documents without a v2 book (D11). `books` are the books this run
    /// read: a Reader document one of them covers is not written again.
    pub(super) fn reader_pass(
        &mut self,
        options: &ReadwiseOptions,
        books: &[&ReadwiseBook],
        started: i64,
    ) -> Result<(), Stop> {
        let links = self.library.store().links(None).map_err(failed)?;
        let mut covered: HashSet<String> = (links.into_iter())
            .filter_map(|link| link.reader_document_id)
            .collect();
        let external = books.iter().filter_map(|book| book.external_id.as_deref());
        covered.extend(external.filter(|id| !id.is_empty()).map(str::to_owned));
        let pass = ReaderPass {
            library: self.library,
            state: self.state,
            client: &self.engine.client,
            limiter: self.engine.reader_limiter.clone(),
            token: self.token,
            signal: &self.signal,
            started,
            root: &options.root_folder,
            folder_layout: options.folder_layout,
            book_external_ids: &covered,
        };
        let observer = self.observer;
        let (signal, gate) = (&self.signal, self.engine.gate.as_ref());
        let claim_moved = &mut self.claim_moved;
        let mut stopped = || is_stopped(signal, gate, claim_moved);
        let result = &mut self.result;
        let mut on_document = |event: BookEvent| {
            match event.result {
                BookResult::Failed(_) => result.counts.failed += 1,
                BookResult::Created => result.documents += 1,
                _ => {}
            }
            observer.book(&event);
        };
        let more = |count: usize| observer.more(count);
        match run_reader_pass(&pass, &mut stopped, &more, &mut on_document) {
            Ok(reader) if reader.cancelled => Err(Stop::Cancelled),
            Ok(_) => Ok(()),
            Err(PassError::Run(error)) => Err(Stop::Error(error)),
            Err(PassError::Readwise(error)) => {
                if error.kind() == Some(ReadwiseErrorKind::InvalidToken) {
                    // Parks the schedule and ends the run with the error.
                    self.readwise_failure(error)?;
                    return Ok(());
                }
                if self.signal.is_cancelled() || error.kind().is_none() {
                    return Err(Stop::Cancelled);
                }
                // Rate limit or network: the Reader cursor stays, and the next run lists again.
                tracing::warn!(
                    scope = SCOPE,
                    "the Reader documents could not be listed: {error}"
                );
                self.result.counts.failed += 1;
                let event = BookEvent {
                    title: "Reader".to_owned(),
                    result: BookResult::Failed(error.to_string()),
                };
                self.observer.book(&event);
                Ok(())
            }
        }
    }
}
