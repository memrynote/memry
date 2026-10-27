//! Accelerators for the native menu: port of `bindingToAccelerator`
//! (`apps/desktop/src/main/menu.ts`). The string is the Electron form (`CmdOrCtrl+Shift+Plus`);
//! the Tauri adapter parses it with muda and drops it when muda cannot.

use serde::{Deserialize, Serialize};

use super::menu_table::BindingRow;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Modifiers {
    pub meta: bool,
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
}

/// A `ShortcutBinding` of Settings, Shortcuts. Unknown fields are ignored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Binding {
    pub key: String,
    #[serde(default)]
    pub modifiers: Modifiers,
}

impl From<BindingRow> for Binding {
    fn from(row: BindingRow) -> Self {
        Self {
            key: row.key.to_owned(),
            modifiers: Modifiers {
                meta: row.meta,
                ctrl: row.ctrl,
                shift: row.shift,
                alt: row.alt,
            },
        }
    }
}

const NAMED_KEYS: &[&str] = &[
    "Plus",
    "Space",
    "Tab",
    "Enter",
    "Escape",
    "Backspace",
    "Delete",
    "Insert",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Up",
    "Down",
    "Left",
    "Right",
];

fn is_function_key(key: &str) -> bool {
    key.strip_prefix('F')
        .and_then(|n| n.parse::<u8>().ok())
        .is_some_and(|n| (1..=24).contains(&n) && !key.starts_with("F0"))
}

fn accelerator_key(key: &str) -> Option<String> {
    let named = match key {
        "+" => "Plus",
        " " => "Space",
        "ArrowUp" => "Up",
        "ArrowDown" => "Down",
        "ArrowLeft" => "Left",
        "ArrowRight" => "Right",
        other => other,
    };
    let mut chars = named.chars();
    let single_printable =
        matches!((chars.next(), chars.next()), (Some(c), None) if ('\x21'..='\x7e').contains(&c));
    if single_printable {
        return Some(named.to_uppercase());
    }
    (NAMED_KEYS.contains(&named) || is_function_key(named)).then(|| named.to_owned())
}

/// The accelerator for a binding, or `None` when its key is not one printable ASCII character
/// or a named key (an Option combo that types a non-ASCII character has no accelerator).
/// `meta` is the platform command key (`CmdOrCtrl`); `ctrl` is the literal Control key, which
/// off macOS is the same key, so it is not listed twice.
pub fn binding_to_accelerator(binding: &Binding, is_mac: bool) -> Option<String> {
    let key = accelerator_key(&binding.key)?;
    let m = binding.modifiers;
    let mut parts: Vec<&str> = Vec::new();
    if m.meta {
        parts.push("CmdOrCtrl");
    }
    if m.ctrl && (is_mac || !m.meta) {
        parts.push("Control");
    }
    if m.alt {
        parts.push("Alt");
    }
    if m.shift {
        parts.push("Shift");
    }
    parts.push(&key);
    Some(parts.join("+"))
}

/// An accelerator as a label suffix on Windows and Linux: `CmdOrCtrl+W` reads `Ctrl+W`.
pub fn display_shortcut(accelerator: &str) -> String {
    accelerator
        .split('+')
        .map(|part| match part {
            "CmdOrCtrl" | "Control" => "Ctrl",
            other => other,
        })
        .collect::<Vec<_>>()
        .join("+")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(key: &str, m: Modifiers) -> Binding {
        Binding {
            key: key.to_owned(),
            modifiers: m,
        }
    }
    const META: Modifiers = Modifiers {
        meta: true,
        ctrl: false,
        shift: false,
        alt: false,
    };

    #[test]
    fn maps_the_command_key_named_keys_and_plus() {
        assert_eq!(
            binding_to_accelerator(&binding("w", META), true).as_deref(),
            Some("CmdOrCtrl+W")
        );
        let plus = Modifiers {
            shift: true,
            ..META
        };
        assert_eq!(
            binding_to_accelerator(&binding("+", plus), true).as_deref(),
            Some("CmdOrCtrl+Shift+Plus")
        );
        let alt = Modifiers { alt: true, ..META };
        assert_eq!(
            binding_to_accelerator(&binding("ArrowRight", alt), true).as_deref(),
            Some("CmdOrCtrl+Alt+Right")
        );
        let ctrl = Modifiers {
            ctrl: true,
            ..Modifiers::default()
        };
        assert_eq!(
            binding_to_accelerator(&binding("Tab", ctrl), true).as_deref(),
            Some("Control+Tab")
        );
        assert_eq!(
            binding_to_accelerator(&binding("F12", Modifiers::default()), true).as_deref(),
            Some("F12")
        );
        assert_eq!(
            binding_to_accelerator(&binding(" ", META), true).as_deref(),
            Some("CmdOrCtrl+Space")
        );
    }

    #[test]
    fn rejects_keys_an_accelerator_cannot_name() {
        assert_eq!(binding_to_accelerator(&binding("∑", META), true), None);
        assert_eq!(binding_to_accelerator(&binding("Dead", META), true), None);
        assert_eq!(binding_to_accelerator(&binding("F25", META), true), None);
        assert_eq!(binding_to_accelerator(&binding("F0", META), true), None);
        assert_eq!(binding_to_accelerator(&binding("", META), true), None);
    }

    #[test]
    fn control_is_listed_once_off_macos_when_meta_is_also_held() {
        let both = Modifiers {
            meta: true,
            ctrl: true,
            ..Modifiers::default()
        };
        assert_eq!(
            binding_to_accelerator(&binding("k", both), true).as_deref(),
            Some("CmdOrCtrl+Control+K")
        );
        assert_eq!(
            binding_to_accelerator(&binding("k", both), false).as_deref(),
            Some("CmdOrCtrl+K")
        );
    }

    #[test]
    fn display_uses_ctrl() {
        assert_eq!(display_shortcut("CmdOrCtrl+Shift+Plus"), "Ctrl+Shift+Plus");
        assert_eq!(display_shortcut("Control+Y"), "Ctrl+Y");
    }

    #[test]
    fn a_stored_override_parses_with_missing_modifiers() {
        let b: Binding = serde_json::from_str(r#"{"key":"w","modifiers":{"meta":true}}"#).unwrap();
        assert_eq!(b, binding("w", META));
        let b: Binding = serde_json::from_str(r#"{"key":"w"}"#).unwrap();
        assert_eq!(b.modifiers, Modifiers::default());
    }
}
