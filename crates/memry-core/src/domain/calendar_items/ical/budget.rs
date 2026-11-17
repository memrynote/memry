//! The work and output bounds of one feed or object read. A feed is
//! untrusted input of up to 20 MiB (the shell's fetch cap), and its rules
//! multiply: one 60-byte RRULE line expands to thousands of instances, and
//! every instance reads its event's properties again. Each loop of the read
//! counts its steps here and each instance its bytes; once a bound is spent
//! the loops stop and the read fails as [`super::FeedError::TooLarge`], so a
//! hostile feed costs at most [`MAX_STEPS`] steps and [`MAX_OUTPUT_BYTES`]
//! of instances instead of hours and gigabytes. Desktop's `ical.js` has no
//! such bound; a feed under it reads the same here.
//!
//! The counters are thread-local because the read is synchronous on one
//! thread. [`Scope`] arms the bound for the outermost read on the thread;
//! [`visits`] is the monotonic count the complexity tests read.

use std::cell::Cell;
use std::marker::PhantomData;

/// Steps one read may take: lines parsed, rule periods and candidates,
/// occurrences walked, properties read per instance. A large real feed
/// (thousands of events, hundreds of series) takes well under a million.
pub const MAX_STEPS: usize = 10_000_000;

/// Bytes of instances one read may produce (text fields plus a fixed
/// per-instance share). Every instance holds its own copy of its event's
/// text, so a weekday series with a 3 KB meeting invite is about 1 MiB over
/// the window; this holds about 250 of them, and refuses one 1 MiB
/// description copied into a year of daily instances.
pub const MAX_OUTPUT_BYTES: usize = 256 * 1024 * 1024;

/// What one instance costs besides its text: id, dates, flags.
pub const INSTANCE_OVERHEAD: usize = 128;

#[derive(Clone, Copy)]
struct Left {
    steps: usize,
    bytes: usize,
    spent: bool,
}

thread_local! {
    static VISITS: Cell<usize> = const { Cell::new(0) };
    static LEFT: Cell<Option<Left>> = const { Cell::new(None) };
}

/// The bound of one read. Only the outermost scope on a thread arms and
/// disarms it, so a feed read that calls the expansion stays one budget.
pub struct Scope {
    outermost: bool,
    /// Not `Send`: the bound lives in this thread's locals.
    thread: PhantomData<*const ()>,
}

impl Scope {
    pub fn enter() -> Self {
        LEFT.with(|left| {
            if left.get().is_some() {
                return Self {
                    outermost: false,
                    thread: PhantomData,
                };
            }
            left.set(Some(Left {
                steps: MAX_STEPS,
                bytes: MAX_OUTPUT_BYTES,
                spent: false,
            }));
            Self {
                outermost: true,
                thread: PhantomData,
            }
        })
    }
}

impl Drop for Scope {
    fn drop(&mut self) {
        if self.outermost {
            LEFT.with(|left| left.set(None));
        }
    }
}

/// Steps a caller is allowed to take are counted in [`visits`]; a refused
/// charge is work the caller does not do, so it is not.
fn charge(steps: usize, bytes: usize) -> bool {
    let allowed = LEFT.with(|left| {
        let Some(mut current) = left.get() else {
            return true;
        };
        if !current.spent {
            current.spent = steps > current.steps || bytes > current.bytes;
            current.steps = current.steps.saturating_sub(steps);
            current.bytes = current.bytes.saturating_sub(bytes);
            left.set(Some(current));
        }
        !current.spent
    });
    if allowed {
        VISITS.with(|visits| visits.set(visits.get().saturating_add(steps)));
    }
    allowed
}

/// Counts `n` steps. `false` once the armed bound is spent, and from then on.
pub fn step(n: usize) -> bool {
    charge(n, 0)
}

/// Counts one instance of `text_bytes`. `false` once a bound is spent.
pub fn emit(text_bytes: usize) -> bool {
    charge(1, text_bytes.saturating_add(INSTANCE_OVERHEAD))
}

/// Whether the armed bound is spent.
pub fn spent() -> bool {
    LEFT.with(|left| left.get().is_some_and(|l| l.spent))
}

/// Every step counted on this thread so far, for the complexity tests.
#[doc(hidden)]
pub fn visits() -> usize {
    VISITS.with(Cell::get)
}
