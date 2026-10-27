use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;

/// A keyboard where some accelerators are taken by other apps and some cannot be parsed.
#[derive(Default)]
struct FakeKeys {
    taken: Mutex<HashSet<String>>,
    mine: Mutex<HashSet<String>>,
    calls: Mutex<Vec<String>>,
}

impl FakeKeys {
    fn taken_by_other(&self, accelerator: &str) {
        self.taken.lock().unwrap().insert(accelerator.to_owned());
    }
    fn holds(&self, accelerator: &str) -> bool {
        self.mine.lock().unwrap().contains(accelerator)
    }
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

impl Keys for FakeKeys {
    fn register(&self, accelerator: &str, _on_fire: OnFire) -> Result<(), RegisterError> {
        self.calls.lock().unwrap().push(format!("+{accelerator}"));
        if !accelerator.is_ascii() {
            return Err(RegisterError::Unsupported);
        }
        let mut mine = self.mine.lock().unwrap();
        if self.taken.lock().unwrap().contains(accelerator) || mine.contains(accelerator) {
            return Err(RegisterError::InUse);
        }
        mine.insert(accelerator.to_owned());
        Ok(())
    }
    fn unregister(&self, accelerator: &str) {
        self.calls.lock().unwrap().push(format!("-{accelerator}"));
        self.mine.lock().unwrap().remove(accelerator);
    }
}

fn binding(key: &str, meta: bool, shift: bool) -> ShortcutBinding {
    ShortcutBinding {
        key: key.to_owned(),
        modifiers: Modifiers {
            meta,
            shift,
            ..Modifiers::default()
        },
    }
}

fn noop() -> OnFire {
    Arc::new(|| {})
}

#[test]
fn the_accelerator_spells_modifiers_in_the_electron_order() {
    let all = ShortcutBinding {
        key: "K".into(),
        modifiers: Modifiers {
            meta: true,
            ctrl: true,
            shift: true,
            alt: true,
        },
    };
    // ctrl is dropped when meta is set: meta already is `CommandOrControl`.
    assert_eq!(to_accelerator(&all), "CommandOrControl+Alt+Shift+K");
    let ctrl = ShortcutBinding {
        key: "F5".into(),
        modifiers: Modifiers {
            ctrl: true,
            ..Modifiers::default()
        },
    };
    assert_eq!(to_accelerator(&ctrl), "Control+F5");
    assert_eq!(
        to_accelerator(&binding("Space", true, true)),
        FALLBACK_ACCELERATOR
    );
}

#[test]
fn a_binding_stored_without_modifiers_still_reads() {
    let parsed: ShortcutBinding = serde_json::from_str(r#"{"key":"K"}"#).unwrap();
    assert_eq!(to_accelerator(&parsed), "K");
}

#[test]
fn wayland_is_the_session_type_or_a_wayland_display() {
    assert!(is_wayland(Some("wayland"), None));
    assert!(is_wayland(Some("Wayland"), None));
    assert!(is_wayland(Some("x11"), Some("wayland-0")));
    assert!(is_wayland(None, Some("wayland-0")));
    assert!(!is_wayland(Some("x11"), None));
    assert!(!is_wayland(None, Some("")));
    assert!(!is_wayland(None, None));
}

#[test]
fn no_binding_releases_what_is_held_and_reads_unbound() {
    let keys = FakeKeys::default();
    let mut shortcut = ConfiguredShortcut::new("t", "t");
    let status = register_configured(
        &keys,
        &mut shortcut,
        Some(&binding("K", true, false)),
        || {},
        noop(),
    );
    assert_eq!(status, ShortcutStatus::Registered);
    assert!(keys.holds("CommandOrControl+K"));
    let status = register_configured(&keys, &mut shortcut, None, || {}, noop());
    assert_eq!(status, ShortcutStatus::Unbound);
    assert!(!keys.holds("CommandOrControl+K"));
}

#[test]
fn the_accelerator_already_held_does_not_touch_the_os_again() {
    let keys = FakeKeys::default();
    let mut shortcut = ConfiguredShortcut::new("t", "t");
    let b = binding("K", true, false);
    register_configured(&keys, &mut shortcut, Some(&b), || {}, noop());
    let before = keys.calls().len();
    assert_eq!(
        register_configured(&keys, &mut shortcut, Some(&b), || {}, noop()),
        ShortcutStatus::Registered
    );
    assert_eq!(keys.calls().len(), before);
}

#[test]
fn a_refused_accelerator_reads_in_use_or_unsupported_and_holds_nothing() {
    let keys = FakeKeys::default();
    keys.taken_by_other("CommandOrControl+K");
    let mut shortcut = ConfiguredShortcut::new("t", "t");
    assert_eq!(
        register_configured(
            &keys,
            &mut shortcut,
            Some(&binding("K", true, false)),
            || {},
            noop()
        ),
        ShortcutStatus::InUse
    );
    // A macOS Option combination arrives as a non-ASCII key.
    assert_eq!(
        register_configured(
            &keys,
            &mut shortcut,
            Some(&binding("å", false, false)),
            || {},
            noop()
        ),
        ShortcutStatus::Unsupported
    );
    assert_eq!(shortcut.held, None);
}

#[test]
fn a_rebind_releases_the_old_accelerator_before_registering_the_new_one() {
    let keys = FakeKeys::default();
    let mut shortcut = ConfiguredShortcut::new("t", "t");
    register_configured(
        &keys,
        &mut shortcut,
        Some(&binding("K", true, false)),
        || {},
        noop(),
    );
    let ran = AtomicUsize::new(0);
    register_configured(
        &keys,
        &mut shortcut,
        Some(&binding("J", true, false)),
        || {
            ran.fetch_add(1, Ordering::SeqCst);
        },
        noop(),
    );
    assert_eq!(ran.load(Ordering::SeqCst), 1);
    assert!(!keys.holds("CommandOrControl+K"));
    assert!(keys.holds("CommandOrControl+J"));
}

#[test]
fn the_fallback_is_held_only_while_no_configured_binding_is() {
    let keys = FakeKeys::default();
    let mut capture = GlobalCapture::default();
    let unbound = capture.apply(&keys, false, None, noop());
    assert_eq!(
        unbound,
        GlobalCaptureResult {
            status: ShortcutStatus::Unbound,
            fallback_registered: true
        }
    );
    assert!(keys.holds(FALLBACK_ACCELERATOR));

    let configured = capture.apply(&keys, false, Some(&binding("K", true, false)), noop());
    assert_eq!(configured.status, ShortcutStatus::Registered);
    assert!(!configured.fallback_registered);
    assert!(!keys.holds(FALLBACK_ACCELERATOR));
    assert!(keys.holds("CommandOrControl+K"));
}

#[test]
fn a_configured_binding_equal_to_the_fallback_gets_first_claim() {
    let keys = FakeKeys::default();
    let mut capture = GlobalCapture::default();
    capture.apply(&keys, false, None, noop());
    let result = capture.apply(&keys, false, Some(&binding("Space", true, true)), noop());
    assert_eq!(result.status, ShortcutStatus::Registered);
    assert!(!result.fallback_registered);
    assert!(keys.holds(FALLBACK_ACCELERATOR));
}

#[test]
fn a_refused_binding_is_not_saved_and_the_previous_one_comes_back() {
    let keys = FakeKeys::default();
    let mut capture = GlobalCapture::default();
    let previous = binding("K", true, false);
    capture.apply(&keys, false, Some(&previous), noop());
    keys.taken_by_other("CommandOrControl+J");

    let saved = AtomicUsize::new(0);
    let result = capture
        .set(
            &keys,
            false,
            Some(&previous),
            Some(&binding("J", true, false)),
            noop(),
            || {
                saved.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(result.status, ShortcutStatus::InUse);
    assert!(!result.fallback_registered);
    assert_eq!(saved.load(Ordering::SeqCst), 0);
    assert!(keys.holds("CommandOrControl+K"));
}

#[test]
fn an_accepted_binding_is_saved_once() {
    let keys = FakeKeys::default();
    let mut capture = GlobalCapture::default();
    let saved = AtomicUsize::new(0);
    let result = capture
        .set(
            &keys,
            false,
            None,
            Some(&binding("K", true, false)),
            noop(),
            || {
                saved.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(result.status, ShortcutStatus::Registered);
    assert_eq!(saved.load(Ordering::SeqCst), 1);
}

#[test]
fn both_the_binding_and_the_fallback_failing_leaves_quick_capture_dead() {
    let keys = FakeKeys::default();
    keys.taken_by_other(FALLBACK_ACCELERATOR);
    keys.taken_by_other("CommandOrControl+K");
    let mut capture = GlobalCapture::default();
    let result = capture.apply(&keys, false, Some(&binding("K", true, false)), noop());
    assert_eq!(result.status, ShortcutStatus::InUse);
    assert!(!result.fallback_registered);
    assert!(capture.is_dead());
}

#[test]
fn under_wayland_nothing_registers_and_a_binding_reads_unsupported() {
    let keys = FakeKeys::default();
    let mut capture = GlobalCapture::default();
    let result = capture.apply(&keys, true, Some(&binding("K", true, false)), noop());
    assert_eq!(result.status, ShortcutStatus::Unsupported);
    assert!(!result.fallback_registered);
    assert_eq!(
        capture.apply(&keys, true, None, noop()).status,
        ShortcutStatus::Unbound
    );
    assert!(keys.calls().is_empty());
}

#[test]
fn re_applying_an_unchanged_state_registers_nothing_new() {
    let keys = FakeKeys::default();
    let mut capture = GlobalCapture::default();
    capture.apply(&keys, false, Some(&binding("K", true, false)), noop());
    let before = keys.calls().len();
    capture.apply(&keys, false, Some(&binding("K", true, false)), noop());
    assert_eq!(keys.calls().len(), before);
}

#[test]
fn release_all_frees_the_configured_binding_and_the_fallback() {
    let keys = FakeKeys::default();
    let mut capture = GlobalCapture::default();
    capture.apply(&keys, false, None, noop());
    capture.release_all(&keys);
    assert!(!keys.holds(FALLBACK_ACCELERATOR));
}

#[test]
fn statuses_serialize_as_the_renderer_reads_them() {
    assert_eq!(
        serde_json::to_string(&ShortcutStatus::InUse).unwrap(),
        "\"in_use\""
    );
    let result = GlobalCaptureResult {
        status: ShortcutStatus::Registered,
        fallback_registered: false,
    };
    assert_eq!(
        serde_json::to_string(&result).unwrap(),
        r#"{"status":"registered","fallbackRegistered":false}"#
    );
}
