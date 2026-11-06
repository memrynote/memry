//! The large-file sessions over real files (`vault/large-file-session.test.ts`): each open a lease
//! with its own channel, the scan on its own thread, the cap of four, and a real vault's note.
//!
//! | Test                                                        | Rule                                  |
//! | ----------------------------------------------------------- | ------------------------------------- |
//! | an open scans on its own thread and pages read through it   | scan progress, then ready             |
//! | a second open shares the scanned file                       | a tab switched back pays no scan      |
//! | a session lives until its last lease closes                 | `holders`                             |
//! | a file changed on disk closes the old leases                | `closed`, never a stale index         |
//! | a fifth file evicts the oldest scanned session              | `MAX_OPEN_SESSIONS`                   |
//! | a file past the ceiling is not opened                       | `VIEWER_MAX_BYTES`                    |
//! | a closed or reloaded page lets go of its leases             | no lease outlives its page            |
//! | a newer search cancels the older one                        | one search per session                |
//! | a search reports progress and the true total                | `total` past the hit cap              |
//! | page and query sizes are refused past their caps            | the contract's bounds                 |
//! | a vault's note opens by id and closes with the vault        | `closeAllLargeFileSessions`           |
//! | a hard-linked, special or gone note file is missing         | the vault's file-open rules           |

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_desktop::large_file::{
    EventSink, LargeFileError, LargeFileEvent, LargeFileOpenResult, LargeFileReadLinesInput,
    LargeFileSearchInput, LargeFileSearchResult, LargeFiles, ProgressSink, VIEWER_MAX_BYTES,
};
use memry_desktop::notes::identity::NotesIdentity;
use vault_env::{env, indexed};

/// A hang guard, not a measurement.
const WAIT: Duration = Duration::from_secs(30);

fn sink() -> (EventSink, Receiver<LargeFileEvent>) {
    let (send, events) = channel();
    let send = Mutex::new(send);
    let sink: EventSink = Arc::new(move |event| {
        let _ = send.lock().unwrap().send(event);
    });
    (sink, events)
}

fn session_of(opened: &LargeFileOpenResult) -> String {
    match opened {
        LargeFileOpenResult::Indexing { session_id, .. }
        | LargeFileOpenResult::Ready { session_id, .. } => session_id.clone(),
        other => panic!("not open: {other:?}"),
    }
}

/// The events up to the first `ready`, which is returned last.
fn until_ready(events: &Receiver<LargeFileEvent>) -> Vec<LargeFileEvent> {
    let mut seen = Vec::new();
    loop {
        let event = events.recv_timeout(WAIT).expect("an event");
        let ready = matches!(event, LargeFileEvent::Ready { .. });
        seen.push(event);
        if ready {
            return seen;
        }
    }
}

/// Opens `path` as note `note_id` for the main window.
fn open_at(
    files: &Arc<LargeFiles>,
    note_id: &str,
    path: &Path,
    sink: EventSink,
) -> Result<LargeFileOpenResult, LargeFileError> {
    files.open_file(note_id, "main", fs::File::open(path).unwrap(), sink)
}

fn write_lines(dir: &Path, name: &str, lines: usize) -> PathBuf {
    let path = dir.join(name);
    let text: String = (0..lines)
        .map(|i| format!("line {i} of {name}\n"))
        .collect();
    fs::write(&path, text).unwrap();
    path
}

fn page(files: &LargeFiles, session_id: &str, start_line: u64, count: u32) -> Option<Vec<String>> {
    let input = LargeFileReadLinesInput {
        session_id: session_id.to_owned(),
        start_line,
        count,
    };
    files.read_lines(&input).unwrap().map(|lines| lines.lines)
}

/// Opens `path` as note `note_id` and waits for its scan.
fn opened(
    files: &Arc<LargeFiles>,
    note_id: &str,
    path: &Path,
) -> (String, Receiver<LargeFileEvent>) {
    let (sink, events) = sink();
    let session = session_of(&open_at(files, note_id, path, sink).unwrap());
    until_ready(&events);
    (session, events)
}

#[test]
fn an_open_scans_on_its_own_thread_and_pages_read_through_it() {
    let dir = tempfile::tempdir().unwrap();
    // Three 4 MiB scan windows, so the scan reports progress before it is ready.
    let path = write_lines(dir.path(), "big.log", 500_000);
    let file_bytes = fs::metadata(&path).unwrap().len();
    let files = LargeFiles::new();
    let (sink, events) = sink();

    let opened = open_at(&files, "n1", &path, sink).unwrap();
    let LargeFileOpenResult::Indexing {
        session_id,
        file_bytes: measured,
    } = opened
    else {
        panic!("{opened:?}");
    };
    assert_eq!(measured, file_bytes);
    let seen = until_ready(&events);
    let scanned: Vec<u64> = seen
        .iter()
        .filter_map(|event| match event {
            LargeFileEvent::Scanning {
                session_id: of,
                bytes_scanned,
                ..
            } if *of == session_id => Some(*bytes_scanned),
            _ => None,
        })
        .collect();
    assert!(scanned.len() >= 2, "{scanned:?}");
    assert_eq!(scanned.last(), Some(&file_bytes));
    assert_eq!(
        seen.last(),
        Some(&LargeFileEvent::Ready {
            session_id: session_id.clone(),
            file_bytes,
            line_count: 500_000,
        })
    );

    let lines = page(&files, &session_id, 499_998, 10).unwrap();
    assert_eq!(lines, ["line 499998 of big.log", "line 499999 of big.log"]);
    let lines = page(&files, &session_id, 123_456, 1).unwrap();
    assert_eq!(lines, ["line 123456 of big.log"]);
}

#[test]
fn a_second_open_shares_the_scanned_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_lines(dir.path(), "a.md", 100);
    let files = LargeFiles::new();
    let (first, _events) = opened(&files, "n1", &path);
    let (sink, events) = sink();

    let second = open_at(&files, "n1", &path, sink).unwrap();

    let LargeFileOpenResult::Ready {
        session_id,
        line_count,
        ..
    } = second
    else {
        panic!("{second:?}");
    };
    assert_ne!(session_id, first);
    assert_eq!(line_count, 100);
    assert!(events.try_recv().is_err(), "no second scan");
    assert_eq!(page(&files, &session_id, 0, 1).unwrap(), ["line 0 of a.md"]);
}

#[test]
fn a_session_lives_until_its_last_lease_closes() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_lines(dir.path(), "a.md", 10);
    let files = LargeFiles::new();
    let (first, _a) = opened(&files, "n1", &path);
    let (sink, _b) = sink();
    let second = session_of(&open_at(&files, "n1", &path, sink).unwrap());

    files.close(&first);
    assert!(page(&files, &first, 0, 1).is_none());
    assert_eq!(page(&files, &second, 0, 1).unwrap(), ["line 0 of a.md"]);

    files.close(&second);
    assert!(page(&files, &second, 0, 1).is_none());
}

#[test]
fn a_file_changed_on_disk_closes_the_old_leases() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_lines(dir.path(), "a.md", 10);
    let files = LargeFiles::new();
    let (old, old_events) = opened(&files, "n1", &path);

    write_lines(dir.path(), "a.md", 20);
    let (fresh, _events) = opened(&files, "n1", &path);

    assert_eq!(
        old_events.recv_timeout(WAIT).unwrap(),
        LargeFileEvent::Closed {
            session_id: old.clone()
        }
    );
    assert!(page(&files, &old, 0, 1).is_none());
    assert_eq!(page(&files, &fresh, 19, 5).unwrap(), ["line 19 of a.md"]);
}

#[test]
fn a_fifth_file_evicts_the_oldest_scanned_session() {
    let dir = tempfile::tempdir().unwrap();
    let files = LargeFiles::new();
    let mut open = Vec::new();
    for n in 0..4 {
        let path = write_lines(dir.path(), &format!("{n}.md"), 5);
        open.push(opened(&files, &format!("n{n}"), &path));
    }
    let path = write_lines(dir.path(), "4.md", 5);
    let (newest, _events) = opened(&files, "n4", &path);

    let (oldest, oldest_events) = &open[0];
    assert_eq!(
        oldest_events.recv_timeout(WAIT).unwrap(),
        LargeFileEvent::Closed {
            session_id: oldest.clone()
        }
    );
    assert!(page(&files, oldest, 0, 1).is_none());
    for (kept, _) in &open[1..] {
        assert!(page(&files, kept, 0, 1).is_some());
    }
    assert!(page(&files, &newest, 0, 1).is_some());
}

#[test]
fn a_file_past_the_ceiling_is_not_opened() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("huge.log");
    // Sparse: the length is set, no byte is written.
    fs::File::create(&path)
        .unwrap()
        .set_len(VIEWER_MAX_BYTES + 1)
        .unwrap();
    let (sink, _events) = sink();

    let opened = open_at(&LargeFiles::new(), "n1", &path, sink).unwrap();

    assert_eq!(
        opened,
        LargeFileOpenResult::TooLarge {
            file_bytes: VIEWER_MAX_BYTES + 1,
            max_bytes: VIEWER_MAX_BYTES,
        }
    );
}

fn query(session_id: &str, text: &str) -> LargeFileSearchInput {
    LargeFileSearchInput {
        session_id: session_id.to_owned(),
        query: text.to_owned(),
    }
}

#[test]
fn a_newer_search_cancels_the_older_one() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_lines(dir.path(), "big.log", 500_000);
    let files = LargeFiles::new();
    let (session_id, _events) = opened(&files, "n1", &path);
    let (started, first_window) = channel();
    let started = Mutex::new(Some(started));
    let (go, wait) = channel::<()>();
    let wait = Mutex::new(wait);
    // The first search holds its first window until the second search has run.
    let progress: ProgressSink = Arc::new(move |_| {
        if let Some(started) = started.lock().unwrap().take() {
            started.send(()).unwrap();
            wait.lock().unwrap().recv_timeout(WAIT).unwrap();
        }
    });
    let older = {
        let files = files.clone();
        let input = query(&session_id, "line");
        std::thread::spawn(move || files.search(&input, progress).unwrap())
    };
    first_window.recv_timeout(WAIT).unwrap();

    let newer = files
        .search(&query(&session_id, "of"), Arc::new(|_| {}))
        .unwrap();
    go.send(()).unwrap();

    assert!(matches!(
        newer,
        Some(LargeFileSearchResult::Complete { total: 500_000, .. })
    ));
    assert_eq!(
        older.join().unwrap(),
        Some(LargeFileSearchResult::Cancelled {
            query: "line".to_owned()
        })
    );
}

#[test]
fn a_search_reports_progress_and_the_true_total() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_lines(dir.path(), "big.log", 500_000);
    let file_bytes = fs::metadata(&path).unwrap().len();
    let files = LargeFiles::new();
    let (session_id, _events) = opened(&files, "n1", &path);
    let reports = Arc::new(Mutex::new(Vec::new()));
    let seen = reports.clone();

    let found = files
        .search(
            &query(&session_id, "LINE 4"),
            Arc::new(move |progress| seen.lock().unwrap().push(progress)),
        )
        .unwrap();

    let Some(LargeFileSearchResult::Complete {
        hits,
        total,
        limited,
        ..
    }) = found
    else {
        panic!("{found:?}");
    };
    // "line 4", "line 4x" ... "line 4xxxxx": 1 + 10 + 100 + 1000 + 10 000 + 100 000.
    assert_eq!(total, 111_111);
    assert!(limited);
    assert_eq!(hits.len(), 2000);
    assert_eq!((hits[0].line, hits[0].ordinal), (4, 0));
    let reports = reports.lock().unwrap();
    assert!(reports.len() >= 2);
    let last = reports.last().unwrap();
    assert_eq!(
        (last.bytes_searched, last.file_bytes, last.total),
        (file_bytes, file_bytes, 111_111)
    );
    assert_eq!(last.session_id, session_id);
}

#[test]
fn page_and_query_sizes_are_refused_past_their_caps() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_lines(dir.path(), "a.md", 5);
    let files = LargeFiles::new();
    let (session_id, _events) = opened(&files, "n1", &path);
    for count in [0, 2001] {
        let input = LargeFileReadLinesInput {
            session_id: session_id.clone(),
            start_line: 0,
            count,
        };
        assert!(matches!(
            files.read_lines(&input),
            Err(LargeFileError::PageSize)
        ));
    }
    assert!(page(&files, &session_id, 0, 2000).is_some());
    for text in [String::new(), "x".repeat(201), "😀".repeat(101)] {
        let refused = files.search(&query(&session_id, &text), Arc::new(|_| {}));
        assert!(matches!(refused, Err(LargeFileError::Query)), "{text:?}");
    }
    assert!(
        files
            .search(&query(&session_id, &"😀".repeat(100)), Arc::new(|_| {}))
            .is_ok()
    );
}

#[test]
fn a_vaults_note_opens_by_id_and_closes_with_the_vault() {
    let mut e = env(|store| Some(NotesIdentity::new(store)));
    e.write("Big.md", "# Big\n");
    let files = LargeFiles::new();
    files.register(&e.session);
    e.open();
    e.facts_until(indexed);
    let id = e
        .rows()
        .into_iter()
        .find(|(_, path)| path == "Big.md")
        .expect("a row for Big.md")
        .0;
    // A note that grows into the class stays a note.
    let text: String = (0..60_000).map(|i| format!("row {i}\n")).collect();
    fs::write(e.vault.join("Big.md"), &text).unwrap();
    let vault = e.session.current().expect("open");
    let (sink, events) = sink();

    let session_id = session_of(&files.open(&vault, &id, "main", sink).unwrap());
    until_ready(&events);
    assert_eq!(page(&files, &session_id, 59_999, 1).unwrap(), ["row 59999"]);
    let (sink, _) = self::sink();
    assert_eq!(
        files.open(&vault, "no-such-note", "main", sink).unwrap(),
        LargeFileOpenResult::Missing
    );

    e.close();
    assert!(page(&files, &session_id, 0, 1).is_none());
}

#[test]
fn a_closed_or_reloaded_page_lets_go_of_its_leases() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_lines(dir.path(), "a.md", 10);
    let files = LargeFiles::new();
    let (main, _a) = opened(&files, "n1", &path);
    let (sink, _b) = sink();
    let other = session_of(
        &files
            .open_file("n1", "note-window", fs::File::open(&path).unwrap(), sink)
            .unwrap(),
    );

    files.release_owner("note-window");
    assert!(page(&files, &other, 0, 1).is_none());
    assert!(page(&files, &main, 0, 1).is_some());

    files.release_owner("main");
    assert!(page(&files, &main, 0, 1).is_none());
}

/// A vault holding `Big.md` as a note, opened, with the note's id.
fn vault_with_note() -> (vault_env::Env, String) {
    let mut e = env(|store| Some(NotesIdentity::new(store)));
    e.write("Big.md", "# Big\n");
    e.open();
    e.facts_until(indexed);
    let id = e
        .rows()
        .into_iter()
        .find(|(_, path)| path == "Big.md")
        .expect("a row for Big.md")
        .0;
    (e, id)
}

#[test]
fn a_hard_linked_special_or_gone_note_file_is_missing() {
    let (e, id) = vault_with_note();
    let vault = e.session.current().expect("open");
    let files = LargeFiles::new();
    let open = |files: &Arc<LargeFiles>| {
        let (sink, _) = sink();
        files.open(&vault, &id, "main", sink).unwrap()
    };
    let note = e.vault.join("Big.md");

    let link = e._dir.path().join("elsewhere.md");
    fs::hard_link(&note, &link).unwrap();
    assert_eq!(open(&files), LargeFileOpenResult::Missing, "hard-linked");
    fs::remove_file(&link).unwrap();

    fs::remove_file(&note).unwrap();
    assert_eq!(open(&files), LargeFileOpenResult::Missing, "gone");

    #[cfg(unix)]
    {
        // A FIFO with no writer: a plain open would block until one appears.
        let status = std::process::Command::new("mkfifo")
            .arg(&note)
            .status()
            .unwrap();
        assert!(status.success());
        let (done, answered) = channel();
        let files = files.clone();
        let vault = vault.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            let (sink, _) = sink();
            let _ = done.send(files.open(&vault, &id, "main", sink).unwrap());
        });
        assert_eq!(
            answered.recv_timeout(WAIT).expect("the open answered"),
            LargeFileOpenResult::Missing,
            "a FIFO"
        );
    }
}
