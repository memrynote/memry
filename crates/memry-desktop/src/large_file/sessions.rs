//! The open sessions and their leases (`openLargeFileSession`, `readLargeFileLines`,
//! `searchLargeFileSession`, `closeLargeFileSession` of `vault/large-file-session.ts`).

use std::fs::File;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::SystemTime;

use super::index::{LineIndex, ReadOptions, ScanOptions, read_lines, scan_line_index};
use super::reader::Bounded;
use super::search::{SearchOptions, find_matches};
use super::{
    LargeFileError, LargeFileEvent, LargeFileLines, LargeFileOpenResult, LargeFileReadLinesInput,
    LargeFileSearchInput, LargeFileSearchProgress, LargeFileSearchResult, MAX_OPEN_SESSIONS,
    MAX_PAGE_LINES, MAX_QUERY_UNITS, VIEWER_MAX_BYTES,
};
use crate::notes::error::NotesError;
use crate::notes::read;
use crate::session::{OpenVault, Session};

const SCOPE: &str = "LargeFileSession";

/// Where one lease hears its session's scan. The shell wraps a renderer channel in it.
pub type EventSink = Arc<dyn Fn(LargeFileEvent) + Send + Sync>;
/// Where one search reports its growing count.
pub type ProgressSink = Arc<dyn Fn(LargeFileSearchProgress) + Send + Sync>;

struct Lease {
    id: String,
    sink: EventSink,
}

/// One open file and its index, shared by every lease on its note.
struct Entry {
    key: u64,
    note_id: String,
    file: Arc<Bounded<File>>,
    file_bytes: u64,
    modified: Option<SystemTime>,
    index: Option<Arc<LineIndex>>,
    leases: Vec<Lease>,
    /// Set when the session goes: the scan and any search stop at their next window.
    gone: Arc<AtomicBool>,
    /// Bumped per search, so a superseded query stops and its progress is dropped.
    search: Arc<AtomicU64>,
}

impl Entry {
    fn notices(&self, event: impl Fn(String) -> LargeFileEvent) -> Notices {
        self.leases
            .iter()
            .map(|lease| (lease.sink.clone(), event(lease.id.clone())))
            .collect()
    }
}

/// Events collected under the lock and sent after it is released.
type Notices = Vec<(EventSink, LargeFileEvent)>;

fn send(notices: Notices) {
    for (sink, event) in notices {
        sink(event);
    }
}

#[derive(Default)]
struct State {
    /// In open order, which makes the first scanned entry the eviction target.
    entries: Vec<Entry>,
    next_key: u64,
}

impl State {
    fn by_lease(&self, lease: &str) -> Option<&Entry> {
        self.entries
            .iter()
            .find(|entry| entry.leases.iter().any(|held| held.id == lease))
    }

    /// Takes the entry out and stops its scan and search. `notify` tells its leases (a rescan or
    /// an eviction, which no lease asked for).
    fn dispose(&mut self, at: usize, notify: bool) -> Notices {
        let entry = self.entries.remove(at);
        entry.gone.store(true, Ordering::Relaxed);
        if notify {
            entry.notices(|session_id| LargeFileEvent::Closed { session_id })
        } else {
            Vec::new()
        }
    }
}

/// The open large-file sessions of the app. Every session goes when the vault closes.
#[derive(Default)]
pub struct LargeFiles {
    state: Mutex<State>,
}

impl LargeFiles {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Closes every session when the vault closes (`closeAllLargeFileSessions`).
    pub fn register(self: &Arc<Self>, session: &Session) {
        let files = self.clone();
        session.on_close("large-files", Arc::new(move |_| files.close_all()));
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Opens the note's file. Returns as soon as the file is open; the scan runs on its own
    /// thread and reports on `sink`. A note with no file in the vault is `missing`.
    pub fn open(
        self: &Arc<Self>,
        vault: &OpenVault,
        note_id: &str,
        sink: EventSink,
    ) -> Result<LargeFileOpenResult, LargeFileError> {
        match read::file_path(vault, note_id) {
            Ok(path) => self.open_path(note_id, &path, sink),
            Err(NotesError::NotFound(_) | NotesError::Outside) => Ok(LargeFileOpenResult::Missing),
            Err(error) => Err(error.into()),
        }
    }

    /// [`Self::open`] over a resolved path.
    pub fn open_path(
        self: &Arc<Self>,
        note_id: &str,
        path: &Path,
        sink: EventSink,
    ) -> Result<LargeFileOpenResult, LargeFileError> {
        // Open first, then measure through the handle: stat-then-open would measure whatever the
        // path named before the open landed.
        let file = match File::open(path) {
            Ok(file) => file,
            Err(error) => {
                tracing::warn!(scope = SCOPE, note_id, "a large file did not open: {error}");
                return Ok(LargeFileOpenResult::Missing);
            }
        };
        let metadata = match file.metadata() {
            Ok(metadata) => metadata,
            Err(error) => {
                tracing::warn!(scope = SCOPE, note_id, "a large file did not stat: {error}");
                return Ok(LargeFileOpenResult::Missing);
            }
        };
        let file_bytes = metadata.len();
        if file_bytes > VIEWER_MAX_BYTES {
            tracing::info!(
                scope = SCOPE,
                note_id,
                file_bytes,
                "a file past the viewer ceiling is not opened"
            );
            return Ok(LargeFileOpenResult::TooLarge {
                file_bytes,
                max_bytes: VIEWER_MAX_BYTES,
            });
        }
        let modified = metadata.modified().ok();

        let mut state = self.state();
        let lease_id = uuid::Uuid::new_v4().to_string();
        let mut notices = Notices::new();
        if let Some(at) = state.entries.iter().position(|e| e.note_id == note_id) {
            let entry = &mut state.entries[at];
            // Size and modification time together are what keep a scanned index true: a tab
            // switched back to the file does not pay for the scan again.
            if entry.file_bytes == file_bytes && entry.modified == modified {
                entry.leases.push(Lease {
                    id: lease_id.clone(),
                    sink,
                });
                return Ok(match &entry.index {
                    Some(index) => LargeFileOpenResult::Ready {
                        session_id: lease_id,
                        file_bytes,
                        line_count: index.line_count,
                    },
                    None => LargeFileOpenResult::Indexing {
                        session_id: lease_id,
                        file_bytes,
                    },
                });
            }
            // The file changed under the index: every checkpoint is a guess now.
            notices.extend(state.dispose(at, true));
        }
        notices.extend(evict_oldest(&mut state));

        let key = state.next_key;
        state.next_key += 1;
        let file = Arc::new(Bounded::new(file, file_bytes));
        let gone = Arc::new(AtomicBool::new(false));
        state.entries.push(Entry {
            key,
            note_id: note_id.to_owned(),
            file: file.clone(),
            file_bytes,
            modified,
            index: None,
            leases: vec![Lease {
                id: lease_id.clone(),
                sink,
            }],
            gone: gone.clone(),
            search: Arc::new(AtomicU64::new(0)),
        });
        drop(state);
        send(notices);

        let files = self.clone();
        let spawned = std::thread::Builder::new()
            .name("large-file-index".to_owned())
            .spawn(move || files.scan(key, &file, &gone));
        if let Err(error) = spawned {
            let mut state = self.state();
            if let Some(at) = state.entries.iter().position(|e| e.key == key) {
                state.dispose(at, false);
            }
            return Err(error.into());
        }
        Ok(LargeFileOpenResult::Indexing {
            session_id: lease_id,
            file_bytes,
        })
    }

    /// The scan thread: builds the index and hands it to the session, unless the session went
    /// meanwhile.
    fn scan(&self, key: u64, file: &Bounded<File>, gone: &AtomicBool) {
        let mut progress = |bytes_scanned: u64| {
            let notices = self.notices_of(key, |entry, session_id| LargeFileEvent::Scanning {
                session_id,
                bytes_scanned,
                file_bytes: entry.file_bytes,
            });
            send(notices);
        };
        let scanned = scan_line_index(
            file,
            ScanOptions::default(),
            &|| gone.load(Ordering::Relaxed),
            &mut progress,
        );
        let mut state = self.state();
        let Some(at) = state.entries.iter().position(|e| e.key == key) else {
            return;
        };
        let notices = match scanned {
            Ok(Some(index)) => {
                let entry = &mut state.entries[at];
                let (file_bytes, line_count) = (entry.file_bytes, index.line_count);
                entry.index = Some(Arc::new(index));
                entry.notices(|session_id| LargeFileEvent::Ready {
                    session_id,
                    file_bytes,
                    line_count,
                })
            }
            // Stopped: the session is going, and its leases were told by whoever disposed it.
            Ok(None) => Vec::new(),
            Err(error) => {
                tracing::error!(scope = SCOPE, "the line-offset scan failed: {error}");
                let message = error.to_string();
                let notices = state.entries[at].notices(|session_id| LargeFileEvent::Error {
                    session_id,
                    message: message.clone(),
                });
                state.dispose(at, false);
                notices
            }
        };
        drop(state);
        send(notices);
    }

    fn notices_of(&self, key: u64, event: impl Fn(&Entry, String) -> LargeFileEvent) -> Notices {
        let state = self.state();
        state
            .entries
            .iter()
            .find(|entry| entry.key == key)
            .map(|entry| entry.notices(|session_id| event(entry, session_id)))
            .unwrap_or_default()
    }

    /// One page of lines, or `None` when the session is gone or still scanning: the viewer
    /// reopens.
    pub fn read_lines(
        &self,
        input: &LargeFileReadLinesInput,
    ) -> Result<Option<LargeFileLines>, LargeFileError> {
        if input.count == 0 || input.count > MAX_PAGE_LINES {
            return Err(LargeFileError::PageSize);
        }
        let found = self.state().by_lease(&input.session_id).and_then(|entry| {
            let index = entry.index.clone()?;
            Some((entry.file.clone(), index))
        });
        let Some((file, index)) = found else {
            return Ok(None);
        };
        let window = read_lines(
            &*file,
            &index,
            input.start_line,
            input.count as usize,
            ReadOptions::default(),
        )?;
        Ok(Some(LargeFileLines {
            start_line: window.start_line,
            lines: window.lines,
            truncated: window.truncated,
            line_count: index.line_count,
        }))
    }

    /// Every occurrence of the query in the session's file, the first ones as positions. One
    /// search per session at a time: a newer query, from any lease, cancels the older one.
    pub fn search(
        &self,
        input: &LargeFileSearchInput,
        progress: ProgressSink,
    ) -> Result<Option<LargeFileSearchResult>, LargeFileError> {
        let units = input.query.encode_utf16().count();
        if units == 0 || units > MAX_QUERY_UNITS {
            return Err(LargeFileError::Query);
        }
        let found = self.state().by_lease(&input.session_id).map(|entry| {
            let token = entry.search.fetch_add(1, Ordering::Relaxed) + 1;
            let current = entry.search.clone();
            (
                entry.file.clone(),
                entry.file_bytes,
                current,
                token,
                entry.gone.clone(),
            )
        });
        let Some((file, file_bytes, current, token, gone)) = found else {
            return Ok(None);
        };
        let superseded =
            || current.load(Ordering::Relaxed) != token || gone.load(Ordering::Relaxed);
        let mut report = |bytes_searched: u64, total: u64| {
            if superseded() {
                return;
            }
            progress(LargeFileSearchProgress {
                session_id: input.session_id.clone(),
                query: input.query.clone(),
                bytes_searched,
                file_bytes,
                total,
            });
        };
        let found = find_matches(
            &*file,
            &input.query,
            SearchOptions::default(),
            &superseded,
            &mut report,
        )?;
        let query = input.query.clone();
        Ok(Some(if found.cancelled {
            LargeFileSearchResult::Cancelled { query }
        } else {
            LargeFileSearchResult::Complete {
                query,
                hits: found.hits,
                total: found.total,
                limited: found.limited,
            }
        }))
    }

    /// Releases one lease. The file and its index go when the last lease does.
    pub fn close(&self, session_id: &str) {
        let mut state = self.state();
        let Some(at) = state
            .entries
            .iter()
            .position(|entry| entry.leases.iter().any(|lease| lease.id == session_id))
        else {
            return;
        };
        let entry = &mut state.entries[at];
        entry.leases.retain(|lease| lease.id != session_id);
        if entry.leases.is_empty() {
            state.dispose(at, false);
        }
    }

    /// Releases every session. Called when the vault closes.
    pub fn close_all(&self) {
        let mut state = self.state();
        while !state.entries.is_empty() {
            state.dispose(0, false);
        }
    }
}

/// Makes room under the session cap. Every entry has a lease, so eviction takes a session away
/// from a viewer using it; a scanned one survives that (it is told, and its next read reopens),
/// one still scanning would wait forever, so it is never the target. When every open session is
/// still scanning the cap yields: it bounds file handles, not correctness.
fn evict_oldest(state: &mut State) -> Notices {
    let mut notices = Notices::new();
    while state.entries.len() >= MAX_OPEN_SESSIONS {
        let Some(at) = state.entries.iter().position(|e| e.index.is_some()) else {
            tracing::warn!(
                scope = SCOPE,
                open = state.entries.len(),
                max = MAX_OPEN_SESSIONS,
                "every open large-file session is still scanning; keeping them all"
            );
            break;
        };
        notices.extend(state.dispose(at, true));
    }
    notices
}
