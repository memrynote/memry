//! `vault::properties_file` holds a bounded multiple of the file in memory, measured at the
//! size cap on the files that make the reader hold the most: one list read under many names,
//! and one definition aliased under as many short names as fit.
//!
//! The counting allocator sees the whole process, so this binary holds this one test.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use memry_desktop::vault::properties_file::{MAX_PROPERTIES_BYTES, parse};

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

/// `head`, then lines from `line(n)` while they fit under the cap, then the closing dashes.
fn at_cap(head: &str, line: impl Fn(usize) -> String) -> String {
    let cap = usize::try_from(MAX_PROPERTIES_BYTES).unwrap();
    let mut file = format!("---\nproperties:\n{head}");
    for n in 0.. {
        let next = line(n);
        if file.len() + next.len() + 4 > cap {
            break;
        }
        file.push_str(&next);
    }
    file + "---\n"
}

/// At most this much is held reading a file at the cap. Measured, in multiples of the file: 93
/// for the option list (refused once its budget runs out), 67 for one definition under every
/// short name, 48 for plain definitions, most of it the YAML loader's. A cap of 4 MiB held
/// 390 MB.
const MAX_HELD: usize = 128 * 1024 * 1024;

#[test]
fn reading_at_the_cap_holds_a_bounded_multiple_of_the_file() {
    let options = "{value: v, color: c},".repeat(1000);
    let categories = "{todo: {label: T, options: [{value: v, color: c}]}, in_progress: {label: P, options: [{value: v, color: c}]}, done: {label: D, options: [{value: v, color: c}, {value: w, color: c}]}}";
    let inputs = [
        (
            "one option list under every name",
            at_cap(
                &format!("  A: {{type: select, options: &o [{options}]}}\n"),
                |n| format!("  B{n}: {{type: select, options: *o}}\n"),
            ),
        ),
        (
            "one set of status categories under every name",
            at_cap(
                &format!("  A: {{type: status, categories: &c {categories}}}\n"),
                |n| format!("  B{n}: {{type: status, categories: *c}}\n"),
            ),
        ),
        (
            "one definition under every short name",
            at_cap(
                "  A: &d {type: select, options: [{value: v, color: c}, {value: w, color: c}, {value: x, color: c}]}\n",
                |n| format!("  p{n:x}: *d\n"),
            ),
        ),
        (
            "plain definitions",
            at_cap("", |n| format!("  p{n:x}: {{type: text}}\n")),
        ),
    ];
    for (what, file) in inputs {
        let peak = peak_of(|| {
            let _ = parse(&file);
        });
        assert!(
            peak <= MAX_HELD,
            "{what}: {peak} bytes held for a file of {}",
            file.len()
        );
    }
}
