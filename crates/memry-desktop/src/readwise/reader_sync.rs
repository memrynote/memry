//! The Reader pass (`reader-sync.ts`, #1408 D11): saved documents that have no v2 book become
//! notes under `Reader/`, once. The cursor is Reader's own `updated_at`, kept apart from the v2
//! cursor, which follows highlights. It moves only when every document was handled, and a
//! document that already has a note is a no-op, so a crash or a failed document costs a re-read
//! and no duplicate.

use std::collections::HashSet;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use super::client::{ReadwiseClient, ReadwiseError};
use super::cursor::next_cursor;
use super::library::Library;
use super::limiter::RequestLimiter;
use super::reader_notes::{ReaderNoteOptions, ReaderOutcome, write_reader_note};
use super::run_state::RunState;
use super::run_types::{BookEvent, BookResult, RunError, failed};
use super::types::{FolderLayout, ReaderDocument};
use super::writer::SkipReason;
use crate::web::extract::utils::js::trim as js_trim;

const SCOPE: &str = "Readwise:ReaderPass";

/// What a pass needs (`ReaderPassInput`), the run's hooks apart.
pub struct ReaderPass<'a> {
    pub library: &'a Library,
    pub state: &'a RunState,
    pub client: &'a ReadwiseClient,
    pub limiter: Arc<RequestLimiter>,
    pub token: &'a str,
    pub signal: &'a CancellationToken,
    /// Epoch milliseconds the run started, on this device's clock.
    pub started: i64,
    pub root: &'a str,
    pub folder_layout: FolderLayout,
    /// Reader documents that already have a v2 book: their highlights live in its note.
    pub book_external_ids: &'a HashSet<String>,
}

/// `ReaderPassResult`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ReaderPassResult {
    pub cancelled: bool,
    pub created: u64,
    pub failed: u64,
}

/// Why a pass stopped early.
pub enum PassError {
    /// The list failed: rate limit, network, token. The cursor stays.
    Readwise(ReadwiseError),
    /// The cursor could not be stored.
    Run(RunError),
}

/// `eventOf`.
fn event_of(document: &ReaderDocument, outcome: &ReaderOutcome) -> BookEvent {
    let title = match js_trim(document.title.as_deref().unwrap_or_default()) {
        "" => "Untitled".to_owned(),
        title => title.to_owned(),
    };
    let result = match outcome {
        ReaderOutcome::Created(_) => BookResult::Created,
        ReaderOutcome::Unchanged(_) | ReaderOutcome::Skipped(SkipReason::HasBook) => {
            BookResult::Unchanged
        }
        ReaderOutcome::Skipped(reason) => BookResult::Skipped(reason.clone()),
        ReaderOutcome::Failed(reason) => BookResult::Failed(reason.clone()),
    };
    BookEvent { title, result }
}

/// `runReaderPass`. `stopped` is read before each document; `more` hears each page's size.
pub fn run_reader_pass(
    pass: &ReaderPass<'_>,
    stopped: &mut dyn FnMut() -> bool,
    more: &dyn Fn(usize),
    on_document: &mut dyn FnMut(BookEvent),
) -> Result<ReaderPassResult, PassError> {
    let previous = pass
        .state
        .reader_cursor()
        .map_err(|e| PassError::Run(failed(e)))?;
    let mut result = ReaderPassResult::default();
    let mut seen: Vec<Option<String>> = Vec::new();
    let options = ReaderNoteOptions {
        root: pass.root,
        folder_layout: pass.folder_layout,
        book_external_ids: pass.book_external_ids,
        restore: false,
    };
    // Departure: no `withHtmlContent` until the article text can be written (Step 32).
    let mut pages = (pass.client).reader_documents(
        pass.token,
        previous.as_deref(),
        false,
        pass.limiter.clone(),
    );
    while let Some(page) = (pass.library.runtime)
        .block_on(pages.next(pass.signal))
        .map_err(PassError::Readwise)?
    {
        more(page.len());
        for document in &page {
            if stopped() {
                result.cancelled = true;
                return Ok(result);
            }
            seen.push(document.updated_at.clone());
            let outcome = write_reader_note(pass.library, document, &options);
            match outcome {
                ReaderOutcome::Created(_) => result.created += 1,
                ReaderOutcome::Failed(_) => result.failed += 1,
                _ => {}
            }
            on_document(event_of(document, &outcome));
        }
    }
    if result.failed == 0 {
        let cursor = next_cursor(
            seen.iter().map(Option::as_deref),
            previous.as_deref(),
            pass.started,
        )
        .map_err(PassError::Run)?;
        (pass.state.set_reader_cursor(&cursor)).map_err(|e| PassError::Run(failed(e)))?;
    } else {
        tracing::warn!(
            scope = SCOPE,
            failed = result.failed,
            "some Reader documents failed; the next pass reads them again"
        );
    }
    Ok(result)
}
