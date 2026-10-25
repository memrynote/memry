//! JSON-LD extraction (`_extractSchemaOrgData`) and `_getSchemaText` of `dist/defuddle.js`, plus
//! `_collectMetaTags`.

use crate::web::extract::dom::Document;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::dom::decode_html_entities;
use crate::web::extract::utils::js::is_js_whitespace;
use crate::web::extract::utils::json::{self, JsValue};

/// One `<meta>` Defuddle collects: `getAttribute` gives `null` for a missing attribute.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetaTag {
    pub name: Option<String>,
    pub property: Option<String>,
    pub content: String,
}

/// `_collectMetaTags`: every `<meta>` with a non-empty `content`.
pub fn collect_meta_tags(doc: &Document) -> Result<Vec<MetaTag>, ExtractError> {
    let mut tags = Vec::new();
    for meta in doc.query_selector_all(doc.root(), "meta")? {
        let attr = |name: &str| doc.get_attribute(meta, name).map(|v| v.into_owned());
        if let Some(content) = attr("content").filter(|c| !c.is_empty()) {
            tags.push(MetaTag {
                name: attr("name"),
                property: attr("property"),
                content: decode_html_entities(&content),
            });
        }
    }
    Ok(tags)
}

/// `_extractSchemaOrgData`: the parsed `application/ld+json` scripts, `@graph` arrays flattened,
/// as a JS array. A script that does not parse is skipped, as Defuddle logs and continues.
pub fn extract_schema_org_data(doc: &Document) -> Result<JsValue, ExtractError> {
    let mut items = Vec::new();
    for script in doc.query_selector_all(doc.root(), r#"script[type="application/ld+json"]"#)? {
        let raw = doc.text_content(script).unwrap_or_default();
        let cleaned = clean_json_ld(&raw);
        match json::parse(&cleaned) {
            Ok(JsValue::Null) => {
                tracing::debug!("schema.org script holds null; skipped");
            }
            Ok(data) => match data.get("@graph") {
                Some(JsValue::Array(graph)) => items.extend(graph.iter().cloned()),
                _ => items.push(data),
            },
            Err(reason) => tracing::debug!(%reason, "schema.org data does not parse; skipped"),
        }
    }
    Ok(JsValue::Array(
        items.into_iter().map(decode_strings).collect(),
    ))
}

/// `decodeStringsInObject`. Entity decoding is the identity (see `decode_html_entities`), so
/// what remains is the rebuild: JS assigns `newItem['__proto__'] = value`, which never creates an
/// own key. A primitive value is ignored, so dropping the key reproduces JS. An object value
/// becomes the prototype (inherited reads) and `null` leaves the object without
/// `hasOwnProperty`, which makes `getSchemaProperty` fail into its default. Neither is
/// modelled: they need JSON-LD that sets `__proto__` on purpose, which no page does.
fn decode_strings(item: JsValue) -> JsValue {
    match item {
        JsValue::String(s) => JsValue::String(decode_html_entities(&s)),
        JsValue::Array(items) => JsValue::Array(items.into_iter().map(decode_strings).collect()),
        JsValue::Object(entries) => JsValue::Object(
            entries
                .into_iter()
                .filter(|(key, _)| key != "__proto__")
                .map(|(key, value)| (key, decode_strings(value)))
                .collect(),
        ),
        other => other,
    }
}

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// The four `replace` calls and `trim` that precede `JSON.parse`:
/// `/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm`, `/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/`,
/// `/^\s*(\*\/|\/\*)\s*|\s*(\*\/|\/\*)\s*$/g`.
fn clean_json_ld(text: &str) -> String {
    let step1 = strip_comments(text);
    let step2 = unwrap_cdata(&step1);
    let step3 = strip_edge_comment_markers(&step2);
    crate::web::extract::utils::js::trim(&step3).to_string()
}

fn skip_whitespace(chars: &[char], mut at: usize) -> usize {
    while at < chars.len() && is_js_whitespace(chars[at]) {
        at += 1;
    }
    at
}

/// `/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm`: a block comment, or a line comment that starts at a line
/// start. `\s*` may run over blank lines, so the match begins at the line start, not at `//`.
fn strip_comments(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '/'
            && chars.get(i + 1) == Some(&'*')
            && let Some(end) = (i + 2..chars.len().saturating_sub(1))
                .find(|&k| chars[k] == '*' && chars[k + 1] == '/')
        {
            i = end + 2;
            continue;
        }
        if i == 0 || is_line_terminator(chars[i - 1]) {
            let at = skip_whitespace(&chars, i);
            if chars.get(at) == Some(&'/') && chars.get(at + 1) == Some(&'/') {
                let mut end = at + 2;
                while end < chars.len() && !is_line_terminator(chars[end]) {
                    end += 1;
                }
                i = end;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// `/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/` replaced by its capture: the lazy capture ends at the
/// first `]]>` that only whitespace follows.
fn unwrap_cdata(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let start = skip_whitespace(&chars, 0);
    let open: Vec<char> = "<![CDATA[".chars().collect();
    if chars.len() < start + open.len() || chars[start..start + open.len()] != open[..] {
        return text.to_string();
    }
    let body = start + open.len();
    let mut k = body;
    while k + 3 <= chars.len() {
        if chars[k] == ']'
            && chars[k + 1] == ']'
            && chars[k + 2] == '>'
            && skip_whitespace(&chars, k + 3) == chars.len()
        {
            return chars[body..k].iter().collect();
        }
        k += 1;
    }
    text.to_string()
}

/// `/^\s*(\*\/|\/\*)\s*|\s*(\*\/|\/\*)\s*$/g` replaced by nothing: a comment marker with its
/// whitespace at the very start, or at the very end, of the text.
fn strip_edge_comment_markers(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let is_marker = |at: usize| {
        matches!(
            (chars.get(at), chars.get(at + 1)),
            (Some('*'), Some('/')) | (Some('/'), Some('*'))
        )
    };
    let mut out = String::with_capacity(text.len());
    let mut i = 0usize;
    if is_marker(skip_whitespace(&chars, 0)) {
        i = skip_whitespace(&chars, skip_whitespace(&chars, 0) + 2);
    }
    while i < chars.len() {
        let at = skip_whitespace(&chars, i);
        if is_marker(at) && skip_whitespace(&chars, at + 2) == chars.len() {
            break;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// `_getSchemaText`: the first `text` or `articleBody` string in the data, looking through
/// nested arrays and `@graph` up to ten levels deep.
pub fn get_schema_text(schema_org_data: &JsValue, depth: usize) -> String {
    if depth > 10 {
        return String::new();
    }
    let items: &[JsValue] = match schema_org_data {
        JsValue::Array(items) => items,
        JsValue::Null => return String::new(),
        single => std::slice::from_ref(single),
    };
    for item in items {
        if let JsValue::Array(_) = item {
            let found = get_schema_text(item, depth + 1);
            if !found.is_empty() {
                return found;
            }
            continue;
        }
        for key in ["text", "articleBody"] {
            if let Some(JsValue::String(text)) = item.get(key)
                && !text.is_empty()
            {
                return text.clone();
            }
        }
        if let Some(graph @ JsValue::Array(_)) = item.get("@graph") {
            let found = get_schema_text(graph, depth + 1);
            if !found.is_empty() {
                return found;
            }
        }
    }
    String::new()
}
