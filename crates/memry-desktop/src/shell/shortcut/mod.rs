//! System-wide shortcuts (`apps/desktop/src/main/ipc/settings-handlers.ts`, `registerConfiguredShortcut`
//! and the quick-capture fallback in `index.ts`). The rules live here against a [`Keys`] seam so
//! tests use a fake keyboard; the adapter in `apps/desktop-tauri/src-tauri/src/shortcuts` maps it to
//! the global-shortcut plugin.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

/// What the OS did with a configured binding. Serialized as the renderer's `GlobalCaptureStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ShortcutStatus {
    Unbound,
    Registered,
    InUse,
    Unsupported,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct Modifiers {
    pub meta: bool,
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
}

/// `keyboard.globalCapture` and `keyboard.stickyShortcut`, as stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
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
    /// Whether the built-in fallback currently holds quick capture.
    pub fn fallback_held(&self) -> bool {
        self.fallback_held
    }

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
    pub fn set<E>(
        &mut self,
        keys: &dyn Keys,
        wayland: bool,
        previous: Option<&ShortcutBinding>,
        binding: Option<&ShortcutBinding>,
        on_fire: OnFire,
        save: impl FnOnce() -> Result<(), E>,
    ) -> Result<GlobalCaptureResult, E> {
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
        if let Err(error) = save() {
            // The OS took the binding but the setting did not keep it: what is registered must
            // stay what is saved.
            self.apply(keys, wayland, previous, on_fire);
            return Err(error);
        }
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
mod tests;
