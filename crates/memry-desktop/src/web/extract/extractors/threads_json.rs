//! Threads comments read from the page's embedded JSON (`dist/extractors/threads.js`).

use std::collections::HashSet;

use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::comments::{Comment, build_comment_tree};
use crate::web::extract::utils::dom::escape_html;
use crate::web::extract::utils::js::utf16_slice;
use crate::web::extract::utils::json::{JsValue, parse};

use super::base::{Cx, text_of};

/// `extractTextFromJson(obj, depth)`; `Err` is a JS `TypeError`.
fn text_from_json(obj: &JsValue, depth: usize) -> Result<Option<String>, ExtractError> {
    if depth > 10 || !obj.is_object_like() {
        return Ok(None);
    }
    if let Some(fragments) = obj
        .get("text_fragments")
        .and_then(|t| t.get("fragments"))
        .filter(|f| f.truthy())
    {
        let JsValue::Array(items) = fragments else {
            return Err(ExtractError::Js(
                "TypeError: fragments.map is not a function".into(),
            ));
        };
        let mut text = String::new();
        for f in items {
            if matches!(f, JsValue::Null) {
                return Err(ExtractError::Js("TypeError: f is null".into()));
            }
            if let Some(p) = f.get("plaintext").filter(|p| p.truthy()) {
                text.push_str(&p.to_js_string());
            } else if let Some(u) = f
                .get("mention_fragment")
                .and_then(|m| m.get("username"))
                .filter(|u| u.truthy())
            {
                text.push_str(&format!("@{}", u.to_js_string()));
            } else if let Some(l) = f.get("linkified_web_url").filter(|l| l.truthy()) {
                text.push_str(&l.to_js_string());
            }
        }
        return Ok(Some(text));
    }
    for child in json_children(obj) {
        if let Some(text) = text_from_json(child, depth + 1)?.filter(|t| !t.is_empty()) {
            return Ok(Some(text));
        }
    }
    Ok(None)
}

/// The values of `Object.keys(obj)` in order, without `quoted_post`.
fn json_children(obj: &JsValue) -> Vec<&JsValue> {
    match obj {
        JsValue::Array(items) => items.iter().collect(),
        JsValue::Object(entries) => entries
            .iter()
            .filter(|(k, _)| k != "quoted_post")
            .map(|(_, v)| v)
            .collect(),
        _ => Vec::new(),
    }
}

fn posts_in_json(
    obj: &JsValue,
    depth: usize,
    out: &mut Vec<(String, String)>,
) -> Result<(), ExtractError> {
    if depth > 35 || !obj.is_object_like() {
        return Ok(());
    }
    if let Some(JsValue::String(name)) = obj.get("user").and_then(|u| u.get("username"))
        && !name.is_empty()
        && let Some(text) = text_from_json(obj, 0)?.filter(|t| !t.is_empty())
    {
        out.push((name.clone(), text));
    }
    for child in json_children(obj) {
        posts_in_json(child, depth + 1, out)?;
    }
    Ok(())
}

pub(super) fn comments_from_json(cx: &Cx, main_author: &str) -> Result<String, ExtractError> {
    let mut all: Vec<(String, String)> = Vec::new();
    let mut seen = HashSet::new();
    for script in cx.qsa(r#"script[type="application/json"]"#)? {
        let raw = text_of(cx.doc, script);
        if raw.matches("\"text_fragments\"").count() < 2 || !raw.contains("\"username\"") {
            continue;
        }
        let Ok(data) = parse(&raw) else { continue };
        let mut found = Vec::new();
        if posts_in_json(&data, 0, &mut found).is_err() {
            continue;
        }
        for (user, text) in found {
            let key = format!("{user}:{}", utf16_slice(&text, 0, 80));
            if seen.insert(key) {
                all.push((user, text));
            }
        }
    }
    if all.len() < 2 {
        return Ok(String::new());
    }
    let mut first = true;
    let mut data = Vec::new();
    for (user, text) in all {
        if first && user == main_author {
            first = false;
            continue;
        }
        data.push(Comment {
            author: format!("@{user}"),
            content: format!("<p>{}</p>", escape_html(&text)),
            depth: Some(0.0),
            ..Comment::default()
        });
    }
    Ok(if data.is_empty() {
        String::new()
    } else {
        build_comment_tree(&data)
    })
}
