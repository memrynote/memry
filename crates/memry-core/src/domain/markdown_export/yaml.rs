//! The export's frontmatter block (chapter 12 §12.1.4).
//!
//! Values keep their type, as desktop writes them into a new file
//! (`serializeNote`, `apps/desktop/src/main/vault/frontmatter.ts:202`): a list
//! is a YAML sequence, a number and a boolean are bare, and a string that would
//! read back as another type is quoted, the way js-yaml quotes it. A property
//! the vault declares a `date` is a bare YAML date in desktop's file spelling
//! (`spellYamlDate`, `apps/desktop/src/main/vault/yaml-dates.ts:17`), so
//! desktop reads it back as a date and not as text (#5558).

use std::collections::HashSet;

use serde_json::Value;

use crate::domain::note_meta::NoteProperty;

/// One key of the block, in the order the file lists it.
pub(super) struct Field {
    pub key: String,
    pub value: Value,
    /// Write a string value as a bare YAML date when it spells one.
    pub date: bool,
}

impl Field {
    pub fn new(key: &str, value: Value) -> Self {
        Self {
            key: key.to_owned(),
            value,
            date: false,
        }
    }
}

/// A list field, left out when empty, as desktop leaves out empty `tags` and
/// `aliases`.
pub(super) fn list(key: &str, items: &[String]) -> Option<Field> {
    (!items.is_empty()).then(|| Field::new(key, Value::from(items.to_vec())))
}

/// Properties as top-level keys, in the payload's order
/// (`normalizePropertiesToRoot`, `apps/desktop/src/main/vault/frontmatter.ts:446`).
pub(super) fn properties(properties: &[NoteProperty]) -> Vec<Field> {
    properties
        .iter()
        .map(|property| Field {
            key: property.name.clone(),
            value: serde_json::from_str(&property.value_json)
                .unwrap_or_else(|_| Value::String(property.value_json.clone())),
            date: property.type_name.as_deref() == Some("date"),
        })
        .collect()
}

/// The `---` block, or nothing when there are no fields. A key that is
/// already in the block is skipped, as desktop skips a property that would
/// overwrite `tags` or `aliases`.
pub(super) fn block(fields: &[Field]) -> String {
    if fields.is_empty() {
        return String::new();
    }
    let mut out = String::from("---\n");
    let mut seen = HashSet::new();
    for field in fields {
        if !seen.insert(field.key.as_str()) {
            continue;
        }
        let date = match (&field.value, field.date) {
            (Value::String(text), true) => yaml_date(text),
            _ => None,
        };
        match date {
            Some(date) => out.push_str(&format!("{}: {date}\n", string(&field.key))),
            None => entry(&mut out, 0, &field.key, &field.value),
        }
    }
    out.push_str("---\n");
    out
}

fn entry(out: &mut String, indent: usize, key: &str, value: &Value) {
    out.push_str(&" ".repeat(indent));
    out.push_str(&string(key));
    out.push(':');
    match value {
        Value::Array(items) if !items.is_empty() => {
            out.push('\n');
            for item in items {
                out.push_str(&" ".repeat(indent + 2));
                out.push_str("- ");
                out.push_str(&flow(item));
                out.push('\n');
            }
        }
        Value::Object(map) if !map.is_empty() => {
            out.push('\n');
            for (inner, value) in map {
                entry(out, indent + 2, inner, value);
            }
        }
        other => {
            out.push(' ');
            out.push_str(&flow(other));
            out.push('\n');
        }
    }
}

/// A value on one line. JSON is YAML flow syntax, so a nested list or map
/// inside a list item, and an empty one anywhere, is written as its JSON.
fn flow(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => string(text),
        Value::Array(_) | Value::Object(_) => value.to_string(),
    }
}

/// A string scalar: bare when YAML reads it back as the same string, else
/// single-quoted, and double-quoted with escapes when it holds a control
/// character (a JSON string literal is a valid YAML double-quoted scalar).
pub(super) fn string(text: &str) -> String {
    if text.chars().any(char::is_control) {
        return Value::String(text.to_owned()).to_string();
    }
    if plain(text) {
        text.to_owned()
    } else {
        format!("'{}'", text.replace('\'', "''"))
    }
}

fn plain(text: &str) -> bool {
    let Some(first) = text.chars().next() else {
        return false;
    };
    !first.is_whitespace()
        && !text.ends_with(char::is_whitespace)
        && !"-?:,[]{}#&*!|>'\"%@`".contains(first)
        && !text.contains(": ")
        && !text.contains(" #")
        && !text.ends_with(':')
        && !reads_as_other_type(text)
}

/// Whether YAML would resolve the bare text as a boolean, null, number or
/// date. Wider than YAML 1.2 on purpose: an extra pair of quotes is harmless,
/// a tag that reads back as `true` is not.
fn reads_as_other_type(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    let starts_numeric = |rest: &str| rest.starts_with(|c: char| c.is_ascii_digit() || c == '.');
    matches!(
        lower.as_str(),
        "true" | "false" | "yes" | "no" | "on" | "off" | "y" | "n" | "null" | "~"
    ) || lower.ends_with(".inf")
        || lower.ends_with(".nan")
        || starts_numeric(text)
        || (text.starts_with(['+', '-']) && starts_numeric(&text[1..]))
}

/// `text` as a bare YAML date: `2026-07-05` for a date or a UTC midnight,
/// the timestamp as given otherwise. `None` when it is not a calendar date.
fn yaml_date(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let digits = |range: std::ops::Range<usize>| {
        bytes
            .get(range)
            .is_some_and(|run| run.iter().all(u8::is_ascii_digit))
    };
    if !(digits(0..4) && bytes.get(4) == Some(&b'-') && digits(5..7) && bytes.get(7) == Some(&b'-'))
        || !digits(8..10)
    {
        return None;
    }
    let number = |range: std::ops::Range<usize>| text[range].parse::<u32>().ok();
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    if !(1..=12).contains(&month) || day == 0 || day > days_in(year, month) {
        return None;
    }
    let rest = &text[10..];
    if rest.is_empty() || rest == "T00:00:00.000Z" {
        return Some(text[..10].to_owned());
    }
    time_of_day(rest).then(|| text.to_owned())
}

/// `T12:30:00`, optional fraction, then `Z` or `+hh:mm`.
fn time_of_day(rest: &str) -> bool {
    let bytes = rest.as_bytes();
    let digit = |at: usize| bytes.get(at).is_some_and(u8::is_ascii_digit);
    if !(bytes.first() == Some(&b'T')
        && digit(1)
        && digit(2)
        && bytes.get(3) == Some(&b':')
        && digit(4)
        && digit(5)
        && bytes.get(6) == Some(&b':')
        && digit(7)
        && digit(8))
    {
        return false;
    }
    let mut at = 9;
    if bytes.get(at) == Some(&b'.') {
        at += 1;
        let start = at;
        while digit(at) {
            at += 1;
        }
        if at == start {
            return false;
        }
    }
    let zone = &rest[at..];
    let offset = zone.as_bytes();
    zone == "Z"
        || (offset.len() == 6
            && matches!(offset[0], b'+' | b'-')
            && offset[1..3].iter().all(u8::is_ascii_digit)
            && offset[3] == b':'
            && offset[4..6].iter().all(u8::is_ascii_digit))
}

fn days_in(year: u32, month: u32) -> u32 {
    match month {
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strings_that_read_as_other_types_are_quoted() {
        assert_eq!(string("reading"), "reading");
        assert_eq!(string("2026-07-05"), "'2026-07-05'");
        assert_eq!(string("true"), "'true'");
        assert_eq!(string("42"), "'42'");
        assert_eq!(string("a: b"), "'a: b'");
        assert_eq!(string("it's"), "it's");
        assert_eq!(string("#tag"), "'#tag'");
        assert_eq!(string(""), "''");
        assert_eq!(string("line\nbreak"), "\"line\\nbreak\"");
    }

    #[test]
    fn a_date_property_is_a_bare_yaml_date() {
        let fields = vec![
            Field {
                key: "due".to_owned(),
                value: json!("2026-07-05T00:00:00.000Z"),
                date: true,
            },
            Field {
                key: "at".to_owned(),
                value: json!("2026-07-05T09:30:00.000Z"),
                date: true,
            },
            Field {
                key: "bad".to_owned(),
                value: json!("2026-02-30"),
                date: true,
            },
        ];
        assert_eq!(
            block(&fields),
            "---\ndue: 2026-07-05\nat: 2026-07-05T09:30:00.000Z\nbad: '2026-02-30'\n---\n"
        );
    }

    #[test]
    fn lists_maps_and_scalars_keep_their_types() {
        let fields = vec![
            Field::new("tags", json!(["a", "b c"])),
            Field::new("count", json!(3)),
            Field::new("done", json!(false)),
            Field::new("empty", json!([])),
            Field::new("cleared", Value::Null),
            Field::new("nested", json!({"k": [1, {"x": 1}]})),
            Field::new("tags", json!("dropped, already written")),
        ];
        assert_eq!(
            block(&fields),
            "---\ntags:\n  - a\n  - b c\ncount: 3\ndone: false\nempty: []\ncleared: null\n\
             nested:\n  k:\n    - 1\n    - {\"x\":1}\n---\n"
        );
    }
}
