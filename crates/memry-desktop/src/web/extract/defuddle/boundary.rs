//! Port of `dist/content-boundary.js`: where the prose body of an article starts.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::position::POSITION_DISCONNECTED;
use crate::web::extract::dom::position::POSITION_FOLLOWING;
use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::{is_js_whitespace, trim, utf16_len};
use crate::web::extract::utils::text::{count_words, normalize_text};

/// JS `\s`.
const WS: &str = r"[\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]";
const MONTH: &str = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";

/// `DATE_PATTERN`, case-insensitive over ASCII as a JS regex without the `u` flag is.
static DATE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?:(?i-u:(?:{MONTH})[a-z]*){WS}+[0-9]{{1,2}}|[0-9]{{1,2}}(?i-u:(?:st|nd|rd|th)?){WS}+(?i-u:(?:{MONTH})[a-z]*)|[0-9]{{4}}[-/][0-9]{{1,2}}[-/][0-9]{{1,2}})"
    ))
    .expect("static pattern")
});

/// `HIDDEN_CLASS_RE`.
static HIDDEN_CLASS_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)(?:isHidden(?:-[A-Za-z0-9_]+)?|is-hidden)(?-u:\b)")
        .expect("static pattern")
});

const CANDIDATE_TAGS: &[&str] = &["P", "DIV", "SECTION", "ARTICLE", "BLOCKQUOTE", "FONT"];
/// Leaf-like candidates beat container candidates, so a wrapper whose text qualifies does not
/// outvote the real paragraph.
const LEAF_CANDIDATE_TAGS: &[&str] = &["P", "BLOCKQUOTE", "FONT"];
const DIALOG_SELECTOR: &str = r#"[role="dialog"], [role="alertdialog"]"#;
const SKIP_ANCESTOR_SELECTOR: &str =
    r#"aside, nav, header, footer, form, [role="dialog"], [role="alertdialog"]"#;
const PROSE_MIN_WORDS: usize = 7;

fn find_title_element(
    doc: &Document,
    main: NodeId,
    title: &str,
) -> Result<Option<NodeId>, ExtractError> {
    let normalized = normalize_text(title);
    if normalized.is_empty() {
        return Ok(None);
    }
    for heading in doc.query_selector_all(main, "h1, h2")? {
        if normalize_text(&doc.text_content(heading).unwrap_or_default()) == normalized {
            return Ok(Some(heading));
        }
    }
    Ok(None)
}

fn link_text_length(doc: &Document, el: NodeId) -> Result<usize, ExtractError> {
    let mut length = 0;
    for a in doc.query_selector_all(el, "a")? {
        length += utf16_len(&doc.text_content(a).unwrap_or_default());
    }
    Ok(length)
}

/// `/^by\s+\S/i`.
fn is_byline(text: &str) -> bool {
    let mut chars = text.chars();
    if !(chars.next().is_some_and(|c| c.eq_ignore_ascii_case(&'b'))
        && chars.next().is_some_and(|c| c.eq_ignore_ascii_case(&'y')))
    {
        return false;
    }
    let rest = &text[2..];
    let after = rest.trim_start_matches(is_js_whitespace);
    after.len() < rest.len() && !after.is_empty()
}

fn is_prose_block(doc: &Document, el: NodeId) -> Result<bool, ExtractError> {
    let Some(tag) = doc.tag_name(el) else {
        return Ok(false);
    };
    if !CANDIDATE_TAGS.contains(&tag.as_str()) {
        return Ok(false);
    }
    if doc.closest(el, SKIP_ANCESTOR_SELECTOR)?.is_some() {
        return Ok(false);
    }
    // An SVG element's `className` is an object, not a string.
    let svg = doc.element(el).is_some_and(|e| e.svg);
    let class_name = if svg {
        String::new()
    } else {
        doc.class_name(el)
    };
    if HIDDEN_CLASS_RE.is_match(&class_name) {
        return Ok(false);
    }
    // A dialog in the subtree pollutes textContent with modal copy, a script or style with source.
    if doc.query_selector(el, DIALOG_SELECTOR)?.is_some()
        || doc.query_selector(el, "script, style")?.is_some()
    {
        return Ok(false);
    }
    let text = trim(&doc.text_content(el).unwrap_or_default()).to_string();
    if text.is_empty() {
        return Ok(false);
    }
    let words = count_words(&text);
    if words < PROSE_MIN_WORDS || !text.contains(['.', '!', '?']) {
        return Ok(false);
    }
    // "By Jane Smith, reporter" is a byline; real prose starting with "By" is longer.
    if is_byline(&text) && words < 15 {
        return Ok(false);
    }
    if DATE_PATTERN.is_match(&text) && words < 20 {
        return Ok(false);
    }
    if link_text_length(doc, el)? as f64 > utf16_len(&text) as f64 * 0.7 {
        return Ok(false);
    }
    // A div whose text comes from spans and labels (cookie banners, button groups) can pass the
    // word bar without holding prose.
    if tag == "DIV" && doc.query_selector(el, "p")?.is_none() {
        return Ok(false);
    }
    Ok(true)
}

/// `findContentStart(mainContent, title)`: the first prose-length block, or `None`.
///
/// Defuddle sets `walker.currentNode` to the title heading to start after it. linkedom's
/// `TreeWalker` lists its nodes when it is created and `nextNode` ignores `currentNode`, so the
/// walk always starts at the top of `main` and the title only triggers the retry without it.
pub fn find_content_start(
    doc: &Document,
    main: NodeId,
    title: &str,
) -> Result<Option<NodeId>, ExtractError> {
    let anchored = find_title_element(doc, main, title)?.is_some();

    let mut container_hit = None;
    for node in doc.descendants(main) {
        if !doc.is_element(node) || !is_prose_block(doc, node)? {
            continue;
        }
        let tag = doc.tag_name(node).unwrap_or_default();
        if LEAF_CANDIDATE_TAGS.contains(&tag.as_str()) {
            return Ok(Some(node));
        }
        if container_hit.is_none() {
            container_hit = Some(node);
        }
    }
    if let Some(mut result) = container_hit {
        // Drill down through wrapper containers while exactly one child qualifies.
        loop {
            let mut qualifying = None;
            let mut multiple = false;
            for child in doc.children(result) {
                if is_prose_block(doc, child)? {
                    if qualifying.is_some() {
                        multiple = true;
                        break;
                    }
                    qualifying = Some(child);
                }
            }
            match qualifying {
                Some(child) if !multiple => result = child,
                _ => break,
            }
        }
        return Ok(Some(result));
    }
    if anchored {
        return find_content_start(doc, main, "");
    }
    Ok(None)
}

/// `isAboveContentStart(el, boundary)`: `el` precedes `boundary` in document order. A missing
/// boundary or a detached node reads as "don't know", which is false.
pub fn is_above_content_start(doc: &Document, el: NodeId, boundary: Option<NodeId>) -> bool {
    let Some(boundary) = boundary else {
        return false;
    };
    if el == boundary {
        return false;
    }
    let position = doc.compare_document_position(el, boundary);
    position & POSITION_DISCONNECTED == 0 && position & POSITION_FOLLOWING != 0
}
