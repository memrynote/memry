//! Port of `packages/editor-schema/src/blocks/callout-types.ts`: which
//! `> [!name]` markers are callouts, the built-in types plus the ones the user
//! defined in the synced `editor.calloutTypes` setting.
//!
//! The TypeScript keeps the custom set in a module-level variable. Here it is
//! an explicit [`CalloutTypes`] value that the readers take, so the caller
//! decides which definitions apply and nothing is process-global.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::markdown::frontmatter::js::js_trim;

pub const CALLOUT_TYPE_VALUES: [&str; 13] = [
    "info",
    "warning",
    "error",
    "success",
    "note",
    "abstract",
    "todo",
    "tip",
    "important",
    "question",
    "example",
    "quote",
    "bug",
];

pub const CALLOUT_LABEL_MAX_LENGTH: usize = 40;
pub const CALLOUT_ICON_MAX_LENGTH: usize = 32;

/// A user-defined callout type. `name` is the text between `[!` and `]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CalloutTypeDefinition {
    pub name: String,
    pub label: String,
    /// `#rrggbb`, lowercase.
    pub color: String,
    pub icon: String,
}

/// The callout types in force: the built-ins plus the custom definitions.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CalloutTypes {
    custom: Vec<CalloutTypeDefinition>,
}

impl CalloutTypes {
    /// `setCalloutTypeDefinitions`: a later definition of a name replaces the
    /// earlier one in place, like the `Map` it fills.
    pub fn new(definitions: impl IntoIterator<Item = CalloutTypeDefinition>) -> Self {
        let mut custom: Vec<CalloutTypeDefinition> = Vec::new();
        for definition in definitions {
            match custom.iter_mut().find(|c| c.name == definition.name) {
                Some(existing) => *existing = definition,
                None => custom.push(definition),
            }
        }
        Self { custom }
    }

    /// `getCalloutTypeDefinitions`.
    pub fn definitions(&self) -> &[CalloutTypeDefinition] {
        &self.custom
    }

    /// `isCalloutTypeName`: whether `[!name]` reads as a callout.
    pub fn is_callout_type_name(&self, name: &str) -> bool {
        is_built_in_callout_type(name) || self.custom.iter().any(|c| c.name == name)
    }
}

pub fn is_built_in_callout_type(name: &str) -> bool {
    CALLOUT_TYPE_VALUES.contains(&name)
}

/// `CALLOUT_TYPE_NAME_REGEX`, `^[a-z][a-z0-9_-]{0,31}$`.
pub fn is_callout_type_name_syntax(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some('a'..='z'))
        && name.len() <= 32
        && chars.all(|c| matches!(c, 'a'..='z' | '0'..='9' | '_' | '-'))
}

/// `^#[0-9a-fA-F]{6}$`.
fn is_hex_color(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// The first `max` UTF-16 units of `text`. A cut through a surrogate pair drops
/// the half, which a Rust string cannot hold.
fn utf16_prefix(text: &str, max: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for c in text.chars() {
        used += c.len_utf16();
        if used > max {
            break;
        }
        out.push(c);
    }
    out
}

/// ICU root-collation weight of a callout name character: `_` < `-` < digits <
/// letters (names are lowercase ASCII, so no case level is involved).
fn collation_weight(c: char) -> u8 {
    match c {
        '_' => 0,
        '-' => 1,
        '0'..='9' => 2 + (c as u8 - b'0'),
        _ => 12 + (c as u8 - b'a'),
    }
}

/// `String#localeCompare` over names that pass `CALLOUT_TYPE_NAME_REGEX`.
fn locale_compare_names(a: &str, b: &str) -> std::cmp::Ordering {
    let weights = |s: &str| s.chars().map(collation_weight).collect::<Vec<_>>();
    weights(a).cmp(&weights(b))
}

/// `sanitizeCalloutTypeDefinitions`: definitions out of the synced
/// `editor.calloutTypes` map. A bad entry, and a name that shadows a built-in,
/// is dropped.
pub fn sanitize_callout_type_definitions(raw: &Value) -> Vec<CalloutTypeDefinition> {
    let Some(entries) = raw.as_object() else {
        return Vec::new();
    };
    let mut definitions = Vec::new();
    for (name, entry) in entries {
        if !is_callout_type_name_syntax(name) || is_built_in_callout_type(name) {
            continue;
        }
        let Some(fields) = entry.as_object() else {
            continue;
        };
        let Some(color) = fields.get("color").and_then(Value::as_str) else {
            continue;
        };
        if !is_hex_color(color) {
            continue;
        }
        let Some(icon) = fields.get("icon").and_then(Value::as_str) else {
            continue;
        };
        if icon.is_empty() || icon.encode_utf16().count() > CALLOUT_ICON_MAX_LENGTH {
            continue;
        }
        let label = match fields.get("label").and_then(Value::as_str) {
            Some(label) if !js_trim(label).is_empty() => {
                utf16_prefix(js_trim(label), CALLOUT_LABEL_MAX_LENGTH)
            }
            _ => name.clone(),
        };
        definitions.push(CalloutTypeDefinition {
            name: name.clone(),
            label,
            color: color.to_ascii_lowercase(),
            icon: icon.to_owned(),
        });
    }
    definitions.sort_by(|a, b| locale_compare_names(&a.name, &b.name));
    definitions
}
