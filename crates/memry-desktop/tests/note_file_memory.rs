//! A note file past `MAX_NOTE_BYTES` is refused without being read. Opening a large file's note
//! reads its properties through `read_note`, and finding the cap by reading to it held 256 MiB
//! (a 512 MiB buffer at its last doubling) for each open of a 2 GB file.
//!
//! The counting allocator sees the whole process, so this binary holds this one test.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use memry_desktop::vault::note_file::{MAX_NOTE_BYTES, NoteFileError, read_note};

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

#[test]
fn a_file_past_the_note_cap_is_refused_unread() {
    let dir = tempfile::tempdir().unwrap();
    // Sparse: the length is set, no byte is written.
    std::fs::File::create(dir.path().join("big.md"))
        .unwrap()
        .set_len(MAX_NOTE_BYTES + 1)
        .unwrap();

    let before = LIVE.load(Ordering::Relaxed);
    PEAK.store(before, Ordering::Relaxed);
    let read = read_note(dir.path(), "big.md");
    let peak = PEAK.load(Ordering::Relaxed) - before;

    assert!(matches!(read, Err(NoteFileError::TooLarge)), "{read:?}");
    assert!(peak < 1024 * 1024, "peak {peak} bytes to refuse the file");
}
