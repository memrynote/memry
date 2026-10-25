//! The JavaScript value semantics the marker modules lean on, over
//! `serde_json::Value`: `JSON.parse` / `JSON.stringify` (number formatting,
//! integer-like key order), object spread, truthiness, `String(value)` and
//! `Number(string)`. The TypeScript builds its blocks and marker payloads as
//! plain objects, and the vectors compare key order, so the Rust side has to
//! reproduce what a JS object does with its keys.

use serde_json::{Map, Value as Json};

use crate::markdown::frontmatter::js::{is_js_whitespace, js_trim, number_to_string};

/// A non-null, non-array object (`isRecord`).
pub(crate) fn is_record(value: &Json) -> bool {
    value.is_object()
}

/// Any non-null object, arrays included (`isObject`).
pub(crate) fn is_object(value: &Json) -> bool {
    value.is_object() || value.is_array()
}

/// `value[key]` of a plain object; `None` where JS reads `undefined`.
pub(crate) fn prop<'a>(value: &'a Json, key: &str) -> Option<&'a Json> {
    value.as_object().and_then(|map| map.get(key))
}

/// `true` when `key` is a canonical array index (`"0"`, `"17"`, below 2^32 - 1),
/// which a JS object lists first, in ascending order.
fn is_array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX)
}

/// Reorders `map` the way a JS object lists its own keys: array-index keys
/// ascending, then the others in insertion order.
pub(crate) fn order_keys(map: &mut Map<String, Json>) {
    if !map.keys().any(|key| is_array_index(key).is_some()) {
        return;
    }
    let entries = std::mem::take(map);
    let mut indexed: Vec<(u32, String, Json)> = Vec::new();
    let mut named: Vec<(String, Json)> = Vec::new();
    for (key, value) in entries {
        match is_array_index(&key) {
            Some(index) => indexed.push((index, key, value)),
            None => named.push((key, value)),
        }
    }
    indexed.sort_by_key(|(index, _, _)| *index);
    for (_, key, value) in indexed {
        map.insert(key, value);
    }
    for (key, value) in named {
        map.insert(key, value);
    }
}

/// `{ ...source }` into `target` (object keys, array indexes, string characters).
pub(crate) fn spread_into(target: &mut Map<String, Json>, source: &Json) {
    match source {
        Json::Object(map) => {
            for (key, value) in map {
                target.insert(key.clone(), value.clone());
            }
        }
        Json::Array(items) => {
            for (index, value) in items.iter().enumerate() {
                target.insert(index.to_string(), value.clone());
            }
        }
        Json::String(text) => {
            for (index, unit) in text.encode_utf16().enumerate() {
                if let Some(c) = char::from_u32(u32::from(unit)) {
                    target.insert(index.to_string(), Json::String(c.to_string()));
                }
            }
        }
        _ => {}
    }
}

/// `{ ...a, ...b, ... }` as one object with JS key order.
pub(crate) fn spread_all(sources: &[&Json]) -> Map<String, Json> {
    let mut map = Map::new();
    for source in sources {
        spread_into(&mut map, source);
    }
    order_keys(&mut map);
    map
}

/// JS truthiness of a JSON value.
pub(crate) fn truthy(value: &Json) -> bool {
    match value {
        Json::Null => false,
        Json::Bool(flag) => *flag,
        Json::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Json::String(text) => !text.is_empty(),
        Json::Array(_) | Json::Object(_) => true,
    }
}

/// `String(value)`; `None` is `undefined`.
pub(crate) fn js_to_string(value: Option<&Json>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Json::Null) => "null".to_owned(),
        Some(Json::Bool(flag)) => flag.to_string(),
        Some(Json::Number(n)) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(Json::String(text)) => text.clone(),
        Some(Json::Array(items)) => items
            .iter()
            .map(|item| match item {
                Json::Null => String::new(),
                other => js_to_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Json::Object(_)) => "[object Object]".to_owned(),
    }
}

fn reorder_deep(value: &mut Json) {
    match value {
        Json::Object(map) => {
            for item in map.values_mut() {
                reorder_deep(item);
            }
            order_keys(map);
        }
        Json::Array(items) => items.iter_mut().for_each(reorder_deep),
        // JS holds `-0`, and every JSON text it writes prints `0`.
        Json::Number(n) if n.as_f64().is_some_and(|x| x == 0.0 && x.is_sign_negative()) => {
            *value = Json::from(0);
        }
        _ => {}
    }
}

/// `JSON.parse`; `None` where it throws. Objects get JS key order and `-0` is `0`.
pub(crate) fn js_parse(text: &str) -> Option<Json> {
    let mut value: Json = serde_json::from_str(text).ok()?;
    reorder_deep(&mut value);
    Some(value)
}

/// `JSON.stringify` of a value without `undefined`: numbers print the way
/// `Number#toString` does.
pub(crate) fn js_stringify(value: &Json) -> String {
    let mut out = String::new();
    write_json(value, &mut out);
    out
}

fn write_json(value: &Json, out: &mut String) {
    match value {
        Json::Null => out.push_str("null"),
        Json::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Json::Number(n) => out.push_str(&number_to_string(n.as_f64().unwrap_or(f64::NAN))),
        Json::String(text) => {
            out.push_str(&serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_owned()));
        }
        Json::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_json(item, out);
            }
            out.push(']');
        }
        Json::Object(map) => {
            out.push('{');
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_owned()));
                out.push(':');
                write_json(item, out);
            }
            out.push('}');
        }
    }
}

/// A JSON number from a JS number: `NaN` and the infinities are `null`, as
/// `JSON.stringify` writes them.
pub(crate) fn number_json(x: f64) -> Json {
    serde_json::Number::from_f64(x).map_or(Json::Null, Json::Number)
}

/// `String#trimStart`.
pub(crate) fn js_trim_start(text: &str) -> &str {
    text.trim_start_matches(is_js_whitespace)
}

/// `String#trimEnd`.
pub(crate) fn js_trim_end(text: &str) -> &str {
    text.trim_end_matches(is_js_whitespace)
}

/// `Number(text)`: `NaN` where the text is not a numeric literal.
pub(crate) fn js_number(text: &str) -> f64 {
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        return 0.0;
    }
    let radix = match trimmed.get(..2) {
        Some("0x" | "0X") => Some(16),
        Some("0o" | "0O") => Some(8),
        Some("0b" | "0B") => Some(2),
        _ => None,
    };
    if let Some(radix) = radix {
        let digits = &trimmed[2..];
        if digits.is_empty() {
            return f64::NAN;
        }
        let mut value = 0.0_f64;
        for c in digits.chars() {
            let Some(digit) = c.to_digit(radix) else {
                return f64::NAN;
            };
            value = value * f64::from(radix) + f64::from(digit);
        }
        return value;
    }
    let (sign, body) = match trimmed.as_bytes()[0] {
        b'+' => (1.0, &trimmed[1..]),
        b'-' => (-1.0, &trimmed[1..]),
        _ => (1.0, trimmed),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    if !is_decimal_literal(body) {
        return f64::NAN;
    }
    body.parse::<f64>().map_or(f64::NAN, |x| sign * x)
}

/// `digits [. digits] [e [+-] digits]` with at least one mantissa digit.
fn is_decimal_literal(body: &str) -> bool {
    let bytes = body.as_bytes();
    let mut i = 0;
    let digits = |i: &mut usize| {
        let start = *i;
        while *i < bytes.len() && bytes[*i].is_ascii_digit() {
            *i += 1;
        }
        *i - start
    };
    let mut mantissa = digits(&mut i);
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        mantissa += digits(&mut i);
    }
    if mantissa == 0 {
        return false;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
            i += 1;
        }
        if digits(&mut i) == 0 {
            return false;
        }
    }
    i == bytes.len()
}

/// `Number.isInteger`.
pub(crate) fn is_integer(x: f64) -> bool {
    x.is_finite() && x.fract() == 0.0
}

/// The index `list[x]` reads for an integer `x`, or `None` where JS reads `undefined`.
pub(crate) fn array_index(x: f64, len: usize) -> Option<usize> {
    if x >= 0.0 && x < len as f64 {
        Some(x as usize)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn object_keys_list_indexes_first() {
        let parsed = js_parse(r#"{"b":1,"2":2,"a":3,"1":4}"#).expect("parses");
        assert_eq!(js_stringify(&parsed), r#"{"1":4,"2":2,"b":1,"a":3}"#);
    }

    #[test]
    fn numbers_print_like_javascript() {
        assert_eq!(
            js_stringify(&json!([1.0, 1e21, 0.5, -0.0])),
            "[1,1e+21,0.5,0]"
        );
    }

    #[test]
    fn number_conversion_follows_ecmascript() {
        assert_eq!(js_number(""), 0.0);
        assert_eq!(js_number(" 12 "), 12.0);
        assert_eq!(js_number("0x1f"), 31.0);
        assert!(js_number("1_0").is_nan());
        assert!(js_number("-0x1").is_nan());
        assert_eq!(js_number("1e3"), 1000.0);
        assert_eq!(js_number(".5"), 0.5);
        assert!(js_number("1e").is_nan());
    }
}
