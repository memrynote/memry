//! Port of `standardizeContent` (`dist/standardize.js`) and the heading and callout handlers it
//! runs: the content element is rewritten into the plain structure markdown conversion expects.
//!
//! Only the non-debug path exists: the port never runs Defuddle's debug mode, which keeps
//! structure that this path flattens.
//!
//! `standardizeElements` also applies the math, code block and image rules of stages 3 and 4;
//! `elements.rs` marks where they run. Until those stages land, the oracle switches the same
//! rules off (`vectors/standardize.mjs`).

mod attributes;
mod breaks;
mod elements;
mod links;
mod lists;
mod spans;
mod svg;
mod verso;
mod whitespace;
mod wrappers;

pub use breaks::remove_orphaned_dividers;

use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::elements::headings::{
    copy_allowed_attributes, is_permalink_anchor, remove_permalink_anchors,
};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::dom::transfer_content;
use crate::web::extract::utils::js::is_js_whitespace;
use crate::web::extract::utils::text::normalize_text;

/// `standardizeContent(element, metadata, doc)` with `debug` false. `title` is the metadata
/// title.
pub fn standardize_content(
    doc: &mut Document,
    element: NodeId,
    title: &str,
) -> Result<(), ExtractError> {
    spans::standardize_drop_caps(doc, element)?;
    whitespace::standardize_spaces(doc, element)?;
    whitespace::remove_html_comments(doc, element);
    standardize_headings(doc, element, title)?;
    wrap_preformatted_code(doc, element)?;
    elements::standardize_elements(doc, element)?;
    svg::resolve_svg_colors(doc, element)?;
    wrappers::replace_custom_elements(doc, element)?;
    spans::convert_data_as_spans(doc, element)?;
    spans::convert_block_spans(doc, element)?;
    wrappers::unwrap_layout_tables(doc, element)?;
    wrappers::flatten_wrapper_elements(doc, element)?;
    remove_permalink_anchors(doc, element)?;
    attributes::strip_unwanted_attributes(doc, element)?;
    spans::unwrap_bare_spans(doc, element)?;
    links::unwrap_special_links(doc, element)?;
    for el in doc.query_selector_all(element, "object, embed, applet")? {
        doc.remove(el);
    }
    breaks::remove_empty_elements(doc, element)?;
    breaks::remove_trailing_headings(doc, element)?;
    breaks::remove_orphaned_dividers(doc, element)?;
    wrappers::flatten_wrapper_elements(doc, element)?;
    breaks::remove_orphaned_dividers(doc, element)?;
    breaks::strip_extra_br_elements(doc, element)?;
    whitespace::remove_empty_lines(doc, element)
}

/// `standardizeHeadings(element, title, doc)`: every `h1` becomes an `h2`, and a first `h2` that
/// repeats the page title goes.
fn standardize_headings(
    doc: &mut Document,
    element: NodeId,
    title: &str,
) -> Result<(), ExtractError> {
    for h1 in doc.get_elements_by_tag_name(element, "h1") {
        let h2 = doc.create_element("h2");
        transfer_content(doc, h1, h2)?;
        copy_allowed_attributes(doc, h1, h2);
        if let Some(parent) = doc.parent_node(h1) {
            doc.replace_child(parent, h2, h1)?;
        }
    }
    let h2s = doc.get_elements_by_tag_name(element, "h2");
    let Some(&first) = h2s.first() else {
        return Ok(());
    };
    // The permalink anchor text (`¶`, `#`, `§`) has not been stripped yet.
    let mut permalink_text = String::new();
    for a in doc.query_selector_all(first, "a")? {
        if is_permalink_anchor(doc, a) {
            permalink_text.push_str(&doc.text_content(a).unwrap_or_default());
        }
    }
    let text = doc.text_content(first).unwrap_or_default();
    let first_text = normalize_text(&text.replacen(&permalink_text, "", 1));
    let normalized_title = normalize_text(title);
    if !normalized_title.is_empty() && normalized_title == first_text {
        doc.remove(first);
    }
    Ok(())
}

/// `wrapPreformattedCode(element, doc)`: a `<code style="white-space: pre">` outside a `<pre>`
/// gets one, so it is treated as a code block.
fn wrap_preformatted_code(doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
    for code in doc.query_selector_all(element, "code")? {
        if doc.closest(code, "pre")?.is_some() {
            continue;
        }
        let style = doc.get_attribute(code, "style").unwrap_or_default();
        if !has_white_space_pre(&style) {
            continue;
        }
        let pre = doc.create_element("pre");
        if let Some(parent) = doc.parent_node(code) {
            doc.insert_before(parent, pre, Some(code))?;
        }
        doc.append_child(pre, code)?;
    }
    Ok(())
}

/// `/white-space\s*:\s*pre/.test(style)`.
fn has_white_space_pre(style: &str) -> bool {
    let mut rest = style;
    while let Some(at) = rest.find("white-space") {
        let after = rest[at + "white-space".len()..].trim_start_matches(is_js_whitespace);
        if let Some(value) = after.strip_prefix(':')
            && value
                .trim_start_matches(is_js_whitespace)
                .starts_with("pre")
        {
            return true;
        }
        rest = &rest[at + 1..];
    }
    false
}

#[cfg(test)]
mod tests {
    use super::has_white_space_pre;

    #[test]
    fn white_space_pre_matches_the_js_regex() {
        // `/white-space\s*:\s*pre/.test(style)` in Node.
        assert!(has_white_space_pre("x;white-space :pre-wrap"));
        assert!(!has_white_space_pre("white-space: normal"));
        assert!(has_white_space_pre("white-space-x white-space:pre"));
    }
}
