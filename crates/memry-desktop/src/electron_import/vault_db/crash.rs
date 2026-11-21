//! Named crash points for the import's crash tests (feature `import-crash-points`, which no app
//! build enables). An armed point panics, so nothing after it runs, cleanup included, as in a
//! real crash. A hooked point runs the hook and goes on, so a test can start another actor (a
//! native open, Electron) at that moment. Points are per thread: the import runs on the calling
//! thread.

/// Every point, in the order a run passes them.
pub const POINTS: &[&str] = &[
    "stage:writer-created",
    "stage:staged",
    "install:synced",
    "install:index-renamed",
    "install:data-renamed",
];

#[cfg(feature = "import-crash-points")]
type Hook = (&'static str, Box<dyn FnOnce()>);

#[cfg(feature = "import-crash-points")]
thread_local! {
    static ARMED: std::cell::Cell<Option<&'static str>> = const { std::cell::Cell::new(None) };
    static HOOK: std::cell::RefCell<Option<Hook>> = const { std::cell::RefCell::new(None) };
}

/// Makes the next pass through `point` on this thread panic.
#[cfg(feature = "import-crash-points")]
pub fn arm(point: &'static str) {
    assert!(POINTS.contains(&point), "no crash point {point}");
    ARMED.set(Some(point));
}

/// Runs `hook` on the next pass through `point` on this thread.
#[cfg(feature = "import-crash-points")]
pub fn hook(point: &'static str, hook: impl FnOnce() + 'static) {
    assert!(POINTS.contains(&point), "no crash point {point}");
    HOOK.set(Some((point, Box::new(hook))));
}

#[cfg(feature = "import-crash-points")]
pub(super) fn point(name: &'static str) {
    let hook = HOOK.with_borrow_mut(|hook| match hook.take() {
        Some((point, run)) if point == name => Some(run),
        other => {
            *hook = other;
            None
        }
    });
    if let Some(run) = hook {
        run();
    }
    if ARMED.get() == Some(name) {
        ARMED.set(None);
        panic!("import crash point {name}");
    }
}

#[cfg(not(feature = "import-crash-points"))]
pub(super) fn point(_name: &'static str) {}
