//! Acts when the code under test reports a failed attempt, never by the clock. Its retries log
//! a warning on the failing thread before they wait: `vault::fs_atomic`'s transient retry, and
//! `shell::file_open`'s refusal of a hard-linked file, which `vault::paths` retries. The test's
//! action runs on that warning, so a file taken away "for a moment" comes back, or one changes
//! "during a wait", exactly there, however loaded the machine is.
//!
//! The listener is the binary's global subscriber, armed per thread. One installed for a single
//! thread (`with_default`) misses warnings: while it is the only dispatcher, `tracing` asks the
//! registering thread's own dispatcher whether a call site is wanted, so a test on another
//! thread that hits the warning first caches "never" for every thread.
// Each test binary uses the targets it needs.
#![allow(dead_code)]

use std::cell::RefCell;
use std::sync::Once;

use tracing_subscriber::layer::{Context, Layer, SubscriberExt};

/// The warning of each failed try of `vault::fs_atomic::with_transient_retry`.
pub const TRANSIENT_RETRY: &str = "memry_desktop::vault::fs_atomic";
/// The warning of `shell::file_open` refusing a file with more than one link.
pub const HARD_LINK_REFUSED: &str = "memry_desktop::shell::file_open";

struct Armed {
    target: &'static str,
    count: usize,
    act: Box<dyn FnMut(usize)>,
}

thread_local! {
    static ARMED: RefCell<Option<Armed>> = const { RefCell::new(None) };
}

struct OnWarning;

impl<S: tracing::Subscriber> Layer<S> for OnWarning {
    fn on_event(&self, event: &tracing::Event<'_>, _: Context<'_, S>) {
        let meta = event.metadata();
        if *meta.level() != tracing::Level::WARN {
            return;
        }
        ARMED.with_borrow_mut(|armed| {
            if let Some(armed) = armed
                && armed.target == meta.target()
            {
                armed.count += 1;
                (armed.act)(armed.count);
            }
        });
    }
}

/// Runs `body` on this thread, with `act(n)` run at the `n`th warning from `target` on it.
/// Returns what `body` returned and how many warnings there were.
pub fn on_warnings<T>(
    target: &'static str,
    act: impl FnMut(usize) + 'static,
    body: impl FnOnce() -> T,
) -> (T, usize) {
    static INSTALLED: Once = Once::new();
    INSTALLED.call_once(|| {
        tracing::subscriber::set_global_default(tracing_subscriber::registry().with(OnWarning))
            .expect("no other global subscriber in this test binary");
    });
    // A call site another thread was registering while the subscriber went in may have cached
    // "never"; ask every call site again.
    tracing::callsite::rebuild_interest_cache();
    ARMED.set(Some(Armed {
        target,
        count: 0,
        act: Box::new(act),
    }));
    let returned = body();
    let armed = ARMED.take().expect("armed for the body");
    (returned, armed.count)
}
