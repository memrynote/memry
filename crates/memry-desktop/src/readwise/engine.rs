//! The Readwise run (`sync-service.ts` `run`, D7): the retry list by id, the export since the
//! cursor to learn which books changed, then the full books a render needs (new notes and
//! untouched sections). Touched sections take the export's payload. The cursor moves once, when
//! the run completes: a crash re-runs the same window and the writer's no-op rule makes that
//! free. A failing or busy book goes on the retry list and never stops the run. A cancelled
//! run writes nothing further and leaves the cursor where it was.
//!
//! Blocking: the run lives on a blocking thread, and reaches Readwise through the library's
//! runtime handle. The journal, the Reader pass and the status publish are stage 33d2; the
//! claim and the pull gate (33d3) plug in through [`RunGate`].

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use chrono_tz::Tz;
use tokio_util::sync::CancellationToken;

use super::client::{ReadwiseClient, ReadwiseError, ReadwiseErrorKind};
use super::highlights::is_live_highlight;
use super::library::Library;
use super::options::ReadwiseOptions;
use super::plan_note::{BookPlan, default_category_switch};
use super::run_state::{Attention, LastRun, RunCounts, RunState};
use super::text::parse_ms;
use super::types::{ReadwiseBook, ReadwiseCategory, SavedImages};
use super::writer::{Outcome, PlanBase, SkipReason, UpsertOptions, Writer};
use crate::vault::activity::{ActivityInput, ActivityKind, ActivitySource};
use crate::web::extract::utils::date::iso_string;
use crate::web::extract::utils::js::trim as js_trim;

const SCOPE: &str = "Readwise:Sync";

/// A run reads the whole export once a day: a book-level edit (a new `document_note`) does not
/// move `updatedAfter`. Untouched sections come out identical and cost no write (D5).
pub const FULL_READ_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;
/// A cursor with no highlight to anchor on starts this far before the run, for clock skew.
const EMPTY_LIBRARY_CURSOR_MARGIN_MS: i64 = 5 * 60 * 1000;

const CATEGORIES: [ReadwiseCategory; 5] = [
    ReadwiseCategory::Books,
    ReadwiseCategory::Articles,
    ReadwiseCategory::Tweets,
    ReadwiseCategory::Podcasts,
    ReadwiseCategory::Supplementals,
];

/// What happened to one book (`BookEvent`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BookResult {
    Created,
    Updated,
    Appended,
    Unchanged,
    Skipped(SkipReason),
    CategoryOff,
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookEvent {
    pub title: String,
    pub result: BookResult,
}

/// `RunObserver` without its signal: the run's progress for the import dialog and the
/// settings panel.
pub trait RunObserver {
    /// `total` books will be looked at.
    fn planned(&self, _total: usize) {}
    /// A book is about to be written.
    fn writing(&self, _title: &str) {}
    /// A book is done.
    fn book(&self, _event: &BookEvent) {}
    /// The import runner writes its own summary, so it answers false.
    fn log_activity(&self) -> bool {
        true
    }
}

/// An observer that hears nothing.
pub struct Unobserved;
impl RunObserver for Unobserved {}

/// The claim and the pull gate (D8, stage 33d3).
pub trait RunGate: Send + Sync {
    /// Returns once this device may pull: sync completed a pull and the vault is indexed.
    fn await_ready(&self, _cancel: &CancellationToken) -> Result<(), RunError> {
        Ok(())
    }
    /// Read before each book: true once another device holds the claim.
    fn claim_lost(&self) -> bool {
        false
    }
    /// The run stopped because the claim moved.
    fn on_claim_lost(&self) {}
}

/// No gate: every run may pull.
pub struct Ungated;
impl RunGate for Ungated {}

/// `RunResult`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunResult {
    pub cancelled: bool,
    /// Another device took Readwise over, so the run stopped at the next book (D8).
    pub claim_lost: bool,
    pub counts: RunCounts,
}

#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error("A Readwise run is already in progress")]
    AlreadyRunning,
    #[error(transparent)]
    Readwise(#[from] ReadwiseError),
    #[error("{0}")]
    Failed(String),
}

fn failed(error: impl std::fmt::Display) -> RunError {
    RunError::Failed(error.to_string())
}

/// `Intl.DateTimeFormat().resolvedOptions().timeZone`. An unknown zone fails the run, as
/// `Intl` throws `RangeError`, rather than write days in another zone.
pub fn system_time_zone() -> Result<Tz, String> {
    let name = iana_time_zone::get_timezone().map_err(|error| error.to_string())?;
    name.parse::<Tz>()
        .map_err(|_| format!("Unknown time zone {name}"))
}

/// The process's run engine. Runs never overlap.
pub struct Engine {
    client: ReadwiseClient,
    gate: Arc<dyn RunGate>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    time_zone: Arc<dyn Fn() -> Result<Tz, String> + Send + Sync>,
    running: AtomicBool,
    stop: Mutex<Option<CancellationToken>>,
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
            gate,
            clock,
            time_zone,
            running: AtomicBool::new(false),
            stop: Mutex::new(None),
        }
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
        let signal = cancel.child_token();
        *self.stop.lock().unwrap_or_else(|e| e.into_inner()) = Some(signal.clone());
        let mut run = Run {
            engine: self,
            library,
            token,
            observer,
            signal,
            state: RunState::new(library.store()),
            result: RunResult::default(),
            claim_moved: false,
        };
        let outcome = run.go();
        let (result, claim_moved) = (run.result.clone(), run.claim_moved);
        *self.stop.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.running.store(false, Ordering::SeqCst);
        if claim_moved {
            self.gate.on_claim_lost();
        }
        // Also for a cancelled or failed run: the notes it wrote did change.
        let changed = result.counts.added + result.counts.updated + result.counts.appended;
        if changed > 0 && observer.log_activity() {
            record_activity(library, changed, &result.counts);
        }
        outcome
    }
}

fn record_activity(library: &Library, changed: u64, counts: &RunCounts) {
    let plural = |count: u64, noun: &str| match count {
        1 => format!("{count} {noun}"),
        _ => format!("{count} {noun}s"),
    };
    let mut input = ActivityInput::new(ActivityKind::Import, ActivitySource::Import);
    input.importer = Some("readwise".to_owned());
    input.message = Some(format!(
        "Readwise: {}, {}",
        plural(changed, "book"),
        plural(counts.highlights, "highlight")
    ));
    input.counts = Some(vec![
        ("imported".to_owned(), changed),
        ("failed".to_owned(), counts.failed),
    ]);
    library.activity.record(&library.open.path, input);
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
    state: RunState,
    result: RunResult,
    claim_moved: bool,
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
        if self.signal.is_cancelled() {
            return true;
        }
        if self.engine.gate.claim_lost() {
            self.claim_moved = true;
            return true;
        }
        false
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
        let full = cursor.is_none()
            || self.state.full_pass_pending().map_err(failed)?
            || last_full.is_none_or(|at| {
                // A clock set back leaves a time in the future: read, rather than wait for it.
                started - at >= FULL_READ_INTERVAL_MS || at > started
            });
        if cursor.is_none()
            && let Err(error) = self.library.rebuild_links()
        {
            // The writer also finds a book's note by `readwise_url`: no duplicate follows.
            tracing::warn!(scope = SCOPE, "could not rebuild the Readwise links: {error}");
        }

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
                tracing::warn!(scope = SCOPE, "the Readwise retry list could not be fetched: {error}");
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

        let writer = Writer {
            library: self.library,
            state: &self.state,
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
        if !need_full.is_empty() {
            let mut payloads: HashMap<i64, &ReadwiseBook> =
                need_full.iter().map(|book| (book.user_book_id, *book)).collect();
            let ids: Vec<i64> = need_full.iter().map(|book| book.user_book_id).collect();
            let full_books = match self.read_books(&ids) {
                Ok(books) => books,
                Err(error) => {
                    let error = self.readwise_failure(error)?;
                    // Rate limit or network: each book is asked for again next run.
                    let reason = error.to_string();
                    for book in &need_full {
                        self.state.add_retry(book.user_book_id, &reason).map_err(failed)?;
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
            gone.sort_by_key(|book| book.user_book_id);
            for book in gone {
                // Missing from `ids=` after the export named it: the next run's retry fetch
                // drops it if it is gone, and reads it again if this was a hiccup.
                self.state
                    .add_retry(book.user_book_id, "Missing from the full fetch")
                    .map_err(failed)?;
                tracing::info!(scope = SCOPE, book_id = book.user_book_id, "a Readwise book vanished between the export and its full fetch");
                let event = BookEvent {
                    title: book_title(book),
                    result: BookResult::Unchanged,
                };
                self.finish(Written::Event(event), book);
            }
        }

        self.state
            .set_cursor(&next_cursor(&exported, cursor.as_deref(), started)?)
            .map_err(failed)?;
        if full {
            self.state.set_last_full_read(&iso(started)?).map_err(failed)?;
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

    fn write_book(&self, writer: &Writer<'_>, book: &ReadwiseBook, incremental: bool) -> Written {
        let title = book_title(book);
        let result = match self.plan_and_write(writer, book, incremental, &title) {
            Ok(Outcome::NeedsFull) => return Written::NeedsFull,
            Ok(outcome) => to_result(outcome),
            Err(reason) => {
                // The writer reports its own failures. This catches the planner and the link
                // bookkeeping: the cursor moves on without this book, so it goes on the list.
                tracing::warn!(scope = SCOPE, book_id = book.user_book_id, "a Readwise book could not be processed: {reason}");
                if let Err(error) = writer.state.add_retry(book.user_book_id, &reason) {
                    tracing::error!(scope = SCOPE, book_id = book.user_book_id, "the Readwise retry list could not be updated: {error}");
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
        if let Some(link) = store.link_for_book(id, external).map_err(|e| e.to_string())? {
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
                    .mark_link_state(
                        memry_core::domain::readwise::LinkKey::Book(id),
                        memry_core::domain::readwise::LinkState::SourceDeleted,
                    )
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
pub fn book_title(book: &ReadwiseBook) -> String {
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

fn iso(ms: i64) -> Result<String, RunError> {
    iso_string(Some(ms as f64)).map_err(failed)
}

/// `nextCursor`: the newest highlight `updated_at` the export held, minus one second, in
/// Readwise's time. Never moves back, and stays put when the export held no highlight.
fn next_cursor(
    books: &[ReadwiseBook],
    previous: Option<&str>,
    started: i64,
) -> Result<String, RunError> {
    let newest = books
        .iter()
        .flat_map(|book| book.highlights.iter().flatten())
        .filter_map(|highlight| parse_ms(highlight.updated_at.as_deref()))
        .fold(f64::NEG_INFINITY, f64::max);
    let kept = parse_ms(previous);
    let at = match (newest.is_finite(), kept) {
        (false, Some(kept)) => kept,
        (false, None) => (started - EMPTY_LIBRARY_CURSOR_MARGIN_MS) as f64,
        (true, Some(kept)) => kept.max(newest - 1000.0),
        (true, None) => newest - 1000.0,
    };
    iso_string(Some(at)).map_err(failed)
}
