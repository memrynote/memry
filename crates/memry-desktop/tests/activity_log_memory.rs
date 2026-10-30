//! Opening the activity log holds a bounded multiple of its 64 MiB size cap, whatever its lines
//! hold: many small objects, one line of a huge array, a summary with too many items or
//! counts, one huge string.
//!
//! The counting allocator sees the whole process, so this binary holds this one test. While a
//! file is read it refuses any allocation past twice the bound, so a reader that regresses
//! aborts the test (`memory allocation of N bytes failed`) instead of swapping the runner.

use std::alloc::{GlobalAlloc, Layout, System};
use std::fmt::Write as _;
use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};

use memry_desktop::vault::activity::{ActivityFilter, ActivityLog, MAX_LOG_BYTES, log_path};

struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
/// Live bytes no allocation may take the process past.
static LIMIT: AtomicUsize = AtomicUsize::new(usize::MAX);

fn refused(by: usize) -> bool {
    LIVE.load(Ordering::Relaxed).saturating_add(by) > LIMIT.load(Ordering::Relaxed)
}

fn grew(by: usize) {
    let live = LIVE.fetch_add(by, Ordering::Relaxed) + by;
    PEAK.fetch_max(live, Ordering::Relaxed);
}

// SAFETY: every call goes to the system allocator unchanged; this only counts sizes.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if refused(layout.size()) {
            return std::ptr::null_mut();
        }
        // SAFETY: the caller's contract for `alloc`, passed on.
        let ptr = unsafe { System.alloc(layout) };
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
        if refused(new_size) {
            return std::ptr::null_mut();
        }
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

/// Bytes allocated at the peak of `work`, over what was live before it.
fn peak_of(work: impl FnOnce()) -> usize {
    let before = LIVE.load(Ordering::Relaxed);
    PEAK.store(before, Ordering::Relaxed);
    LIMIT.store(before + 2 * MAX_HELD, Ordering::Relaxed);
    work();
    LIMIT.store(usize::MAX, Ordering::Relaxed);
    PEAK.load(Ordering::Relaxed) - before
}

const CAP: usize = MAX_LOG_BYTES as usize;
const HEAD: &str =
    r#"{"v":1,"id":"i","at":"2026-10-30T12:00:00.000Z","kind":"added","source":"scan""#;

/// One line: `open`, then `part` while the line stays under the cap, then `close`.
fn one_line(open: &str, part: &str, close: &str) -> String {
    let mut line = String::with_capacity(CAP);
    line.push_str(open);
    while line.len() + part.len() + close.len() + 1 < CAP {
        line.push_str(part);
    }
    line.push_str(close);
    line.push('\n');
    line
}

/// At most this much is held opening a log at the cap and listing it: the line being read, the
/// kept lines (which take the read buffer, never a copy) and the entries listed from them.
/// Measured for a 64 MiB file: 192 MiB for one string as long as the file (the buffer with its
/// spare capacity, the entry's copy and the listed copy), 96 MiB for the other long lines (the
/// buffer), 3 MiB for the small objects. The reader that built every line into a JSON value
/// held 5.9 GB for the small objects and 2.5 GB for the long array.
const MAX_HELD: usize = 4 * CAP;

#[test]
fn opening_a_log_at_the_cap_holds_a_bounded_multiple_of_it() {
    let mut small = String::with_capacity(CAP);
    while small.len() + 3 <= CAP {
        small.push_str("{}\n");
    }
    let mut counts = String::with_capacity(CAP);
    write!(counts, "{HEAD},\"counts\":{{").unwrap();
    for n in 0.. {
        if counts.len() + 32 > CAP {
            break;
        }
        write!(counts, "\"c{n}\":1,").unwrap();
    }
    counts.push_str("\"last\":1}}\n");
    let files = [
        ("small objects", small),
        ("one long array", one_line("{\"x\":[", "[],", "[]]}")),
        (
            "too many items",
            one_line(&format!("{HEAD},\"items\":["), "\"a\",", "\"a\"]}"),
        ),
        ("too many counts", counts),
        (
            "one long string",
            one_line(&format!("{HEAD},\"path\":\""), "abcdefgh", "\"}"),
        ),
    ];
    for (name, text) in files {
        assert!(text.len() <= CAP, "{name} is over the cap");
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(".memry")).unwrap();
        fs::write(log_path(dir.path()), &text).unwrap();
        drop(text);
        let log = ActivityLog::new();
        let held = peak_of(|| {
            log.open(dir.path());
            let _ = log.list(1000, ActivityFilter::All);
        });
        assert!(
            held <= MAX_HELD,
            "{name}: {} MiB held for a {} MiB file",
            held >> 20,
            CAP >> 20
        );
        eprintln!("{name}: {} MiB", held >> 20);
        log.close(dir.path());
    }
}
