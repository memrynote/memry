//! `wrapRawLatexDelimiters(element, doc)`: raw `$...$`, `$$...$$`, `\(...\)` and `\[...\]`
//! LaTeX in text becomes `<math>` elements for the math rules.
//!
//! It runs only when a MathJax or KaTeX script is present in the document, so that pages that
//! use `$` for currency are left alone.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::{Document, NodeId, NodeKind};
use crate::web::extract::elements::rule::attr_or_empty;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::{WS, WS_BODY, trim};

use super::base::MATH_FAST_CHECK;

/// `LATEX_DELIM_RE`, in alternation order: `$$..$$`, `\[..\]`, `$..$`, `\(..\)`.
static LATEX_DELIM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^{WS_BODY}$][^$]*[^{WS_BODY}$]|[^{WS_BODY}$])\$|\\\(([\s\S]+?)\\\)"
    ))
    .expect("static pattern")
});
/// `/MathJax\s*[.=]/`.
static MATHJAX_CONFIG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"MathJax{WS}*[.=]")).expect("static pattern"));
/// `LATEX_CMD_RE` and `LATEX_STRUCT_RE`.
static LATEX_CMD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\[a-zA-Z]").expect("static pattern"));
const SKIP_TAGS: &[&str] = &["PRE", "CODE", "SCRIPT", "STYLE", "MATH", "SVG", "TEXTAREA"];

enum Part {
    Text(String),
    Math { latex: String, is_block: bool },
}

/// `containsLatexCommand(s)`.
fn contains_latex_command(s: &str) -> bool {
    LATEX_CMD.is_match(s) || s.contains(['_', '^', '{', '}'])
}

/// `hasMathLibrary(doc)`: a MathJax or KaTeX script src, or a MathJax config object.
fn has_math_library(doc: &Document, source: NodeId) -> Result<bool, ExtractError> {
    for script in doc.query_selector_all(source, "script[src]")? {
        let src = attr_or_empty(doc, script, "src").to_lowercase();
        if src.contains("mathjax") || src.contains("katex") {
            return Ok(true);
        }
    }
    for script in doc.query_selector_all(source, "script:not([src])")? {
        let text = doc.text_content(script).unwrap_or_default();
        if MATHJAX_CONFIG.is_match(&text) || text.to_ascii_lowercase().contains("katex") {
            return Ok(true);
        }
    }
    Ok(false)
}

fn collect_text_nodes(doc: &Document, node: NodeId, out: &mut Vec<NodeId>) {
    match doc.node(node).kind {
        NodeKind::Element(_)
            if SKIP_TAGS.contains(&doc.tag_name(node).unwrap_or_default().as_str()) => {}
        NodeKind::Text(_) => out.push(node),
        _ => {
            let mut child = doc.first_child(node);
            while let Some(c) = child {
                collect_text_nodes(doc, c, out);
                child = doc.next_sibling(c);
            }
        }
    }
}

/// `wrapRawLatexDelimiters(element, doc)`; `source` is the `doc` whose scripts decide.
pub fn wrap_raw_latex_delimiters(
    doc: &mut Document,
    element: NodeId,
    source: NodeId,
) -> Result<(), ExtractError> {
    if !has_math_library(doc, source)? {
        return Ok(());
    }
    // Rendered math is the math rules' business.
    if doc.query_selector(element, MATH_FAST_CHECK)?.is_some() {
        return Ok(());
    }
    let mut text_nodes = Vec::new();
    collect_text_nodes(doc, element, &mut text_nodes);
    for text_node in text_nodes {
        let text = doc.text_content(text_node).unwrap_or_default();
        if !text.contains('$') && !text.contains("\\(") && !text.contains("\\[") {
            continue;
        }
        let mut parts: Vec<Part> = Vec::new();
        let mut last_index = 0;
        let mut has_block_math = false;
        for caps in LATEX_DELIM.captures_iter(&text) {
            let whole = caps.get(0).unwrap_or_else(|| unreachable!());
            let block = caps.get(1).or_else(|| caps.get(2));
            let inline = caps.get(3).or_else(|| caps.get(4));
            let is_block = block.is_some();
            let latex = trim(block.or(inline).map_or("", |m| m.as_str())).to_string();
            // Backslash delimiters are unambiguous; dollar signs need the heuristic.
            let is_backslash_delim = caps.get(2).is_some() || caps.get(4).is_some();
            if !is_backslash_delim && !contains_latex_command(&latex) {
                continue;
            }
            if last_index < whole.start() {
                parts.push(Part::Text(text[last_index..whole.start()].to_string()));
            }
            has_block_math |= is_block;
            parts.push(Part::Math { latex, is_block });
            last_index = whole.end();
        }
        if parts.is_empty() {
            continue;
        }
        if last_index < text.len() {
            parts.push(Part::Text(text[last_index..].to_string()));
        }
        // `$$..$$` is block only when the text node is the sole content of its parent.
        if has_block_math {
            let has_surrounding_text = parts
                .iter()
                .any(|p| matches!(p, Part::Text(t) if !trim(t).is_empty()));
            let parent_has_other_content = match doc.parent_element(text_node) {
                Some(parent) => doc.child_nodes(parent).into_iter().any(|n| {
                    n != text_node
                        && match doc.node(n).kind {
                            NodeKind::Text(_) => {
                                !trim(&doc.text_content(n).unwrap_or_default()).is_empty()
                            }
                            NodeKind::Element(_) => true,
                            _ => false,
                        }
                }),
                None => false,
            };
            if has_surrounding_text || parent_has_other_content {
                for part in &mut parts {
                    if let Part::Math { is_block, .. } = part {
                        *is_block = false;
                    }
                }
            }
        }
        let fragment = doc.create_document_fragment();
        for part in parts {
            match part {
                Part::Text(t) => {
                    let node = doc.create_text_node(&t);
                    doc.append_child(fragment, node)?;
                }
                Part::Math { latex, is_block } => {
                    let math = doc.create_element("math");
                    doc.set_attribute(math, "xmlns", "http://www.w3.org/1998/Math/MathML");
                    doc.set_attribute(math, "display", if is_block { "block" } else { "inline" });
                    doc.set_attribute(math, "data-latex", &latex);
                    doc.set_text_content(math, &latex)?;
                    doc.append_child(fragment, math)?;
                }
            }
        }
        doc.replace_with(text_node, &[fragment])?;
    }
    Ok(())
}
