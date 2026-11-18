//! The Readwise run (`sync-service.ts` `run`, D7): the retry list by id, the export since the
//! cursor to learn which books changed, then the full books a render needs (new notes and
//! untouched sections). Touched sections take the export's payload. The cursor moves once, when
//! the run completes: a crash re-runs the same window and the writer's no-op rule makes that
//! free. A failing or busy book goes on the retry list and never stops the run. A cancelled
//! run writes nothing further and leaves the cursor where it was.
//!
//! After the books: the highlight index and the journal days (`journal_sync`), the cursor, then
//! the Reader pass (`reader_sync`). The end of a run (`run_end`) publishes the status and writes
//! the activity line.
//!
//! Blocking: the run lives on a blocking thread, and reaches Readwise through the library's
//! runtime handle. The claim and the pull gate (33d3) plug in through [`RunGate`] (`run_types`).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use chrono_tz::Tz;
use tokio_util::sync::CancellationToken;

use super::client::{ReadwiseClient, ReadwiseError, ReadwiseErrorKind};
use super::cursor::{iso, next_cursor};
use super::highlights::is_live_highlight;
use super::journal_sync::{RecordOptions, journal_switch};
use super::library::Library;
use super::limiter::RequestLimiter;
use super::options::ReadwiseOptions;
use super::plan_note::default_category_switch;
use super::run_end::{Running, end_run};
use super::run_state::{Attention, LastRun, RunState};
use super::run_status::{RunProgress, RunStatus, Stage};
use super::run_types::{BookEvent, BookResult, RunError, RunGate, RunObserver, RunResult, failed};
use super::text::parse_ms;
use super::types::{ReadwiseBook, ReadwiseCategory};
use super::writer::{PlanBase, SkipReason, Writer};

const SCOPE: &str = "Readwise:Sync";

#[path = "engine_after.rs"]
mod after;
#[path = "engine_book.rs"]
mod book;

use book::book_title;

/// A run reads the whole export once a day: a book-level edit (a new `document_note`) does not
/// move `updatedAfter`. Untouched sections come out identical and cost no write (D5).
pub const FULL_READ_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;

const CATEGORIES: [ReadwiseCategory; 5] = [
    ReadwiseCategory::Books,
    ReadwiseCategory::Articles,
    ReadwiseCategory::Tweets,
    ReadwiseCategory::Podcasts,
    ReadwiseCategory::Supplementals,
];

/// The process's run engine. Runs never overlap.
pub struct Engine {
    client: ReadwiseClient,
    reader_limiter: Arc<RequestLimiter>,
    gate: Arc<dyn RunGate>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    time_zone: Arc<dyn Fn() -> Result<Tz, String> + Send + Sync>,
    pub(super) running: AtomicBool,
    pub(super) stop: Mutex<Option<CancellationToken>>,
    status: RunStatus,
}

impl Engine {
    pub fn new(
        client: ReadwiseClient,
        gate: Arc<dyn RunGate>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
        time_zone: Arc<dyn Fn() -> Result<Tz, String> + Send + Sync>,
    ) -> Self {
        Self {
            client,
            reader_limiter: RequestLimiter::reader(),
            gate,
            status: RunStatus::new(Arc::clone(&clock)),
            clock,
            time_zone,
            running: AtomicBool::new(false),
            stop: Mutex::new(None),
        }
    }

    /// The Reader request budget; Reader's own (20 a minute) unless a test lifts it.
    pub fn with_reader_limiter(mut self, limiter: Arc<RequestLimiter>) -> Self {
        self.reader_limiter = limiter;
        self
    }

    /// The run in progress and the last failure, for the status IPC.
    pub fn status(&self) -> &RunStatus {
        &self.status
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Stops the run in progress at its next book, whoever started it. A no-op when idle.
    pub fn cancel(&self) {
        if let Some(stop) = self.stop.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            stop.cancel();
        }
    }

    /// One run. `cancel` is the caller's (vault close, shutdown); [`Self::cancel`] also stops it.
    pub fn run(
        &self,
        library: &Library,
        token: &str,
        observer: &dyn RunObserver,
        cancel: &CancellationToken,
    ) -> Result<RunResult, RunError> {
        if self.running.swap(true, Ordering::SeqCst) {
            return Err(RunError::AlreadyRunning);
        }
        // Resets `running`, the stop token and the progress however the run ends, a panic too.
        let _running = Running(self);
        let signal = cancel.child_token();
        *self.stop.lock().unwrap_or_else(|e| e.into_inner()) = Some(signal.clone());
        self.status
            .set_progress(Some(progress(Stage::WaitingForSync, None, 0)), false);
        let state = RunState::new(library.store());
        let mut run = Run {
            engine: self,
            library,
            token,
            observer,
            signal,
            state: &state,
            result: RunResult::default(),
            claim_moved: false,
            done: 0,
        };
        let outcome = run.go();
        let (result, claim_moved) = (run.result.clone(), run.claim_moved);
        match &outcome {
            Err(error) => self.status.record_failure(error),
            Ok(result) if !result.cancelled => self.status.clear_failure(),
            Ok(_) => {}
        }
        if claim_moved {
            self.gate.on_claim_lost();
        }
        end_run(
            library,
            &state,
            observer,
            &result,
            claim_moved,
            (self.clock)(),
        );
        outcome
    }
}

fn progress(stage: Stage, planned: Option<u64>, done: u64) -> RunProgress {
    RunProgress {
        stage,
        planned,
        done,
    }
}

/// [`Run::stopped`] over the fields it reads, for a closure beside another borrow of the run.
fn is_stopped(signal: &CancellationToken, gate: &dyn RunGate, claim_moved: &mut bool) -> bool {
    if signal.is_cancelled() {
        return true;
    }
    if gate.claim_lost() {
        *claim_moved = true;
        return true;
    }
    false
}

/// `!error` means stop the run with it; `None` means cancelled.
enum Stop {
    Cancelled,
    Error(RunError),
}

impl From<RunError> for Stop {
    fn from(error: RunError) -> Self {
        Self::Error(error)
    }
}

/// A written book, or one that needs its full highlight list.
enum Written {
    Event(BookEvent),
    NeedsFull,
}

struct Run<'a> {
    engine: &'a Engine,
    library: &'a Library,
    token: &'a str,
    observer: &'a dyn RunObserver,
    signal: CancellationToken,
    state: &'a RunState,
    result: RunResult,
    claim_moved: bool,
    /// Books done, for the progress.
    done: u64,
}

impl Run<'_> {
    fn go(&mut self) -> Result<RunResult, RunError> {
        match self.pass() {
            Ok(()) => Ok(self.result.clone()),
            Err(Stop::Cancelled) => {
                self.result.cancelled = true;
                self.result.claim_lost = self.claim_moved;
                Ok(self.result.clone())
            }
            Err(Stop::Error(error)) => Err(error),
        }
    }

    /// Re-read before each book: cancelled, or another device holds the claim now (D8).
    fn stopped(&mut self) -> bool {
        is_stopped(
            &self.signal,
            self.engine.gate.as_ref(),
            &mut self.claim_moved,
        )
    }

    fn check(&mut self) -> Result<(), Stop> {
        match self.stopped() {
            true => Err(Stop::Cancelled),
            false => Ok(()),
        }
    }

    /// A Readwise failure: cancelled, or an error the user must fix parks the schedule and keeps
    /// the last run's counts. `Some` for an error to give up on now.
    fn readwise_failure(&self, error: ReadwiseError) -> Result<ReadwiseError, Stop> {
        if self.signal.is_cancelled() || error.kind().is_none() {
            return Err(Stop::Cancelled);
        }
        let attention = match error.kind() {
            Some(ReadwiseErrorKind::InvalidToken) => Some(Attention::InvalidToken),
            Some(ReadwiseErrorKind::SubscriptionExpired) => Some(Attention::SubscriptionExpired),
            _ => None,
        };
        let Some(attention) = attention else {
            return Ok(error);
        };
        let previous = self.state.last_run().map_err(failed)?;
        let parked = LastRun {
            at: iso((self.engine.clock)())?,
            needs_attention: true,
            attention: Some(attention),
            counts: previous.and_then(|run| run.counts),
        };
        self.state.set_last_run(&parked).map_err(failed)?;
        Err(Stop::Error(error.into()))
    }

    fn read_books(&self, ids: &[i64]) -> Result<Vec<ReadwiseBook>, ReadwiseError> {
        let mut books = Vec::new();
        if ids.is_empty() {
            return Ok(books);
        }
        let mut pages = self.engine.client.export_books(self.token, ids);
        while let Some(page) = self.library.runtime.block_on(pages.next(&self.signal))? {
            books.extend(page);
        }
        Ok(books)
    }

    fn pass(&mut self) -> Result<(), Stop> {
        self.engine.gate.await_ready(&self.signal)?;
        let store = self.library.store();
        let started = (self.engine.clock)();
        let options = ReadwiseOptions::from_group(&store.settings_group().map_err(failed)?);
        let base = PlanBase {
            root: options.root_folder.clone(),
            folder_layout: options.folder_layout,
            categories: options.categories,
            time_zone: (self.engine.time_zone)().map_err(RunError::Failed)?,
        };
        let cursor = self.state.cursor().map_err(failed)?;
        let last_full = self.state.last_full_read().map_err(failed)?;
        let last_full = parse_ms(last_full.as_deref()).map(|ms| ms as i64);
        let full_pending = self.state.full_pass_pending().map_err(failed)?;
        // The highlight index (#3476) is filled by a full export. Until then, and on the first
        // import, a takeover's first run and a category full pass, the run only fills it: no
        // highlight counts as a new arrival (D17, no backfill).
        let index_ready = self.state.highlight_index_ready().map_err(failed)?;
        let count_arrivals = cursor.is_some() && index_ready && !full_pending;
        let journal = journal_switch(self.library, options.journal_highlights);
        let full = cursor.is_none()
            || !index_ready
            || full_pending
            || last_full.is_none_or(|at| {
                // A clock set back leaves a time in the future: read, rather than wait for it.
                started - at >= FULL_READ_INTERVAL_MS || at > started
            });
        if cursor.is_none()
            && let Err(error) = self.library.rebuild_links()
        {
            // The writer also finds a book's note by `readwise_url`: no duplicate follows.
            tracing::warn!(
                scope = SCOPE,
                "could not rebuild the Readwise links: {error}"
            );
        }

        (self.engine.status).set_progress(Some(progress(Stage::Reading, None, 0)), false);
        // 1. The retry list, as full books.
        let retry_ids: Vec<i64> = (self.state.retry_list().map_err(failed)?)
            .iter()
            .map(|entry| entry.readwise_book_id)
            .collect();
        let (retry_books, retry_fetched) = match self.read_books(&retry_ids) {
            Ok(books) => (books, true),
            Err(error) => {
                let error = self.readwise_failure(error)?;
                // The books stay on the list for the next run.
                tracing::warn!(
                    scope = SCOPE,
                    "the Readwise retry list could not be fetched: {error}"
                );
                (Vec::new(), false)
            }
        };
        let fetched: HashSet<i64> = retry_books.iter().map(|b| b.user_book_id).collect();

        // 2. What changed.
        let after = (!full).then_some(cursor.as_deref()).flatten();
        let mut pages = self.engine.client.export_pages(self.token, after, true);
        let mut exported: Vec<ReadwiseBook> = Vec::new();
        loop {
            match self.library.runtime.block_on(pages.next(&self.signal)) {
                Ok(Some(page)) => exported.extend(page),
                Ok(None) => break,
                Err(error) => {
                    let error = self.readwise_failure(error)?;
                    return Err(Stop::Error(error.into()));
                }
            }
        }
        let exported_ids: HashSet<i64> = exported.iter().map(|b| b.user_book_id).collect();
        if retry_fetched {
            // `ids=` answered without the book and the export does not name it: it is gone
            // from Readwise, and asking again would never end.
            for id in &retry_ids {
                if !fetched.contains(id) && !exported_ids.contains(id) {
                    self.state.remove_retry(*id).map_err(failed)?;
                }
            }
        }
        let changed: Vec<&ReadwiseBook> = exported
            .iter()
            .filter(|book| !fetched.contains(&book.user_book_id))
            .collect();
        let total = retry_books.len() + changed.len();
        self.result.counts.books = total as u64;
        self.observer.planned(total);
        let writing = progress(Stage::Writing, Some(total as u64), 0);
        self.engine.status.set_progress(Some(writing), false);

        let writer = Writer {
            library: self.library,
            state: self.state,
            base: &base,
        };
        for book in &retry_books {
            self.check()?;
            let written = self.write_book(&writer, book, false);
            self.finish(written, book);
        }
        let mut need_full: Vec<&ReadwiseBook> = Vec::new();
        for book in changed {
            self.check()?;
            match self.write_book(&writer, book, !full) {
                Written::NeedsFull => need_full.push(book),
                written => self.finish(written, book),
            }
        }

        // 3. The full books a render needs.
        let mut full_fetched: Vec<ReadwiseBook> = Vec::new();
        if !need_full.is_empty() {
            let mut payloads: HashMap<i64, &ReadwiseBook> = need_full
                .iter()
                .map(|book| (book.user_book_id, *book))
                .collect();
            let ids: Vec<i64> = need_full.iter().map(|book| book.user_book_id).collect();
            let full_books = match self.read_books(&ids) {
                Ok(books) => books,
                Err(error) => {
                    let error = self.readwise_failure(error)?;
                    // Rate limit or network: each book is asked for again next run.
                    let reason = error.to_string();
                    for book in &need_full {
                        self.state
                            .add_retry(book.user_book_id, &reason)
                            .map_err(failed)?;
                        let event = BookEvent {
                            title: book_title(book),
                            result: BookResult::Failed(reason.clone()),
                        };
                        self.finish(Written::Event(event), book);
                    }
                    payloads.clear();
                    Vec::new()
                }
            };
            for full_book in &full_books {
                self.check()?;
                let Some(payload) = payloads.remove(&full_book.user_book_id) else {
                    continue;
                };
                let written = self.write_book(&writer, full_book, false);
                self.finish(written, payload);
            }
            let mut gone: Vec<&ReadwiseBook> = payloads.into_values().collect();
            full_fetched = full_books;
            gone.sort_by_key(|book| book.user_book_id);
            for book in gone {
                // Missing from `ids=` after the export named it: the next run's retry fetch
                // drops it if it is gone, and reads it again if this was a hiccup.
                self.state
                    .add_retry(book.user_book_id, "Missing from the full fetch")
                    .map_err(failed)?;
                tracing::info!(
                    scope = SCOPE,
                    book_id = book.user_book_id,
                    "a Readwise book vanished between the export and its full fetch"
                );
                let event = BookEvent {
                    title: book_title(book),
                    result: BookResult::Unchanged,
                };
                self.finish(Written::Event(event), book);
            }
        }

        // Later books win: a full fetch overrides the export's partial payload.
        let seen: Vec<&ReadwiseBook> = (exported.iter())
            .chain(&retry_books)
            .chain(&full_fetched)
            .collect();
        let record = RecordOptions {
            rebuild: full,
            count_arrivals,
            journal,
            time_zone: base.time_zone,
        };
        self.record_journal(&seen, &record)?;
        let times = (exported.iter())
            .flat_map(|book| book.highlights.iter().flatten())
            .map(|highlight| highlight.updated_at.as_deref());
        self.state
            .set_cursor(&next_cursor(times, cursor.as_deref(), started)?)
            .map_err(failed)?;
        // 4. Saved Reader documents, only when the user asked for them (D11). The v2 work is
        // done and its cursor kept, so a Reader failure never undoes it.
        if options.reader_documents {
            let books: Vec<&ReadwiseBook> = retry_books.iter().chain(&exported).collect();
            self.reader_pass(&options, &books, started)?;
        }
        if full {
            self.state
                .set_last_full_read(&iso(started)?)
                .map_err(failed)?;
            // A category switched on while this run was reading keeps its flag.
            let now = ReadwiseOptions::from_group(&store.settings_group().map_err(failed)?);
            let on = |options: &ReadwiseOptions, category: ReadwiseCategory| {
                (options.categories.get(category)).unwrap_or(default_category_switch(category))
            };
            let gained = (now.reader_documents && !options.reader_documents)
                || CATEGORIES
                    .iter()
                    .any(|category| on(&now, *category) && !on(&options, *category));
            if !gained {
                self.state.set_full_pass_pending(false).map_err(failed)?;
            }
        }
        let last = LastRun {
            at: iso((self.engine.clock)())?,
            needs_attention: false,
            attention: None,
            counts: Some(self.result.counts),
        };
        self.state.set_last_run(&last).map_err(failed)?;
        Ok(())
    }

    fn finish(&mut self, written: Written, payload: &ReadwiseBook) {
        let Written::Event(event) = written else {
            return;
        };
        let counts = &mut self.result.counts;
        match &event.result {
            BookResult::Created => counts.added += 1,
            BookResult::Updated => counts.updated += 1,
            BookResult::Appended => counts.appended += 1,
            BookResult::Failed(_) => counts.failed += 1,
            BookResult::Skipped(SkipReason::Busy) => counts.deferred += 1,
            _ => {}
        }
        self.done += 1;
        let ticked = progress(Stage::Writing, Some(self.result.counts.books), self.done);
        self.engine.status.set_progress(Some(ticked), true);
        let counts = &mut self.result.counts;
        if matches!(
            event.result,
            BookResult::Created | BookResult::Updated | BookResult::Appended
        ) {
            let live = payload.highlights.iter().flatten();
            counts.highlights += live.filter(|h| is_live_highlight(h)).count() as u64;
        }
        self.observer.book(&event);
    }
}
