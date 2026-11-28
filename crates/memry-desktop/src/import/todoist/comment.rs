//! `commentToMarkdown` (`packages/importers/src/todoist/attachments.ts`): a Todoist comment row
//! as the markdown appended to its task's description.

use memry_core::markdown::frontmatter::{is_js_whitespace, js_trim, number_to_string};
use serde_json::{Map, Value};

/// An attachment token `[[file {json}]]` becomes `[name](url)`; any other comment is its
/// trimmed text.
pub(super) fn comment_to_markdown(content: &str) -> String {
    let text = js_trim(content);
    match attachment(text) {
        Some((name, url)) => format!("[{name}]({url})"),
        None => text.to_owned(),
    }
}

/// `parseAttachmentToken`: `^\[\[file\s+(\{[\s\S]*\})\]\]$`, then `JSON.parse` of the braces.
fn attachment(text: &str) -> Option<(String, String)> {
    let rest = text.strip_prefix("[[file")?;
    let json = rest.trim_start_matches(is_js_whitespace);
    if json.len() == rest.len() || !json.starts_with('{') {
        return None;
    }
    let json = json.strip_suffix("]]").filter(|json| json.ends_with('}'))?;
    let Ok(Value::Object(fields)) = serde_json::from_str::<Value>(json) else {
        return None;
    };
    let url = present(&fields, "file_url").or_else(|| present(&fields, "image"))?;
    if !truthy(url) {
        return None;
    }
    let name = present(&fields, "file_name").map_or_else(|| "attachment".to_owned(), js_string);
    Some((name, js_string(url)))
}

/// A field `??` passes on: present and not null.
fn present<'v>(fields: &'v Map<String, Value>, key: &str) -> Option<&'v Value> {
    fields.get(key).filter(|value| !value.is_null())
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `String(value)` of a parsed JSON value, as a template literal writes it.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(n) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        // `Array#join(',')`: a null element is empty.
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                item => js_string(item),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}
