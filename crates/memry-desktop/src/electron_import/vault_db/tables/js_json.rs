//! Electron's `JSON.parse` of source JSON text and `JSON.stringify` of the payloads built from
//! it. Values are `serde_json::Value` (insertion-ordered maps, so a spread or an assignment
//! keeps JavaScript's key positions); [`stringify`] writes them as V8 does: array-index keys
//! first, numbers as doubles printed by `Number#toString`.

use std::cell::Cell;

use serde_json::Value;

use crate::web::extract::utils::json::{JsValue, order_keys, parse as js_parse};

/// Nesting this import parses. serde_json stops at 128 and the core's payload reader adds
/// one level for the payload object; V8 accepts deeper text, which fails the import closed.
pub const MAX_DEPTH: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsonError {
    /// `JSON.parse` throws on this text too.
    NotJson,
    /// `JSON.parse` reads it but this import cannot reproduce the value byte for byte: nesting
    /// past [`MAX_DEPTH`], a lone surrogate escape, or a number beyond an f64.
    Unsupported,
}

thread_local! {
    static VISITS: Cell<usize> = const { Cell::new(0) };
}

/// Values [`stringify`] has converted on this thread, for tests that bound the work by steps.
#[doc(hidden)]
pub fn visits() -> usize {
    VISITS.with(Cell::get)
}

/// `JSON.parse(text)`.
pub fn parse(text: &str) -> Result<Value, JsonError> {
    if nesting(text) > MAX_DEPTH {
        return Err(JsonError::Unsupported);
    }
    // serde_json refuses three inputs `JSON.parse` reads (lone surrogates, numbers past
    // f64::MAX, its own depth limit, kept out above). The JS-grammar parser tells them apart
    // from text that is no JSON; it runs only on a refusal, on text the depth scan bounded.
    serde_json::from_str(text).map_err(|_| match js_parse(text) {
        Ok(_) => JsonError::Unsupported,
        Err(_) => JsonError::NotJson,
    })
}

/// `JSON.stringify(value)`.
pub fn stringify(value: &Value) -> String {
    to_js(value).stringify()
}

fn to_js(value: &Value) -> JsValue {
    VISITS.with(|v| v.set(v.get() + 1));
    match value {
        Value::Null => JsValue::Null,
        Value::Bool(b) => JsValue::Bool(*b),
        // A JS number is a double: a u64 or i64 rounds to the nearest one, as V8 parses it.
        Value::Number(n) => JsValue::Number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => JsValue::String(s.clone()),
        Value::Array(items) => JsValue::Array(items.iter().map(to_js).collect()),
        Value::Object(map) => JsValue::Object(order_keys(
            map.iter().map(|(k, v)| (k.clone(), to_js(v))).collect(),
        )),
    }
}

/// The deepest `[`/`{` nesting of `text`, outside strings, in one pass.
fn nesting(text: &str) -> usize {
    let (mut depth, mut deepest, mut in_string, mut escaped) = (0usize, 0usize, false, false);
    for byte in text.bytes() {
        if in_string {
            match byte {
                _ if escaped => escaped = false,
                b'\\' => escaped = true,
                b'"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'[' | b'{' => {
                depth += 1;
                deepest = deepest.max(depth);
            }
            b']' | b'}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    deepest
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_reserialise_as_json_stringify_writes_them() {
        for (text, js) in [
            (
                r#"{"b":1,"2":2,"a":[1.0,-0,1e21,1E-7,0.5]}"#,
                r#"{"2":2,"b":1,"a":[1,0,1e+21,1e-7,0.5]}"#,
            ),
            ("12345678901234567890123", "1.2345678901234568e+22"),
            ("9007199254740993", "9007199254740992"),
            (r#""\u00e9\n\u2028\"""#, "\"\u{e9}\\n\u{2028}\\\"\""),
            (r#"{"a":1,"a":2,"b":3}"#, r#"{"a":2,"b":3}"#),
        ] {
            assert_eq!(stringify(&parse(text).unwrap()), js, "{text}");
        }
    }

    #[test]
    fn text_json_parse_reads_but_this_import_cannot_reproduce_is_unsupported() {
        let deep = format!("{}{}", "[".repeat(MAX_DEPTH + 1), "]".repeat(MAX_DEPTH + 1));
        for text in [r#""\ud800""#, r#"["\udc00x"]"#, "1e400", deep.as_str()] {
            assert_eq!(parse(text), Err(JsonError::Unsupported), "{text}");
        }
        for text in ["", "{", "[1,]", "{'a':1}", "nul"] {
            assert_eq!(parse(text), Err(JsonError::NotJson), "{text}");
        }
        let at_limit = format!("{}{}", "[".repeat(MAX_DEPTH), "]".repeat(MAX_DEPTH));
        assert!(parse(&at_limit).is_ok());
        // Brackets inside strings, escaped quotes included, are no nesting.
        assert_eq!(nesting(r#"["[[\"[[",{"a":"{{"}]"#), 2);
    }
}
