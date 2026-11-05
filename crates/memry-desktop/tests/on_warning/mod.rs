//! Acts when the code under test reports a failed attempt, never by the clock. Its retries log
//! a warning on the failing thread before they wait: `vault::fs_atomic`'s transient retry, and
//! `shell::file_open`'s refusal of a hard-linked file, which `vault::paths` retries. The test's
//! action runs on that warning, so a file taken away "for a moment" comes back, or one changes
//! "during a wait", exactly there, however loaded the machine is. [`logged`] keeps every line
//! a target logged on the thread, for a test of what the code said.
//!
//! The listener is the binary's global subscriber, armed per thread. One installed for a single
//! thread (`with_default`) misses warnings: while it is the only dispatcher, `tracing` asks the
//! registering thread's own dispatcher whether a call site is wanted, so a test on another
//! thread that hits the warning first caches "never" for every thread.
// Each test binary uses the targets it needs.
#![allow(dead_code)]

use std::cell::RefCell;
use std::fmt::{Debug, Write as _};
use std::sync::Once;

use tracing::field::{Field, Visit};
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};

/// The warning of each failed try of `vault::fs_atomic::with_transient_retry`.
pub const TRANSIENT_RETRY: &str = "memry_desktop::vault::fs_atomic";
/// The warning of `shell::file_open` refusing a file with more than one link.
pub const HARD_LINK_REFUSED: &str = "memry_desktop::shell::file_open";
/// What `notes::folder_sync` says of a synced folder it removed or kept.
pub const FOLDER_SYNC: &str = "memry_desktop::notes::folder_sync";

struct Armed {
    target: &'static str,
    count: usize,
    act: Box<dyn FnMut(usize)>,
    lines: Vec<String>,
}

thread_local! {
    static ARMED: RefCell<Option<Armed>> = const { RefCell::new(None) };
}

struct OnWarning;

impl<S: tracing::Subscriber> Layer<S> for OnWarning {
    fn on_event(&self, event: &tracing::Event<'_>, _: Context<'_, S>) {
        let meta = event.metadata();
        ARMED.with_borrow_mut(|armed| {
            let Some(armed) = armed.as_mut().filter(|armed| armed.target == meta.target()) else {
                return;
            };
            let mut line = Line(meta.level().to_string());
            event.record(&mut line);
            armed.lines.push(line.0);
            if *meta.level() == tracing::Level::WARN {
                armed.count += 1;
                (armed.act)(armed.count);
            }
        });
    }
}

/// An event as `LEVEL message field=value ...`, the scope field left out.
struct Line(String);

impl Visit for Line {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.record_debug(field, &format_args!("{value}"));
    }

    fn record_debug(&mut self, field: &Field, value: &dyn Debug) {
        match field.name() {
            "message" => write!(self.0, " {value:?}"),
            "scope" => Ok(()),
            name => write!(self.0, " {name}={value:?}"),
        }
        .expect("a String takes every write");
    }
}

/// Runs `body` on this thread, with `act(n)` run at the `n`th warning from `target` on it.
/// Returns what `body` returned and how many warnings there were.
pub fn on_warnings<T>(
    target: &'static str,
    act: impl FnMut(usize) + 'static,
    body: impl FnOnce() -> T,
) -> (T, usize) {
    let (returned, armed) = armed(target, Box::new(act), body);
    (returned, armed.count)
}

/// Runs `body` on this thread. Returns what it returned and each line `target` logged on it,
/// as `LEVEL message field=value ...`.
pub fn logged<T>(target: &'static str, body: impl FnOnce() -> T) -> (T, Vec<String>) {
    let (returned, armed) = armed(target, Box::new(|_| {}), body);
    (returned, armed.lines)
}

fn armed<T>(
    target: &'static str,
    act: Box<dyn FnMut(usize)>,
    body: impl FnOnce() -> T,
) -> (T, Armed) {
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
        act,
        lines: Vec::new(),
    }));
    let returned = body();
    (returned, ARMED.take().expect("armed for the body"))
}
