//! System-wide shortcuts (`apps/desktop/src/main/ipc/settings-handlers.ts`, `registerConfiguredShortcut`
//! and the quick-capture fallback in `index.ts`). The rules live here against a [`Keys`] seam so
//! tests use a fake keyboard; the adapter in `apps/desktop-tauri/src-tauri/src/shortcuts` maps it to
//! the global-shortcut plugin.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

/// What the OS did with a configured binding. Serialized as the renderer's `GlobalCaptureStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShortcutStatus {
    Unbound,
    Registered,
    InUse,
    Unsupported,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Modifiers {
    pub meta: bool,
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
}

/// `keyboard.globalCapture` and `keyboard.stickyShortcut`, as stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShortcutBinding {
    pub key: String,
    #[serde(default)]
    pub modifiers: Modifiers,
}

/// The accelerator the quick-capture window holds while no configured binding does.
pub const FALLBACK_ACCELERATOR: &str = "CommandOrControl+Shift+Space";

/// Port of `toElectronAccelerator`: `CommandOrControl` for meta, `Control` for ctrl without
/// meta, then `Alt`, `Shift`, and the key as stored.
pub fn to_accelerator(binding: &ShortcutBinding) -> String {
    let mut parts: Vec<&str> = Vec::new();
    if binding.modifiers.meta {
        parts.push("CommandOrControl");
    }
    if binding.modifiers.ctrl && !binding.modifiers.meta {
        parts.push("Control");
    }
    if binding.modifiers.alt {
        parts.push("Alt");
    }
    if binding.modifiers.shift {
        parts.push("Shift");
    }
    parts.push(&binding.key);
    parts.join("+")
}

/// Global hotkeys do not work under Wayland: the compositor owns the keyboard.
pub fn is_wayland(session_type: Option<&str>, wayland_display: Option<&str>) -> bool {
    session_type.is_some_and(|value| value.eq_ignore_ascii_case("wayland"))
        || wayland_display.is_some_and(|value| !value.is_empty())
}

/// Why the OS refused an accelerator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegisterError {
    /// The accelerator cannot be parsed, for example a non-ASCII key from a macOS Option combo.
    Unsupported,
    /// Another application holds it.
    InUse,
}

pub type OnFire = Arc<dyn Fn() + Send + Sync>;

/// The keyboard the rules run against.
pub trait Keys {
    fn register(&self, accelerator: &str, on_fire: OnFire) -> Result<(), RegisterError>;
    fn unregister(&self, accelerator: &str);
}

/// A configured shortcut and the accelerator it currently holds. Only that accelerator is
/// released on re-apply, so the fallback and the other configured shortcut stay.
#[derive(Debug, Clone)]
pub struct ConfiguredShortcut {
    /// Log prefix.
    pub label: &'static str,
    /// Telemetry `action` stem for a refused registration.
    pub telemetry_action: &'static str,
    pub held: Option<String>,
}

impl ConfiguredShortcut {
    pub const fn new(label: &'static str, telemetry_action: &'static str) -> Self {
        Self {
            label,
            telemetry_action,
            held: None,
        }
    }

    pub fn release(&mut self, keys: &dyn Keys) {
        if let Some(held) = self.held.take() {
            keys.unregister(&held);
        }
    }
}

/// Line-for-line port of `registerConfiguredShortcut`. No binding releases and gives `Unbound`;
/// the accelerator already held gives `Registered` without touching the OS; otherwise the old
/// one is released, `before_register` runs, and the OS decides.
pub fn register_configured(
    keys: &dyn Keys,
    shortcut: &mut ConfiguredShortcut,
    binding: Option<&ShortcutBinding>,
    before_register: impl FnOnce(),
    on_fire: OnFire,
) -> ShortcutStatus {
    let Some(binding) = binding else {
        shortcut.release(keys);
        return ShortcutStatus::Unbound;
    };
    let accelerator = to_accelerator(binding);
    if shortcut.held.as_deref() == Some(accelerator.as_str()) {
        return ShortcutStatus::Registered;
    }
    shortcut.release(keys);
    before_register();
    match keys.register(&accelerator, on_fire) {
        Ok(()) => {
            shortcut.held = Some(accelerator);
            ShortcutStatus::Registered
        }
        Err(RegisterError::Unsupported) => ShortcutStatus::Unsupported,
        Err(RegisterError::InUse) => ShortcutStatus::InUse,
    }
}

/// What a global-capture apply reports to Settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalCaptureResult {
    pub status: ShortcutStatus,
    /// Whether the built-in fallback holds quick capture.
    pub fallback_registered: bool,
}

/// The quick-capture shortcut: the configured binding, and the fixed fallback held only while
/// the configured one is not registered.
#[derive(Debug, Clone)]
pub struct GlobalCapture {
    pub configured: ConfiguredShortcut,
    fallback_held: bool,
    /// Both the configured binding and the fallback failed on the last apply.
    dead: bool,
}

impl Default for GlobalCapture {
    fn default() -> Self {
        Self {
            configured: ConfiguredShortcut::new("Global capture", "global_capture_register_failed"),
            fallback_held: false,
            dead: false,
        }
    }
}

impl GlobalCapture {
    /// Whether quick capture has no working shortcut at all after the last apply.
    pub fn is_dead(&self) -> bool {
        self.dead
    }

    fn sync_fallback(
        &mut self,
        keys: &dyn Keys,
        configured_registered: bool,
        on_fire: &OnFire,
    ) -> bool {
        if configured_registered {
            if self.fallback_held {
                keys.unregister(FALLBACK_ACCELERATOR);
                self.fallback_held = false;
            }
            self.dead = false;
            return false;
        }
        if !self.fallback_held {
            self.fallback_held = keys
                .register(FALLBACK_ACCELERATOR, Arc::clone(on_fire))
                .is_ok();
        }
        self.dead = !self.fallback_held;
        self.fallback_held
    }

    /// Converges on `binding`, so it is safe at startup, on every vault status change and after
    /// every settings write. Under Wayland nothing is registered and every binding reads
    /// `Unsupported`.
    pub fn apply(
        &mut self,
        keys: &dyn Keys,
        wayland: bool,
        binding: Option<&ShortcutBinding>,
        on_fire: OnFire,
    ) -> GlobalCaptureResult {
        if wayland {
            return GlobalCaptureResult {
                status: if binding.is_some() {
                    ShortcutStatus::Unsupported
                } else {
                    ShortcutStatus::Unbound
                },
                fallback_registered: false,
            };
        }
        // The configured binding gets first claim on every accelerator, including the
        // fallback's own: this process already holding it would make the register fail.
        let held_fallback = &mut self.fallback_held;
        let status = register_configured(
            keys,
            &mut self.configured,
            binding,
            || {
                if *held_fallback {
                    keys.unregister(FALLBACK_ACCELERATOR);
                    *held_fallback = false;
                }
            },
            Arc::clone(&on_fire),
        );
        let fallback_registered =
            self.sync_fallback(keys, status == ShortcutStatus::Registered, &on_fire);
        GlobalCaptureResult {
            status,
            fallback_registered,
        }
    }

    /// Register first, save second: a binding the OS refuses is not saved, and the previous one
    /// is registered again so quick capture stays on the shortcut that worked. `save` writes the
    /// setting and runs only for an accepted binding. Returns the result to show.
    pub fn set(
        &mut self,
        keys: &dyn Keys,
        wayland: bool,
        previous: Option<&ShortcutBinding>,
        binding: Option<&ShortcutBinding>,
        on_fire: OnFire,
        save: impl FnOnce() -> Result<(), String>,
    ) -> Result<GlobalCaptureResult, String> {
        let attempt = self.apply(keys, wayland, binding, Arc::clone(&on_fire));
        if matches!(
            attempt.status,
            ShortcutStatus::InUse | ShortcutStatus::Unsupported
        ) {
            let restored = self.apply(keys, wayland, previous, on_fire);
            return Ok(GlobalCaptureResult {
                status: attempt.status,
                fallback_registered: restored.fallback_registered,
            });
        }
        save()?;
        Ok(attempt)
    }

    /// Releases everything this shortcut holds (exit).
    pub fn release_all(&mut self, keys: &dyn Keys) {
        self.configured.release(keys);
        if self.fallback_held {
            keys.unregister(FALLBACK_ACCELERATOR);
            self.fallback_held = false;
        }
    }
}

#[cfg(test)]
mod tests {
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
}
