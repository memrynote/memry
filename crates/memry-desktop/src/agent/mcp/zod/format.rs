//! JavaScript's text for values in zod's messages and the SDK's issue paths.

use serde_json::{Number, Value};

use super::Seg;

/// The SDK's `getDotPath`: `elements[3].ref`.
pub(in crate::agent::mcp) fn dot_path(path: &[Seg]) -> String {
    let mut text = String::new();
    for (index, seg) in path.iter().enumerate() {
        match seg {
            Seg::Index(item) if index > 0 => text.push_str(&format!("[{item}]")),
            Seg::Index(item) => text.push_str(&item.to_string()),
            Seg::Key(key) if index > 0 => text.push_str(&format!(".{key}")),
            Seg::Key(key) => text.push_str(key),
        }
    }
    text
}

/// `Number.prototype.toString`.
pub(in crate::agent::mcp) fn js_number(number: &Number) -> String {
    if number.is_i64() || number.is_u64() && number.as_u64().is_some_and(|n| n < 1 << 53) {
        return number.to_string();
    }
    let value = number.as_f64().unwrap_or_default();
    if value == 0.0 {
        return "0".to_owned();
    }
    if (1e-7..1e21).contains(&value.abs()) {
        return value.to_string();
    }
    let text = format!("{value:e}");
    match text.split_once('e') {
        Some((mantissa, exponent)) if !exponent.starts_with('-') => {
            format!("{mantissa}e+{exponent}")
        }
        _ => text,
    }
}

/// zod's `stringifyPrimitive`: a string in quotes, unescaped.
pub(in crate::agent::mcp) fn primitive(value: &Value) -> String {
    match value {
        Value::String(text) => format!("\"{text}\""),
        Value::Number(number) => js_number(number),
        other => other.to_string(),
    }
}

/// `JSON.stringify` of a JSON value: serde's text, with numbers as JavaScript writes them.
pub(in crate::agent::mcp) fn js_json(value: &Value) -> String {
    match value {
        Value::Number(number) => js_number(number),
        Value::Array(items) => {
            let items: Vec<String> = items.iter().map(js_json).collect();
            format!("[{}]", items.join(","))
        }
        Value::Object(object) => {
            let fields: Vec<String> = object
                .iter()
                .map(|(key, item)| format!("{}:{}", Value::from(key.as_str()), js_json(item)))
                .collect();
            format!("{{{}}}", fields.join(","))
        }
        other => other.to_string(),
    }
}

/// `JSON.stringify(text.slice(0, max))` (plus `...` past `max`): the cut is in UTF-16 units, and
/// a surrogate it splits is written as `\udxxx`, as JavaScript does.
pub(in crate::agent::mcp) fn js_quoted_prefix(text: &str, max: usize, ellipsis: &str) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let cut = units.len() > max;
    let mut out = String::from("\"");
    for unit in char::decode_utf16(units.iter().copied().take(max)) {
        match unit {
            Ok(character) => {
                let quoted = Value::from(character.to_string()).to_string();
                out.push_str(&quoted[1..quoted.len() - 1]);
            }
            Err(lone) => out.push_str(&format!("\\u{:04x}", lone.unpaired_surrogate())),
        }
    }
    if cut {
        out.push_str(ellipsis);
    }
    out.push('"');
    out
}

/// `text.slice(0, max)` in UTF-16 units, with a split surrogate dropped (the text is not JSON).
pub(in crate::agent::mcp) fn js_prefix(text: &str, max: usize) -> (String, bool) {
    let units: Vec<u16> = text.encode_utf16().collect();
    let kept = char::decode_utf16(units.iter().copied().take(max))
        .filter_map(Result::ok)
        .collect();
    (kept, units.len() > max)
}
