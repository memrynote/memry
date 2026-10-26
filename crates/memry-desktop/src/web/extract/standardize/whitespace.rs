//! Text-level steps of `standardizeContent`: `&nbsp;`, comments and the whitespace clean-up of
//! `removeEmptyLines`.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::constants::INLINE_ELEMENTS;
use crate::web::extract::dom::node::node_type;
use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::dom::{is_svg_element, tag_lower};
use crate::web::extract::utils::js::{WS, is_js_whitespace};

/// `standardizeSpaces(element)`: `\xA0` becomes a space outside `pre`, `code` and SVG.
pub fn standardize_spaces(doc: &mut Document, node: NodeId) -> Result<(), ExtractError> {
    if doc.is_element(node) {
        let tag = tag_lower(doc, node);
        if tag == "pre" || tag == "code" || is_svg_element(doc, node)? {
            return Ok(());
        }
    }
    if doc.node_type(node) == node_type::TEXT {
        let text = doc.text_content(node).unwrap_or_default();
        let replaced = text.replace('\u{a0}', " ");
        if replaced != text {
            doc.set_text_content(node, &replaced)?;
        }
    }
    for child in doc.child_nodes(node) {
        standardize_spaces(doc, child)?;
    }
    Ok(())
}

/// `removeHtmlComments(element)`.
pub fn remove_html_comments(doc: &mut Document, element: NodeId) {
    let comments: Vec<NodeId> = doc
        .descendants(element)
        .into_iter()
        .filter(|&n| doc.node_type(n) == node_type::COMMENT)
        .collect();
    for comment in comments {
        doc.remove(comment);
    }
}

/// `/^[\u200C\u200B\u200D\u200E\u200F\uFEFF]*$/`: nothing but invisible characters.
fn is_invisible_only(text: &str) -> bool {
    text.chars().all(|c| {
        matches!(
            c,
            '\u{200c}' | '\u{200b}' | '\u{200d}' | '\u{200e}' | '\u{200f}' | '\u{feff}'
        )
    })
}

static NEWLINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\n\r]+").expect("static"));
static TABS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\t+").expect("static"));
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r" {2,}").expect("static"));
static SPACE_BEFORE_PUNCT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("{WS}+([,.!?:;])")).expect("static"));
static ZERO_WIDTH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("[\u{200b}\u{200d}\u{200e}\u{200f}\u{feff}]+").expect("static pattern")
});
static NBSP_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new("\u{a0}{2,}").expect("static"));

/// The regex chain `removeEmptyLines` applies to every text node.
fn clean_text(text: &str) -> String {
    let t = NEWLINES.replace_all(text, " ");
    let t = TABS.replace_all(&t, " ");
    let t = SPACES.replace_all(&t, " ");
    // `^[ ]+$`: after the step above, only a lone space is left of a spaces-only text.
    let t = if !t.is_empty() && t.chars().all(|c| c == ' ') {
        " ".into()
    } else {
        t
    };
    let t = SPACE_BEFORE_PUNCT.replace_all(&t, "$1");
    let t = ZERO_WIDTH.replace_all(&t, "");
    NBSP_RUN.replace_all(&t, "\u{a0}").into_owned()
}

/// First pass of `removeEmptyLines`: invisible text goes, the rest is collapsed.
fn remove_empty_text_nodes(doc: &mut Document, node: NodeId) -> Result<(), ExtractError> {
    if doc.is_element(node) {
        let tag = tag_lower(doc, node);
        if tag == "pre" || tag == "code" {
            return Ok(());
        }
    }
    for child in doc.child_nodes(node) {
        remove_empty_text_nodes(doc, child)?;
    }
    if doc.node_type(node) != node_type::TEXT {
        return Ok(());
    }
    let text = doc.text_content(node).unwrap_or_default();
    if text.is_empty() || is_invisible_only(&text) {
        if let Some(parent) = doc.parent_node(node) {
            doc.remove_child(parent, node)?;
        }
    } else {
        let cleaned = clean_text(&text);
        if cleaned != text {
            doc.set_text_content(node, &cleaned)?;
        }
    }
    Ok(())
}

/// `/^[\n\r\t\u200C\u200B\u200D\u200E\u200F\uFEFF]*$/`.
fn is_blank_for_inline(text: &str) -> bool {
    text.chars().all(|c| {
        matches!(
            c,
            '\n' | '\r'
                | '\t'
                | '\u{200c}'
                | '\u{200b}'
                | '\u{200d}'
                | '\u{200e}'
                | '\u{200f}'
                | '\u{feff}'
        )
    })
}

fn text_of(doc: &Document, node: NodeId) -> String {
    doc.text_content(node).unwrap_or_default()
}

fn is_text(doc: &Document, node: NodeId) -> bool {
    doc.node_type(node) == node_type::TEXT
}

/// `moveWhitespaceOutside(node, doc, direction)`: leading or trailing whitespace of an inline
/// element's edge text moves to a space just outside it.
fn move_whitespace_outside(
    doc: &mut Document,
    node: NodeId,
    leading: bool,
) -> Result<(), ExtractError> {
    let child = if leading {
        doc.first_child(node)
    } else {
        doc.last_child(node)
    };
    let Some(child) = child.filter(|&c| is_text(doc, c)) else {
        return Ok(());
    };
    let text = text_of(doc, child);
    let trimmed = if leading {
        text.trim_start_matches(is_js_whitespace)
    } else {
        text.trim_end_matches(is_js_whitespace)
    };
    let Some(parent) = doc.parent_node(node) else {
        return Ok(());
    };
    if trimmed == text {
        return Ok(());
    }
    doc.set_text_content(child, trimmed)?;
    let neighbor = if leading {
        doc.previous_sibling(node)
    } else {
        doc.next_sibling(node)
    };
    let has_space = neighbor.is_some_and(|n| {
        is_text(doc, n)
            && if leading {
                text_of(doc, n).ends_with(' ')
            } else {
                text_of(doc, n).starts_with(' ')
            }
    });
    if !has_space {
        let before = if leading {
            Some(node)
        } else {
            doc.next_sibling(node)
        };
        let space = doc.create_text_node(" ");
        doc.insert_before(parent, space, before)?;
    }
    Ok(())
}

/// Second pass of `removeEmptyLines`.
///
/// `getComputedStyle(node)?.display === 'block'` is always false: linkedom's `defaultView` is
/// Node's global object, which has no `getComputedStyle`, so every element takes the inline
/// branches.
fn cleanup_empty_elements(doc: &mut Document, node: NodeId) -> Result<(), ExtractError> {
    if !doc.is_element(node) {
        return Ok(());
    }
    let tag = tag_lower(doc, node);
    if tag == "pre" || tag == "code" {
        return Ok(());
    }
    for child in doc.child_nodes(node) {
        if doc.is_element(child) {
            cleanup_empty_elements(doc, child)?;
        }
    }
    doc.normalize(node);
    while let Some(first) = doc.first_child(node).filter(|&c| is_text(doc, c)) {
        if !is_blank_for_inline(&text_of(doc, first)) {
            break;
        }
        doc.remove_child(node, first)?;
    }
    while let Some(last) = doc.last_child(node).filter(|&c| is_text(doc, c)) {
        if !is_blank_for_inline(&text_of(doc, last)) {
            break;
        }
        doc.remove_child(node, last)?;
    }
    if INLINE_ELEMENTS.contains(&tag.as_str()) && doc.parent_node(node).is_some() {
        move_whitespace_outside(doc, node, true)?;
        move_whitespace_outside(doc, node, false)?;
    }
    // A space between two children when one is an element, unless punctuation or an existing
    // space already separates them.
    let children = doc.child_nodes(node);
    for pair in children.windows(2) {
        let (current, next) = (pair[0], pair[1]);
        if !doc.is_element(current) && !doc.is_element(next) {
            continue;
        }
        let next_content = text_of(doc, next);
        let current_content = text_of(doc, current);
        let next_starts_with_punctuation = next_content
            .chars()
            .next()
            .is_some_and(|c| matches!(c, ',' | '.' | '!' | '?' | ':' | ';' | ')' | ']'));
        let current_ends_with_punctuation = current_content
            .trim_end_matches(is_js_whitespace)
            .chars()
            .next_back()
            .is_some_and(|c| matches!(c, ',' | '.' | '!' | '?' | ':' | ';' | '(' | '['));
        let has_space = (is_text(doc, current) && current_content.ends_with(' '))
            || (is_text(doc, next) && next_content.starts_with(' '));
        if !next_starts_with_punctuation && !current_ends_with_punctuation && !has_space {
            let space = doc.create_text_node(" ");
            doc.insert_before(node, space, Some(next))?;
        }
    }
    Ok(())
}

/// `removeEmptyLines(element, doc)`.
pub fn remove_empty_lines(doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
    remove_empty_text_nodes(doc, element)?;
    cleanup_empty_elements(doc, element)
}
