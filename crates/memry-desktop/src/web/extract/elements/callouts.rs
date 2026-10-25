//! Port of `dist/elements/callouts.js`: Obsidian, GitHub, aside, admonition and Bootstrap
//! callouts become one `div.callout` shape.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::dom::transfer_content;
use crate::web::extract::utils::js::{WS, trim};

/// `/display\s*:\s*none\s*;?/gi`; `i` without `u` folds ASCII only.
static DISPLAY_NONE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!("(?i-u:display){WS}*:{WS}*(?i-u:none){WS}*;?")).expect("static pattern")
});

const ADMONITION_TYPES: &[&str] = &[
    "info",
    "warning",
    "note",
    "tip",
    "danger",
    "caution",
    "important",
    "abstract",
    "success",
    "question",
    "failure",
    "bug",
    "example",
    "quote",
];

/// `type.charAt(0).toUpperCase() + type.slice(1)`. `charAt(0)` is a UTF-16 unit, so an astral
/// first character is a lone surrogate that upper-cases to itself and rejoins its other half.
fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) if first.len_utf16() == 1 => {
            let mut out: String = first.to_uppercase().collect();
            out.push_str(chars.as_str());
            out
        }
        _ => text.to_string(),
    }
}

/// `createCallout(doc, type, title, contentSource)`.
fn create_callout(
    doc: &mut Document,
    kind: &str,
    title: &str,
    content_source: NodeId,
) -> Result<NodeId, ExtractError> {
    let callout = doc.create_element("div");
    doc.set_attribute(callout, "data-callout", kind);
    doc.set_attribute(callout, "class", "callout");
    let title_div = doc.create_element("div");
    doc.set_attribute(title_div, "class", "callout-title");
    let title_inner = doc.create_element("div");
    doc.set_attribute(title_inner, "class", "callout-title-inner");
    doc.set_text_content(title_inner, title)?;
    doc.append_child(title_div, title_inner)?;
    doc.append_child(callout, title_div)?;
    let content_div = doc.create_element("div");
    doc.set_attribute(content_div, "class", "callout-content");
    transfer_content(doc, content_source, content_div)?;
    doc.append_child(callout, content_div)?;
    Ok(callout)
}

/// `textContent?.trim() || fallback`.
fn trimmed_text_or(doc: &Document, el: Option<NodeId>, fallback: String) -> String {
    let text = el
        .and_then(|e| doc.text_content(e))
        .map(|t| trim(&t).to_string())
        .unwrap_or_default();
    if text.is_empty() { fallback } else { text }
}

/// The first class of `el` that starts with `prefix` and passes `keep`.
fn class_with_prefix(
    doc: &Document,
    el: NodeId,
    prefix: &str,
    keep: impl Fn(&str) -> bool,
) -> Option<String> {
    doc.class_list(el)
        .into_iter()
        .find(|c| c.starts_with(prefix) && keep(c))
}

/// `standardizeCallouts(element)`.
pub fn standardize_callouts(doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
    // Obsidian Publish: collapsed callouts are expanded so the hidden-element step keeps their
    // content, and the fold state moves to `data-callout-fold`.
    for el in doc.query_selector_all(element, ".callout.is-collapsed, .callout.is-collapsible")? {
        let is_collapsed = doc.class_list_contains(el, "is-collapsed");
        doc.class_list_remove(el, &["is-collapsed", "is-collapsible"]);
        if !doc.has_attribute(el, "data-callout-fold") {
            doc.set_attribute(
                el,
                "data-callout-fold",
                if is_collapsed { "-" } else { "+" },
            );
        }
        if let Some(fold) = doc.query_selector(el, ".callout-fold")? {
            doc.remove(fold);
        }
        // A collapsed callout may carry an inline display:none on its content.
        if let Some(content) = doc.query_selector(el, ".callout-content")?
            && let Some(style) = doc.get_attribute(content, "style").map(|s| s.into_owned())
            && !style.is_empty()
        {
            let cleaned = DISPLAY_NONE.replace_all(&style, "");
            let cleaned = trim(&cleaned);
            if cleaned.is_empty() {
                doc.remove_attribute(content, "style");
            } else {
                doc.set_attribute(content, "style", cleaned);
            }
        }
    }

    // GitHub alerts.
    for el in doc.query_selector_all(element, ".markdown-alert")? {
        let kind = class_with_prefix(doc, el, "markdown-alert-", |c| c != "markdown-alert")
            .map(|c| c.replacen("markdown-alert-", "", 1))
            .unwrap_or_else(|| "note".to_string());
        let title = capitalize(&kind);
        if let Some(title_el) = doc.query_selector(el, ".markdown-alert-title")? {
            doc.remove(title_el);
        }
        let callout = create_callout(doc, &kind, &title, el)?;
        doc.replace_with(el, &[callout])?;
    }

    // Callout asides.
    for el in doc.query_selector_all(element, "aside[class*=\"callout\"]")? {
        let kind = class_with_prefix(doc, el, "callout-", |_| true)
            .map(|c| c.replacen("callout-", "", 1))
            .unwrap_or_else(|| "note".to_string());
        let title = capitalize(&kind);
        let content = doc.query_selector(el, ".callout-content")?.unwrap_or(el);
        let callout = create_callout(doc, &kind, &title, content)?;
        doc.replace_with(el, &[callout])?;
    }

    // Hugo and Docsy admonitions.
    for el in doc.query_selector_all(element, ".admonition")? {
        if doc
            .get_attribute(el, "data-callout")
            .is_some_and(|v| !v.is_empty())
        {
            continue;
        }
        let kind = doc
            .class_list(el)
            .into_iter()
            .find(|c| ADMONITION_TYPES.contains(&c.as_str()))
            .unwrap_or_else(|| "note".to_string());
        let title_el = doc.query_selector(el, ".admonition-title")?;
        let title = trimmed_text_or(doc, title_el, capitalize(&kind));
        if let Some(title_el) = title_el {
            doc.remove(title_el);
        }
        let content = match doc.query_selector(el, ".admonition-content")? {
            Some(c) => c,
            None => doc.query_selector(el, ".details-content")?.unwrap_or(el),
        };
        let callout = create_callout(doc, &kind, &title, content)?;
        doc.replace_with(el, &[callout])?;
    }

    // Bootstrap alerts.
    for el in doc.query_selector_all(element, ".alert[class*=\"alert-\"]")? {
        let kind = class_with_prefix(doc, el, "alert-", |c| c != "alert-dismissible")
            .map(|c| c.replacen("alert-", "", 1))
            .unwrap_or_else(|| "note".to_string());
        let title_el = doc.query_selector(el, ".alert-heading, .alert-title")?;
        let title = trimmed_text_or(doc, title_el, capitalize(&kind));
        if let Some(title_el) = title_el {
            doc.remove(title_el);
        }
        let callout = create_callout(doc, &kind, &title, el)?;
        doc.replace_with(el, &[callout])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::capitalize;

    #[test]
    fn capitalizes_the_first_utf16_unit() {
        // Values read from Node: `t.charAt(0).toUpperCase() + t.slice(1)`.
        assert_eq!(capitalize("note"), "Note");
        assert_eq!(capitalize("ßeta"), "SSeta");
        assert_eq!(capitalize("\u{1f600}x"), "\u{1f600}x");
        assert_eq!(capitalize(""), "");
    }
}
