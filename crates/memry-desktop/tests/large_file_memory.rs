//! A large-file session holds a few read windows whatever the file size: opening, indexing,
//! paging and searching a 64 MiB file of 3 million lines peaks far below the file. A session that
//! read the file whole, or kept every line start, would hold its size again.
//!
//! The counting allocator sees the whole process, so this binary holds this one test.

use std::alloc::{GlobalAlloc, Layout, System};
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_desktop::large_file::{
    EventSink, LargeFileEvent, LargeFileOpenResult, LargeFileReadLinesInput, LargeFileSearchInput,
    LargeFileSearchResult, LargeFiles,
};

struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

fn grew(by: usize) {
    let live = LIVE.fetch_add(by, Ordering::Relaxed) + by;
    PEAK.fetch_max(live, Ordering::Relaxed);
}

// SAFETY: every call goes to the system allocator unchanged; this only counts sizes.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the caller's contract for `alloc`, passed on.
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            grew(layout.size());
        }
        ptr
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the caller's contract for `alloc_zeroed`, passed on.
        let ptr = unsafe { System.alloc_zeroed(layout) };
        if !ptr.is_null() {
            grew(layout.size());
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: the caller's contract for `dealloc`, passed on.
        unsafe { System.dealloc(ptr, layout) };
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // SAFETY: the caller's contract for `realloc`, passed on.
        let moved = unsafe { System.realloc(ptr, layout, new_size) };
        if !moved.is_null() {
            // Both blocks may be live while the bytes move.
            grew(new_size);
            LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        }
        moved
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

const LINES: u64 = 3_000_000;
/// Two 4 MiB windows (the scan's, then the search's), the index table and a page, with room.
const BOUND: usize = 12 * 1024 * 1024;

#[test]
fn a_session_over_a_64_mib_file_peaks_at_a_few_windows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.log");
    {
        let mut out = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
        for i in 0..LINES {
            writeln!(out, "{i:010} some log text").unwrap();
        }
    }
    let file_bytes = std::fs::metadata(&path).unwrap().len();
    assert!(file_bytes >= 64 * 1024 * 1024, "{file_bytes}");
    let files = LargeFiles::new();
    let (send, events) = channel();
    let send = Mutex::new(send);
    let sink: EventSink = Arc::new(move |event| {
        let _ = send.lock().unwrap().send(event);
    });

    let before = LIVE.load(Ordering::Relaxed);
    PEAK.store(before, Ordering::Relaxed);

    let LargeFileOpenResult::Indexing { session_id, .. } =
        files.open_path("n1", &path, sink).unwrap()
    else {
        panic!("not indexing");
    };
    // A hang guard, not a measurement.
    while !matches!(
        events
            .recv_timeout(Duration::from_secs(60))
            .expect("an event"),
        LargeFileEvent::Ready {
            line_count: LINES,
            ..
        }
    ) {}
    for start_line in [0, LINES / 2, LINES - 100] {
        let input = LargeFileReadLinesInput {
            session_id: session_id.clone(),
            start_line,
            count: 200,
        };
        let page = files.read_lines(&input).unwrap().expect("a page");
        assert_eq!(page.lines[0], format!("{start_line:010} some log text"));
    }
    let input = LargeFileSearchInput {
        session_id: session_id.clone(),
        query: "SOME LOG".to_owned(),
    };
    let found = files.search(&input, Arc::new(|_| {})).unwrap();
    assert!(matches!(
        found,
        Some(LargeFileSearchResult::Complete { total: LINES, .. })
    ));

    let peak = PEAK.load(Ordering::Relaxed) - before;
    files.close(&session_id);
    assert!(
        peak < BOUND,
        "peak {peak} bytes over a {file_bytes}-byte file, bound {BOUND}"
    );
}
