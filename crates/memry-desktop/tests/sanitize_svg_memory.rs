//! `vault::svg` holds a bounded multiple of its input in memory, measured at the size cap on
//! the inputs that grow each structure the most. A sanitizer that widens the text to `char`s
//! or keeps a `u32` table per byte needs well over 100 MB here.
//!
//! The counting allocator sees the whole process, so this binary holds this one test.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use memry_desktop::vault::svg::{MAX_SVG_BYTES, sanitize_svg};

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

/// Bytes allocated at the peak of `work`, over what was live before it.
fn peak_of(work: impl FnOnce()) -> usize {
    let before = LIVE.load(Ordering::Relaxed);
    PEAK.store(before, Ordering::Relaxed);
    work();
    PEAK.load(Ordering::Relaxed) - before
}

/// `head`, then `unit` repeated to fill the cap, then `tail`.
fn at_cap(head: &str, unit: &str, tail: &str) -> String {
    let room = MAX_SVG_BYTES - head.len() - tail.len();
    let mut svg = String::with_capacity(MAX_SVG_BYTES);
    svg.push_str(head);
    svg.push_str(&unit.repeat(room / unit.len()));
    svg.push_str(tail);
    svg
}

#[test]
fn sanitizing_at_the_cap_holds_a_bounded_multiple_of_the_input() {
    let inputs = [
        (
            "paths",
            at_cap("<svg>", "<path d=\"M0 0h1v1z\"/>", "</svg>"),
        ),
        ("lt", at_cap("<svg>", "<", "")),
        ("attributes", at_cap("<svg", " a", ">")),
        ("quotes", at_cap("<svg><g a='", "\"", "'/></svg>")),
        ("name run", at_cap("<svg>", "<a", "")),
        (
            "style",
            at_cap("<svg><style>", ".a{fill:red}", "</style></svg>"),
        ),
        ("depth", at_cap("<svg>", "<g>", "")),
    ];
    for (what, input) in inputs {
        let mut written = 0;
        let peak = peak_of(|| written = sanitize_svg(&input).expect(what).len());
        println!("{what}: {peak} bytes at the peak, {written} written");
        // Two copies of the text between passes and one more for a CSS check, and the output
        // twice while its buffer grows. Text of `<` writes four bytes per input byte.
        let bound = 3 * input.len() + 2 * written;
        assert!(
            peak <= bound,
            "{what}: {peak} bytes at the peak, bound {bound}"
        );
    }
}
