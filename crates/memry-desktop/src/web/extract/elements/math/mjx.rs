//! MathJax v3 CHTML (`mjx-*`) to MathML reconstruction (`reconstructMathMLFromMjx`).
//!
//! When MathJax renders with CHTML and the page ships no assistive MathML, the `mjx-*` tree is
//! all that is left. It mirrors MathML closely: token tags (`mjx-mi`, `mjx-mo`) and structural
//! tags (`mjx-mfrac`, `mjx-msub`) map back by dropping the prefix, glyphs live in `mjx-c`, and
//! the rest are layout wrappers.

use unicode_normalization::UnicodeNormalization;

use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::elements::rule::attr;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::dom::tag_lower;

use super::base::MathData;

const TOKEN_TAGS: &[&str] = &["mi", "mo", "mn", "mtext", "ms", "mspace", "mglyph"];
const STRUCTURAL_TAGS: &[&str] = &[
    "mrow",
    "mstyle",
    "mpadded",
    "mphantom",
    "menclose",
    "merror",
    "mtable",
    "mtr",
    "mtd",
    "mlabeledtr",
];
const DROP_TAGS: &[&str] = &[
    "mjx-nstrut",
    "mjx-dstrut",
    "mjx-strut",
    "mjx-line",
    "mjx-spacer",
    "mjx-break",
    "mjx-mark",
];

/// `normalizeMathGlyphs(s)`: NFKC folds the Mathematical Alphanumeric block back to plain
/// letters, and the invisible operators go.
fn normalize_math_glyphs(s: &str) -> String {
    s.nfkc()
        .filter(|c| !matches!(c, '\u{2061}' | '\u{2062}' | '\u{2063}' | '\u{2064}'))
        .collect()
}

fn text_of(doc: &Document, node: NodeId) -> String {
    doc.text_content(node).unwrap_or_default()
}

fn direct_child(doc: &Document, node: NodeId, tag: &str) -> Option<NodeId> {
    doc.children(node)
        .into_iter()
        .find(|&c| tag_lower(doc, c) == tag)
}

/// `flattenMjxChildren(node, doc, skip)`.
fn flatten_children(
    doc: &mut Document,
    node: Option<NodeId>,
    skip: Option<NodeId>,
) -> Result<Vec<NodeId>, ExtractError> {
    let Some(node) = node else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for child in doc.children(node) {
        if Some(child) == skip {
            continue;
        }
        out.extend(convert_node(doc, child)?);
    }
    Ok(out)
}

/// `wrapParts(parts, doc)`: one node per MathML slot; several (or none) go in an `mrow`.
fn wrap_parts(doc: &mut Document, parts: Vec<NodeId>) -> Result<NodeId, ExtractError> {
    if let [only] = parts.as_slice() {
        return Ok(*only);
    }
    let mrow = doc.create_element("mrow");
    for part in parts {
        doc.append_child(mrow, part)?;
    }
    Ok(mrow)
}

/// `buildEl(name, children, doc)`.
fn build_el(doc: &mut Document, name: &str, children: Vec<NodeId>) -> Result<NodeId, ExtractError> {
    let el = doc.create_element(name);
    for child in children {
        doc.append_child(el, child)?;
    }
    Ok(el)
}

/// `convertMjxNode(node, doc)`.
fn convert_node(doc: &mut Document, node: NodeId) -> Result<Vec<NodeId>, ExtractError> {
    let tag = tag_lower(doc, node);
    if tag == "mjx-c" {
        let text = normalize_math_glyphs(&text_of(doc, node));
        return Ok(if text.is_empty() {
            Vec::new()
        } else {
            vec![doc.create_text_node(&text)]
        });
    }
    if DROP_TAGS.contains(&tag.as_str()) {
        return Ok(Vec::new());
    }
    let Some(name) = tag.strip_prefix("mjx-") else {
        return Ok(Vec::new());
    };
    if TOKEN_TAGS.contains(&name) {
        let text = normalize_math_glyphs(&text_of(doc, node));
        // Tokens left empty after stripping invisible operators go.
        if text.is_empty() && name != "mspace" {
            return Ok(Vec::new());
        }
        let el = doc.create_element(name);
        if !text.is_empty() {
            doc.set_text_content(el, &text)?;
        }
        return Ok(vec![el]);
    }
    if STRUCTURAL_TAGS.contains(&name) {
        let children = flatten_children(doc, Some(node), None)?;
        return Ok(vec![build_el(doc, name, children)?]);
    }
    match name {
        "mfrac" => {
            let num_node = doc.query_selector(node, "mjx-num")?;
            let num = flatten_children(doc, num_node, None)?;
            let num = wrap_parts(doc, num)?;
            let den_node = doc.query_selector(node, "mjx-den")?;
            let den = flatten_children(doc, den_node, None)?;
            let den = wrap_parts(doc, den)?;
            Ok(vec![build_el(doc, "mfrac", vec![num, den])?])
        }
        "msqrt" => {
            // The radicand sits in mjx-box; mjx-surd holds the root glyph, implicit in MathML.
            let target = doc.query_selector(node, "mjx-box")?.unwrap_or(node);
            let children = flatten_children(doc, Some(target), None)?;
            Ok(vec![build_el(doc, "msqrt", children)?])
        }
        "msub" | "msup" => {
            let script = direct_child(doc, node, "mjx-script");
            let base = flatten_children(doc, Some(node), script)?;
            let base = wrap_parts(doc, base)?;
            let sup = flatten_children(doc, script, None)?;
            let sup = wrap_parts(doc, sup)?;
            Ok(vec![build_el(doc, name, vec![base, sup])?])
        }
        "msubsup" => {
            let script = direct_child(doc, node, "mjx-script");
            let base = flatten_children(doc, Some(node), script)?;
            let base = wrap_parts(doc, base)?;
            // CHTML stacks the script as [sup, sub]; MathML msubsup wants [base, sub, sup].
            let parts = flatten_children(doc, script, None)?;
            let (sub, sup) = if parts.len() > 1 {
                (parts[parts.len() - 1], parts[0])
            } else {
                let sub = match parts.first() {
                    Some(&p) => p,
                    None => doc.create_element("mrow"),
                };
                (sub, doc.create_element("mrow"))
            };
            Ok(vec![build_el(doc, "msubsup", vec![base, sub, sup])?])
        }
        "munder" | "mover" | "munderover" => {
            // CHTML lays limits out as [over?, box[munder[base, under?]]]; read the role
            // wrappers directly and emit MathML order.
            let base_node = doc.query_selector(node, "mjx-base")?;
            let base = flatten_children(doc, base_node, None)?;
            let base = wrap_parts(doc, base)?;
            let under_node = doc.query_selector(node, "mjx-under")?;
            let over_node = doc.query_selector(node, "mjx-over")?;
            let mut children = vec![base];
            if name != "mover" {
                let under = flatten_children(doc, under_node, None)?;
                children.push(wrap_parts(doc, under)?);
            }
            if name != "munder" {
                let over = flatten_children(doc, over_node, None)?;
                children.push(wrap_parts(doc, over)?);
            }
            Ok(vec![build_el(doc, name, children)?])
        }
        // A layout wrapper (mjx-frac, mjx-num, mjx-box, mjx-script, ...) is transparent.
        _ => flatten_children(doc, Some(node), None),
    }
}

/// `reconstructMathMLFromMjx(mjxMath, doc)`: `None` when there is nothing to recover, such as an
/// unrendered `mjx-lazy` placeholder.
pub fn reconstruct_mathml_from_mjx(
    doc: &mut Document,
    mjx_math: NodeId,
) -> Result<Option<MathData>, ExtractError> {
    let math = doc.create_element("math");
    doc.set_attribute(math, "xmlns", "http://www.w3.org/1998/Math/MathML");
    for child in doc.children(mjx_math) {
        for n in convert_node(doc, child)? {
            doc.append_child(math, n)?;
        }
    }
    if !doc.has_child_nodes(math) {
        return Ok(None);
    }
    let is_block = attr(doc, mjx_math, "display").as_deref() == Some("true");
    if is_block {
        doc.set_attribute(math, "display", "block");
    }
    Ok(Some(MathData {
        mathml: doc.outer_html(math),
        latex: None,
        is_block,
    }))
}
