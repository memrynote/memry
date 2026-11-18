//! `jsonld` and `$jsonld` of `@metascraper/helpers` 5.49.21: every
//! `script[type="application/ld+json"]` parsed (with `jsonrepair` as the fallback), `@graph`
//! items spread over their document's other properties, and lodash `get` over the result.

use super::select::{Attr, Compound, Page, Sel};
use crate::web::extract::dom::decode_html;
use crate::web::extract::utils::json::{self, JsValue};

const SCRIPT: Sel = Sel(&[Compound(
    Some("script"),
    &[Attr::Eq("type", "application/ld+json", false)],
)]);

/// The error `graph.map(...)` throws when `@graph` is truthy but not an array. It escapes the
/// rule, so metascraper and the whole metadata fetch fail with it.
pub const GRAPH_NOT_ARRAY: &str = "graph.map is not a function";

/// The JSON-LD items of a page in document order.
pub fn collection(page: &Page) -> Result<Vec<JsValue>, &'static str> {
    let mut items = Vec::new();
    for script in page.select(SCRIPT) {
        let Some(text) = page.text(script) else {
            continue;
        };
        let Some(json) = parse_json(&text) else {
            continue;
        };
        if !json.truthy() {
            continue;
        }
        let graph = match &json {
            JsValue::Object(entries) => entries.iter().find(|(k, _)| k == "@graph").map(|(_, v)| v),
            _ => None,
        };
        let value = match graph {
            Some(graph) if graph.truthy() => {
                let JsValue::Array(graph_items) = graph else {
                    return Err(GRAPH_NOT_ARRAY);
                };
                let JsValue::Object(entries) = &json else {
                    unreachable!("only an object has @graph");
                };
                let props: Vec<_> = entries
                    .iter()
                    .filter(|(k, _)| k != "@graph")
                    .cloned()
                    .collect();
                JsValue::Array(
                    graph_items
                        .iter()
                        .map(|item| spread(&props, item))
                        .collect(),
                )
            }
            _ => json,
        };
        // cheerio's `.map` concatenates a returned array into the set.
        match value {
            JsValue::Array(values) => items.extend(values),
            other => items.push(other),
        }
    }
    items.retain(JsValue::truthy);
    Ok(items)
}

/// `({ ...props, ...item })`.
fn spread(props: &[(String, JsValue)], item: &JsValue) -> JsValue {
    let mut out = props.to_vec();
    let own: Vec<(String, JsValue)> = match item {
        JsValue::Object(entries) => entries.clone(),
        JsValue::Array(values) => values
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect(),
        JsValue::String(s) => s
            .encode_utf16()
            .enumerate()
            .map(|(i, unit)| {
                (
                    i.to_string(),
                    JsValue::String(String::from_utf16_lossy(&[unit])),
                )
            })
            .collect(),
        _ => Vec::new(),
    };
    for (key, value) in own {
        match out.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = value,
            None => out.push((key, value)),
        }
    }
    JsValue::Object(out)
}

/// `$jsonld(propName)($)`: the first item whose value at the path is not empty (a number or a
/// boolean counts), else the last item's value; strings come back HTML-decoded.
pub fn lookup(items: &[JsValue], path: &str) -> Option<JsValue> {
    let mut value = None;
    for item in items {
        value = get(item, path).cloned();
        if value.as_ref().is_some_and(|v| !lodash_is_empty(v)) {
            break;
        }
    }
    match value {
        Some(JsValue::String(s)) => Some(JsValue::String(decode_html(&s))),
        other => other,
    }
}

/// lodash `isEmpty`: numbers and booleans have no own keys and count as empty, which
/// `$jsonld` checks separately.
fn lodash_is_empty(value: &JsValue) -> bool {
    match value {
        JsValue::Null => true,
        JsValue::Bool(_) | JsValue::Number(_) => false,
        JsValue::String(s) => s.is_empty(),
        JsValue::Array(a) => a.is_empty(),
        JsValue::Object(o) => o.is_empty(),
    }
}

/// lodash `get(object, path)` with a dotted path; a key that holds the whole path wins.
pub fn get<'a>(object: &'a JsValue, path: &str) -> Option<&'a JsValue> {
    if let Some(value) = object.get(path) {
        return Some(value);
    }
    let mut current = object;
    for key in path.split('.') {
        current = match current {
            JsValue::Object(_) => current.get(key)?,
            JsValue::Array(values) => values.get(key.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(current)
}

/// `parseJSON`: `JSON.parse`, then `JSON.parse(jsonrepair(text))`, else nothing.
fn parse_json(text: &str) -> Option<JsValue> {
    json::parse(text)
        .ok()
        .or_else(|| json::parse(&repair(text)?).ok())
}

/// The repairs of `jsonrepair` 3.13.2 that JSON-LD on web pages needs: comments (which also
/// covers `//<![CDATA[` wrappers), raw control characters and single quotes in strings, unquoted
/// keys, Python constants, trailing commas, missing commas between values, and missing closing
/// brackets at the end. Anything else gives `None`, where jsonrepair may still repair it.
fn repair(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() + 16);
    let mut closers: Vec<char> = Vec::new();
    // A value just ended, so the next value needs a comma first.
    let mut after_value = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '/' if chars.get(i + 1) == Some(&'/') => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            '/' if chars.get(i + 1) == Some(&'*') => {
                i += 2;
                while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                    i += 1;
                }
                i += 2;
                continue;
            }
            c if c.is_whitespace() => {
                i += 1;
                continue;
            }
            ',' => {
                after_value = false;
                let next = chars[i + 1..].iter().find(|c| !c.is_whitespace()).copied();
                if !matches!(next, Some('}' | ']') | None) {
                    out.push(',');
                }
                i += 1;
                continue;
            }
            ':' => {
                after_value = false;
                out.push(':');
                i += 1;
                continue;
            }
            '}' | ']' => {
                if closers.pop() != Some(c) {
                    return None;
                }
                out.push(c);
                after_value = true;
                i += 1;
                continue;
            }
            _ => {}
        }
        if after_value {
            out.push(',');
        }
        match c {
            '{' | '[' => {
                closers.push(if c == '{' { '}' } else { ']' });
                out.push(c);
                after_value = false;
                i += 1;
                continue;
            }
            '"' | '\'' | '\u{201c}' | '\u{2018}' => {
                i = string(&chars, i, &mut out)?;
            }
            _ => {
                let start = i;
                while i < chars.len()
                    && (chars[i].is_alphanumeric()
                        || matches!(chars[i], '_' | '$' | '-' | '+' | '.'))
                {
                    i += 1;
                }
                if i == start {
                    return None;
                }
                let word: String = chars[start..i].iter().collect();
                match word.as_str() {
                    "true" | "True" => out.push_str("true"),
                    "false" | "False" => out.push_str("false"),
                    "null" | "None" | "undefined" => out.push_str("null"),
                    _ if word.parse::<f64>().is_ok() && !word.starts_with(['+', '.']) => {
                        out.push_str(&word)
                    }
                    _ if closers.last() == Some(&'}') => {
                        out.push_str(&serde_json::to_string(&word).ok()?)
                    }
                    _ => return None,
                }
            }
        }
        after_value = true;
    }
    while let Some(closer) = closers.pop() {
        out.push(closer);
    }
    Some(out)
}

/// Copies the string starting at `chars[start]` as a JSON string; returns the index after it.
/// An unterminated string ends at the end of the text.
fn string(chars: &[char], start: usize, out: &mut String) -> Option<usize> {
    let close = match chars[start] {
        '\u{201c}' => '\u{201d}',
        '\u{2018}' => '\u{2019}',
        quote => quote,
    };
    out.push('"');
    let mut i = start + 1;
    while i < chars.len() {
        let c = chars[i];
        if c == close {
            out.push('"');
            return Some(i + 1);
        }
        match c {
            '\\' => {
                let next = *chars.get(i + 1)?;
                if next == '\'' {
                    out.push('\'');
                } else {
                    out.push('\\');
                    out.push(next);
                }
                i += 2;
                continue;
            }
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
        i += 1;
    }
    out.push('"');
    Some(i)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repaired(text: &str) -> JsValue {
        parse_json(text).expect("repairs")
    }

    #[test]
    fn repairs_what_pages_break() {
        assert_eq!(
            repaired("{\"a\": \"line\nbreak\", 'b': [1, 2,], c: True, /* x */}"),
            json::parse(r#"{"a":"line\nbreak","b":[1,2],"c":true}"#).unwrap()
        );
        assert_eq!(
            repaired("//<![CDATA[\n{\"a\": 1}\n//]]>"),
            json::parse(r#"{"a":1}"#).unwrap()
        );
        assert_eq!(
            repaired("{\"a\": {\"b\": 1"),
            json::parse(r#"{"a":{"b":1}}"#).unwrap()
        );
    }

    #[test]
    fn get_follows_lodash() {
        let item = json::parse(r#"{"image":[{"url":"x"}],"a.b":1}"#).unwrap();
        assert_eq!(
            get(&item, "image.0.url"),
            Some(&JsValue::String("x".into()))
        );
        assert_eq!(get(&item, "image.url"), None);
        assert_eq!(get(&item, "a.b"), Some(&JsValue::Number(1.0)));
    }
}
