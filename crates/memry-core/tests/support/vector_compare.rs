//! Comparison rules of the `markdown-convert` class.
//!
//! Markdown strings are compared as byte vectors. A mismatch names the case id,
//! the first differing byte offset and 40 bytes of escaped context on each side,
//! so a failure is attributable to one case and one place.

use std::fmt::Write as _;

use serde_json::Value as Json;

/// Collects the failures of a whole file so one run reports every divergent case.
#[derive(Default)]
pub struct Failures {
    messages: Vec<String>,
    checked: usize,
}

impl Failures {
    pub fn check(&mut self, case_id: &str, outcome: Result<(), String>) {
        self.checked += 1;
        if let Err(message) = outcome {
            self.messages.push(format!("{case_id}: {message}"));
        }
    }

    pub fn checked(&self) -> usize {
        self.checked
    }

    pub fn finish(self, what: &str) {
        if self.messages.is_empty() {
            return;
        }
        let shown = self
            .messages
            .iter()
            .take(15)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        panic!(
            "{what}: {} of {} cases diverge from the oracle\n{shown}{}",
            self.messages.len(),
            self.checked,
            if self.messages.len() > 15 {
                "\n..."
            } else {
                ""
            }
        );
    }
}

fn escaped(bytes: &[u8]) -> String {
    let mut out = String::new();
    for byte in bytes {
        match byte {
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            b'\t' => out.push_str("\\t"),
            0x20..=0x7e => out.push(*byte as char),
            _ => {
                let _ = write!(out, "\\x{byte:02x}");
            }
        }
    }
    out
}

/// Byte-for-byte equality, or the first difference with context.
pub fn bytes_equal(expected: &str, actual: &str) -> Result<(), String> {
    let (e, a) = (expected.as_bytes(), actual.as_bytes());
    let Some(offset) = e
        .iter()
        .zip(a)
        .position(|(x, y)| x != y)
        .or_else(|| (e.len() != a.len()).then(|| e.len().min(a.len())))
    else {
        return Ok(());
    };
    let window = |bytes: &[u8]| {
        let from = offset.saturating_sub(20);
        let to = (offset + 20).min(bytes.len());
        escaped(&bytes[from.min(bytes.len())..to])
    };
    Err(format!(
        "first difference at byte {offset} (expected {} bytes, got {})\n  expected: …{}…\n  actual:   …{}…",
        e.len(),
        a.len(),
        window(e),
        window(a)
    ))
}

/// JSON as one string with the key order kept and every number through `f64`,
/// so `5` and `5.0` are one value on both sides of a comparison.
pub fn canonical_json(value: &Json) -> String {
    match value {
        Json::Number(number) => number
            .as_f64()
            .map_or_else(|| number.to_string(), |n| format!("{n:?}")),
        Json::Array(items) => {
            format!(
                "[{}]",
                items
                    .iter()
                    .map(canonical_json)
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Json::Object(map) => format!(
            "{{{}}}",
            map.iter()
                .map(|(key, item)| format!(
                    "{}:{}",
                    Json::String(key.clone()),
                    canonical_json(item)
                ))
                .collect::<Vec<_>>()
                .join(",")
        ),
        other => other.to_string(),
    }
}

pub fn json_equal(expected: &Json, actual: &Json) -> Result<(), String> {
    bytes_equal(&canonical_json(expected), &canonical_json(actual))
}
