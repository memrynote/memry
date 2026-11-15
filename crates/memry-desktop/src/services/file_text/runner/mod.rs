//! Background text extraction for PDFs and images: filed ones, and the ones in a note's
//! attachments folder, whose text is searchable under that note. An HTML block's file in that
//! folder is read too, as one part of visible text. A port of Electron's
//! `apps/desktop/src/main/file-text/runner.ts`, on one thread.
//!
//! One loop, one file at a time, one page at a time. A PDF page with a text layer is read from
//! it; a page without one, and every image, goes through OCR. Every page is stored as it
//! finishes, and a job reads only the pages it has no row for, so a restart resumes where it
//! stopped. Each file's job lives in `file_text_jobs`:
//!
//! ```text
//!   (no job) or signature moved -> pending -> done
//!                                          -> failed (unopenable, missing, a link outside the
//!                                             vault, MAX_CONSECUTIVE_FAILURES pages in a row,
//!                                             or HTML over HTML_TEXT_MAX_BYTES)
//!   failed, or done with unreadable pages,
//!     under another app version or a day old -> pending again (unreadable pages only;
//!                                               never oversized HTML)
//!   OCR pages read without a language chosen
//!     since                                  -> pending again (OCR pages read again, their
//!                                               old text kept until then)
//!   attachment file gone -> job and text deleted
//!   note gone (no `note_files` row)          -> its jobs and text deleted
//! ```
//!
//! This loop is the only writer of `file_text_jobs` and `extracted_text`. Search and
//! embeddings pick the text up through `text_changed` (the service refreshes the note's search
//! row and publishes `NoteTextExtracted`).
//!
//! Differences from Electron: the index has no `note_cache`, so the note lists read
//! `note_files` in `data.db` and a pending job whose note is gone is dropped here (Electron's
//! join hid it); the first pass waits for the open's index build, which Electron ran before it
//! started the runner (`file-text/index.ts:17`).

mod extract;

use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, UNIX_EPOCH};

use memry_core::api::search::Search;
use memry_core::api::vault::Vault;
use memry_core::domain::file_text::ExtractedTextMethod;
use memry_core::domain::file_text::{FileTextJob, FileTextJobStatus, OWN_FILE, TextSource};

use super::PdfReader;
use crate::shell::file_open::Resolution;
use crate::vault::file_types::{FileType, extension, file_type_of_extension};
use crate::vault::note_file::read_note_lossy;
use crate::vault::paths::resolve_vault_file;

/// About 300 DPI for a Letter page, which is what Tesseract is tuned for.
pub const OCR_RENDER_MAX_EDGE: u32 = 3300;
pub const MAX_CONSECUTIVE_FAILURES: u32 = 3;
pub const ERROR_BACKOFF: Duration = Duration::from_secs(5);
pub const FILE_SETTLE: Duration = Duration::from_secs(1);
/// A failure may be a helper that could not start; give the file another go later.
pub const RETRY_FAILED_AFTER_MS: i64 = 24 * 60 * 60 * 1000;
/// Where a note's attachments live: `attachments/<noteId>/` (`vault/attachments.ts`).
pub use crate::vault::layout::ATTACHMENTS_DIR;
/// How often the first pass looks again while the open's index build runs.
const INDEX_POLL: Duration = Duration::from_secs(1);

pub type Recognize = Arc<dyn Fn(&[u8]) -> Result<String, String> + Send + Sync>;
pub type OcrLanguageCodes = Arc<dyn Fn() -> Vec<String> + Send + Sync>;
pub type TextChanged = Arc<dyn Fn(&str) + Send + Sync>;
pub type NowMs = Arc<dyn Fn() -> i64 + Send + Sync>;
pub type Indexing = Arc<dyn Fn() -> bool + Send + Sync>;

/// `FileTextDeps` (`runner.ts:84-96`), for one open vault.
pub struct RunnerDeps {
    pub vault_path: PathBuf,
    /// A job that failed under another version is read again.
    pub app_version: String,
    pub vault: Arc<Vault>,
    pub search: Arc<Search>,
    /// The image's text; an error leaves the part unreadable.
    pub recognize: Recognize,
    /// The Tesseract languages `recognize` reads with now (`eng`, `deu`, ...).
    pub ocr_languages: OcrLanguageCodes,
    pub pdf: Arc<dyn PdfReader>,
    pub text_changed: TextChanged,
    /// The clock of the 24 h retry.
    pub now_ms: NowMs,
    /// Whether the open's index build still runs.
    pub indexing: Indexing,
}

/// The kinds of file a job reads (`TextFileKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TextKind {
    Pdf,
    Image,
    Html,
}

/// A file to read, and the note its text is searchable under.
#[derive(Debug, Clone)]
struct TextFile {
    of: TextSource,
    path: String,
    kind: TextKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Signature {
    signature: String,
    size: u64,
}

const OUTSIDE_VAULT: &str = "outside-vault";

#[derive(Default)]
struct Wake {
    changed: BTreeSet<String>,
    rescan_all: bool,
    stopped: bool,
    /// Bumped by every `note_changed`, `languages_changed` and `stop`: what ends a timed sleep.
    pokes: u64,
}

pub struct FileTextRunner {
    deps: RunnerDeps,
    state: Mutex<Wake>,
    wake: Condvar,
    /// Files whose bytes a scan compared, and scans that ended, for the tests.
    compared: AtomicUsize,
    scans: AtomicUsize,
}

/// OCR text read without one of `languages`. `None` is a build that read English only.
fn misses_ocr_language(read_with: Option<&str>, languages: &[String]) -> bool {
    let read: Vec<&str> = read_with.unwrap_or("eng").split('+').collect();
    languages
        .iter()
        .any(|language| !read.contains(&language.as_str()))
}

/// Same bytes, same signature (`size:trunc(mtimeMs)`). A rename keeps it, so a moved file is
/// not read again.
fn file_signature(path: &Path) -> Option<Signature> {
    let stats = std::fs::metadata(path).ok()?;
    let modified = stats.modified().ok()?;
    let mtime_ms = match modified.duration_since(UNIX_EPOCH) {
        Ok(after) => i128::try_from(after.as_millis()).ok()?,
        Err(before) => -i128::try_from(before.duration().as_millis()).ok()?,
    };
    Some(Signature {
        signature: format!("{}:{mtime_ms}", stats.len()),
        size: stats.len(),
    })
}

/// Never parsed, and never retried while its bytes stay the same.
fn is_oversized_html(file: &TextFile, size: u64) -> bool {
    file.kind == TextKind::Html && size > super::html::HTML_TEXT_MAX_BYTES as u64
}

fn attachment_kind(name: &str) -> Option<TextKind> {
    let ext = extension(name);
    if ext == "html" || ext == "htm" {
        return Some(TextKind::Html);
    }
    match file_type_of_extension(&ext)? {
        FileType::Pdf => Some(TextKind::Pdf),
        FileType::Image => Some(TextKind::Image),
        _ => None,
    }
}

fn attachment(note_id: &str, name: &str) -> TextFile {
    TextFile {
        of: TextSource {
            note_id: note_id.to_owned(),
            source: name.to_owned(),
        },
        path: format!("{ATTACHMENTS_DIR}/{note_id}/{name}"),
        kind: attachment_kind(name).unwrap_or(TextKind::Image),
    }
}

/// The file a job reads: the note's own (`note_path`, `note_type`) or an attachment of it.
fn file_of(job: &FileTextJob, note_path: &str, note_type: &str) -> TextFile {
    if job.source != OWN_FILE {
        return attachment(&job.note_id, &job.source);
    }
    TextFile {
        of: TextSource {
            note_id: job.note_id.clone(),
            source: OWN_FILE.to_owned(),
        },
        path: note_path.to_owned(),
        kind: match note_type {
            "image" => TextKind::Image,
            "html" => TextKind::Html,
            _ => TextKind::Pdf,
        },
    }
}

fn text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

impl FileTextRunner {
    pub fn new(deps: RunnerDeps) -> Arc<Self> {
        Arc::new(Self {
            deps,
            state: Mutex::new(Wake {
                rescan_all: true,
                ..Wake::default()
            }),
            wake: Condvar::new(),
            compared: AtomicUsize::new(0),
            scans: AtomicUsize::new(0),
        })
    }

    pub fn start(self: &Arc<Self>) -> std::io::Result<JoinHandle<()>> {
        let runner = self.clone();
        std::thread::Builder::new()
            .name("file-text".into())
            .spawn(move || runner.run())
    }

    /// A note was indexed: a filed file that may have new bytes, or a note whose attachments
    /// may have changed. Compare its files again.
    pub fn note_changed(&self, note_id: &str) {
        self.poke(|state| {
            state.changed.insert(note_id.to_owned());
        });
    }

    /// The OCR languages changed, or a pass is owed for every note: compare every file again.
    pub fn rescan_all(&self) {
        self.poke(|state| state.rescan_all = true);
    }

    /// Ends the loop and fails the worker calls in flight. The page in progress is read again
    /// next time. The caller joins the thread.
    pub fn stop(&self) {
        self.poke(|state| state.stopped = true);
        self.deps.pdf.release();
    }

    /// The files the scans so far compared with their jobs.
    #[doc(hidden)]
    pub fn compared_files(&self) -> usize {
        self.compared.load(Ordering::SeqCst)
    }

    /// The scans that ended, failed ones included.
    #[doc(hidden)]
    pub fn scans(&self) -> usize {
        self.scans.load(Ordering::SeqCst)
    }

    fn lock(&self) -> MutexGuard<'_, Wake> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn poke(&self, change: impl FnOnce(&mut Wake)) {
        let mut state = self.lock();
        change(&mut state);
        state.pokes += 1;
        self.wake.notify_all();
    }

    fn stopped(&self) -> bool {
        self.lock().stopped
    }

    fn run(&self) {
        if !self.wait_for_index() {
            return;
        }
        while !self.stopped() {
            match self.pass() {
                Ok(true) => {}
                Ok(false) => self.sleep_idle(),
                Err(error) => {
                    if self.stopped() {
                        return;
                    }
                    tracing::warn!(scope = "FileText", %error, "Text extraction pass failed");
                    self.sleep(ERROR_BACKOFF);
                }
            }
        }
    }

    /// The open's index build fills `note_files`; the first scan reads it once it is done.
    /// `indexing` is read with the lock released: the index reports under its own lock.
    fn wait_for_index(&self) -> bool {
        loop {
            if self.stopped() {
                return false;
            }
            if !(self.deps.indexing)() {
                return true;
            }
            self.sleep(INDEX_POLL);
        }
    }

    /// Until a change, a rescan or a stop is owed.
    fn sleep_idle(&self) {
        let state = self.lock();
        drop(
            self.wake
                .wait_while(state, |s| {
                    !s.stopped && s.changed.is_empty() && !s.rescan_all
                })
                .unwrap_or_else(PoisonError::into_inner),
        );
    }

    /// `for`, or until the next poke.
    fn sleep(&self, time: Duration) {
        let state = self.lock();
        let pokes = state.pokes;
        drop(
            self.wake
                .wait_timeout_while(state, time, |s| !s.stopped && s.pokes == pokes)
                .unwrap_or_else(PoisonError::into_inner),
        );
    }

    /// One turn of the loop: the owed comparisons, then one pending job. `false` when nothing
    /// was pending.
    fn pass(&self) -> Result<bool, String> {
        self.queue_changed_files()?;
        let Some(job) = self.deps.search.next_pending_file_text().map_err(text)? else {
            return Ok(false);
        };
        match self
            .deps
            .vault
            .note_files()
            .by_id(&job.note_id)
            .map_err(text)?
        {
            // Electron's join to `note_cache` hid the jobs of a gone note (REVIEW-4618). The
            // note has no search row to refresh.
            None => self
                .deps
                .search
                .delete_notes_file_text(vec![job.note_id.clone()])
                .map_err(text)?,
            Some(note) => self.extract(&file_of(&job, &note.path, &note.file_type), &job)?,
        }
        Ok(true)
    }

    /// Take the pending changes and compare their files. A pass that fails hands its notes
    /// back, so the next pass compares them again.
    fn queue_changed_files(&self) -> Result<(), String> {
        let ids = {
            let mut state = self.lock();
            if !state.rescan_all && state.changed.is_empty() {
                return Ok(());
            }
            let ids = (!state.rescan_all).then(|| std::mem::take(&mut state.changed));
            state.rescan_all = false;
            state.changed.clear();
            ids
        };
        let listed: Option<Vec<String>> = ids.as_ref().map(|ids| ids.iter().cloned().collect());
        let outcome = self.queue_files(listed.as_deref());
        self.scans.fetch_add(1, Ordering::SeqCst);
        if outcome.is_err() {
            let mut state = self.lock();
            match ids {
                Some(ids) => state.changed.extend(ids),
                None => state.rescan_all = true,
            }
        }
        outcome
    }

    /// PDFs, images and HTML files in the attachments folders of the given notes, or of every
    /// note, that the note's body still embeds, and the notes whose body could not be read:
    /// their stored text is left alone.
    fn attachment_files(
        &self,
        ids: Option<&[String]>,
    ) -> Result<(Vec<TextFile>, HashSet<String>), String> {
        let root = self.deps.vault_path.join(ATTACHMENTS_DIR);
        let folders: Vec<String> = match ids {
            Some(ids) => ids.to_vec(),
            None => std::fs::read_dir(&root)
                .map(|entries| {
                    entries
                        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
                        .collect()
                })
                .unwrap_or_default(),
        };
        let mut files = Vec::new();
        let mut unread = HashSet::new();
        let notes = self
            .deps
            .vault
            .note_files()
            .markdown_notes(folders)
            .map_err(text)?;
        for (note_id, note_path) in notes {
            let candidates: Vec<String> = std::fs::read_dir(root.join(&note_id))
                .map(|entries| {
                    entries
                        .filter_map(Result::ok)
                        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
                        .filter_map(|entry| entry.file_name().into_string().ok())
                        .filter(|name| !name.starts_with('.') && attachment_kind(name).is_some())
                        .collect()
                })
                .unwrap_or_default();
            if candidates.is_empty() {
                continue;
            }
            let body = match read_note_lossy(&self.deps.vault_path, &note_path) {
                Ok(Some(note)) => note.raw,
                Ok(None) => {
                    unread.insert(note_id);
                    continue;
                }
                Err(error) => {
                    tracing::warn!(scope = "FileText", note_id, %error, "Could not read a note body to match its attachments");
                    unread.insert(note_id);
                    continue;
                }
            };
            for name in candidates {
                // Every link shape a note uses for its attachments contains this run
                // (`vault/attachment-reference-scan.ts`).
                if body.contains(&format!("{ATTACHMENTS_DIR}/{note_id}/{name}")) {
                    files.push(attachment(&note_id, &name));
                }
            }
        }
        Ok((files, unread))
    }

    /// Queue every file of the given notes, or of every note, whose bytes differ from the ones
    /// its stored text came from, and forget attachments the note no longer has.
    fn queue_files(&self, ids: Option<&[String]>) -> Result<(), String> {
        let search = &self.deps.search;
        let filed = self
            .deps
            .vault
            .note_files()
            .filed_text_files(ids.map(<[String]>::to_vec))
            .map_err(text)?;
        let (attachments, unread) = self.attachment_files(ids)?;
        if self.stopped() {
            return Ok(());
        }

        let kept: HashSet<&TextSource> = attachments.iter().map(|file| &file.of).collect();
        for job in search
            .attachment_text_jobs(ids.map(<[String]>::to_vec))
            .map_err(text)?
        {
            if unread.contains(&job.note_id) || kept.contains(&job) {
                continue;
            }
            let note_id = job.note_id.clone();
            search.delete_text_source(job).map_err(text)?;
            (self.deps.text_changed)(&note_id);
        }

        let filed = filed.into_iter().map(|file| TextFile {
            of: TextSource {
                note_id: file.note_id,
                source: OWN_FILE.to_owned(),
            },
            path: file.path,
            kind: if file.file_type == "image" {
                TextKind::Image
            } else {
                TextKind::Pdf
            },
        });
        for file in filed.chain(attachments.iter().cloned()) {
            if self.stopped() {
                return Ok(());
            }
            self.compared.fetch_add(1, Ordering::SeqCst);
            let Some(current) = self.current_signature(&file)? else {
                continue;
            };
            let job = search.file_text_job(file.of.clone()).map_err(text)?;
            if let Some(job) = job
                .as_ref()
                .filter(|job| job.signature == current.signature)
            {
                if is_oversized_html(&file, current.size) {
                    continue;
                }
                if self.is_due_for_retry(job, &file)? {
                    search
                        .retry_file_text(file.of.clone(), self.deps.app_version.clone())
                        .map_err(text)?;
                } else if self.is_missing_ocr_language(job, &file)? {
                    search.requeue_file_text(file.of.clone()).map_err(text)?;
                }
                continue;
            }
            search
                .reset_file_text(
                    file.of.clone(),
                    current.signature,
                    self.deps.app_version.clone(),
                )
                .map_err(text)?;
            if job.is_some() {
                (self.deps.text_changed)(&file.of.note_id);
            }
        }
        Ok(())
    }

    /// A link outside the vault gets a signature of its own, so text an older build read from
    /// it is dropped and `extract` fails the job.
    fn current_signature(&self, file: &TextFile) -> Result<Option<Signature>, String> {
        Ok(
            match resolve_vault_file(&self.deps.vault_path, &file.path).map_err(text)? {
                Resolution::Outside => Some(Signature {
                    signature: OUTSIDE_VAULT.to_owned(),
                    size: 0,
                }),
                Resolution::Inside(path) => file_signature(&path),
                Resolution::Missing => None,
            },
        )
    }

    /// A failed job, or a finished one with parts it could not read, under another app version
    /// or a day after it last ran. An `updated_at` that does not parse is never a day old, as
    /// `Date.parse` gives `NaN`.
    fn is_due_for_retry(&self, job: &FileTextJob, file: &TextFile) -> Result<bool, String> {
        if job.status == FileTextJobStatus::Pending {
            return Ok(false);
        }
        let aged = memry_core::storage::repositories::instants::to_epoch_ms(&job.updated_at)
            .is_some_and(|at| (self.deps.now_ms)() - at >= RETRY_FAILED_AFTER_MS);
        if job.app_version == self.deps.app_version && !aged {
            return Ok(false);
        }
        Ok(job.status == FileTextJobStatus::Failed
            || !self
                .parts(file, Some(ExtractedTextMethod::Unreadable))?
                .is_empty())
    }

    /// A done job with OCR text read before a language was chosen. A failed one waits for its
    /// retry.
    fn is_missing_ocr_language(&self, job: &FileTextJob, file: &TextFile) -> Result<bool, String> {
        Ok(job.status == FileTextJobStatus::Done
            && misses_ocr_language(job.ocr_languages.as_deref(), &(self.deps.ocr_languages)())
            && !self.parts(file, Some(ExtractedTextMethod::Ocr))?.is_empty())
    }

    fn parts(
        &self,
        file: &TextFile,
        method: Option<ExtractedTextMethod>,
    ) -> Result<BTreeSet<u32>, String> {
        self.deps
            .search
            .extracted_parts(file.of.clone(), method)
            .map_err(text)
    }

    /// The job still exists with the bytes it started from. False after a stop, after the
    /// index was rebuilt under us, or once the file changed.
    fn owns(&self, file: &TextFile, signature: &str) -> Result<bool, String> {
        if self.stopped() {
            return Ok(false);
        }
        let job = self
            .deps
            .search
            .file_text_job(file.of.clone())
            .map_err(text)?;
        Ok(job.is_some_and(|job| job.signature == signature))
    }

    /// Checked between pages only once the note was flagged, which for an attachment is every
    /// edit of its note: only new bytes stop the read.
    fn rewritten_since(&self, file: &TextFile, signature: &str, path: &Path) -> bool {
        if !self.lock().changed.contains(&file.of.note_id) {
            return false;
        }
        file_signature(path).is_none_or(|current| current.signature != signature)
    }

    fn text_changed(&self, note_id: &str) {
        (self.deps.text_changed)(note_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_language_is_missing_unless_the_read_used_it() {
        let langs = |codes: &[&str]| codes.iter().map(|c| (*c).to_owned()).collect::<Vec<_>>();
        assert!(!misses_ocr_language(None, &langs(&["eng"])));
        assert!(misses_ocr_language(None, &langs(&["eng", "deu"])));
        assert!(!misses_ocr_language(Some("eng+deu"), &langs(&["deu"])));
        assert!(misses_ocr_language(Some("eng"), &langs(&["fra"])));
    }

    #[test]
    fn attachments_read_by_extension() {
        assert_eq!(attachment_kind("a.PDF"), Some(TextKind::Pdf));
        assert_eq!(attachment_kind("a.htm"), Some(TextKind::Html));
        assert_eq!(attachment_kind("a.webp"), Some(TextKind::Image));
        assert_eq!(attachment_kind("a.mp4"), None);
        assert_eq!(attachment_kind("html"), None);
    }
}
