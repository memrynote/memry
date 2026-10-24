use std::sync::{Arc, Mutex};

use memry_desktop::command_failure::{
    FailureDetails, FailureReporter, FailureSink, FailureThrottle, MAX_TRACKED_KEYS,
    THROTTLE_WINDOW_MS,
};

#[test]
fn throttle_reports_once_inside_the_window_and_again_after() {
    let mut throttle = FailureThrottle::new();
    assert!(throttle.should_report("notes_get:storage", 1_000));
    assert!(!throttle.should_report("notes_get:storage", 1_000 + THROTTLE_WINDOW_MS - 1));
    assert!(throttle.should_report("notes_get:storage", 1_000 + THROTTLE_WINDOW_MS));
    assert!(!throttle.should_report("notes_get:storage", 1_000 + THROTTLE_WINDOW_MS + 1));
}

#[test]
fn throttle_keys_are_independent() {
    let mut throttle = FailureThrottle::new();
    assert!(throttle.should_report("a:x", 0));
    assert!(throttle.should_report("a:y", 0));
    assert!(throttle.should_report("b:x", 0));
}

#[test]
fn throttle_never_holds_more_than_the_bound() {
    let mut throttle = FailureThrottle::new();
    for i in 0..(MAX_TRACKED_KEYS * 3) {
        assert!(throttle.should_report(&format!("cmd:code-{i}"), 5));
        assert!(throttle.len() <= MAX_TRACKED_KEYS);
    }
    assert_eq!(throttle.len(), MAX_TRACKED_KEYS);
    // The oldest-inserted key was evicted, so it reports again inside the window.
    assert!(throttle.should_report("cmd:code-0", 6));
    // The newest is still tracked.
    assert!(!throttle.should_report(&format!("cmd:code-{}", MAX_TRACKED_KEYS * 3 - 1), 6));
}

#[test]
fn expired_keys_are_swept_before_live_ones_are_dropped() {
    let mut throttle = FailureThrottle::new();
    for i in 0..MAX_TRACKED_KEYS {
        throttle.should_report(&format!("old-{i}"), 0);
    }
    let later = THROTTLE_WINDOW_MS + 1;
    assert!(throttle.should_report("fresh", later));
    assert_eq!(throttle.len(), 1);
}

#[derive(Default)]
struct Recording(Mutex<Vec<String>>);

impl FailureSink for Recording {
    fn report(&self, command: &str, error: FailureDetails<'_>) {
        self.0
            .lock()
            .expect("lock")
            .push(format!("{command}:{}:{}", error.code, error.kind));
    }
}

#[test]
fn reporter_forwards_through_the_throttle_to_the_registered_sink() {
    let first = Arc::new(Recording::default());
    let second = Arc::new(Recording::default());
    let reporter = FailureReporter::new(first.clone());
    let details = FailureDetails {
        kind: "storage",
        code: "disk_full",
        message: "m",
    };

    reporter.report("notes_save", details);
    reporter.report("notes_save", details);
    assert_eq!(
        first.0.lock().expect("lock").as_slice(),
        ["notes_save:disk_full:storage"]
    );

    reporter.register_sink(second.clone());
    reporter.report("notes_save", details);
    assert!(
        second.0.lock().expect("lock").is_empty(),
        "same key is still throttled"
    );
    reporter.report("notes_open", details);
    assert_eq!(
        second.0.lock().expect("lock").as_slice(),
        ["notes_open:disk_full:storage"]
    );
}
