//! The `math` and `katex` rules, `extractLatex` and its helpers (`dist/markdown.js:552-626`,
//! `659-800`), `handleNestedEquations` of the `table` rule and the `<math>` substitution of the
//! `figure` caption.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::NodeId;
use crate::web::extract::dom::node::node_type;
use crate::web::extract::elements::math::convert::mathml_to_latex;
use crate::web::extract::markdown::turndown::NodeInfo;
use crate::web::extract::markdown::turndown::parse::{self, Dom};
use crate::web::extract::utils::js::{is_js_whitespace, trim};

/// `MATHML_NODE_NAMES`.
const MATHML_NODE_NAMES: &[&str] = &[
    "annotation",
    "maction",
    "math",
    "menclose",
    "merror",
    "mfenced",
    "mfrac",
    "mi",
    "mmultiscripts",
    "mn",
    "mo",
    "mover",
    "mpadded",
    "mphantom",
    "mprescripts",
    "mroot",
    "mrow",
    "ms",
    "mspace",
    "msqrt",
    "mstyle",
    "msub",
    "msubsup",
    "msup",
    "mtable",
    "mtd",
    "mtext",
    "mtr",
    "munder",
    "munderover",
    "none",
    "semantics",
];

/// `COMPLEX_MATHML_NODE_NAMES`.
const COMPLEX_MATHML_NODE_NAMES: &[&str] = &[
    "menclose",
    "mfrac",
    "mmultiscripts",
    "mover",
    "mroot",
    "msqrt",
    "msub",
    "msubsup",
    "msup",
    "mtable",
    "mtd",
    "mtr",
    "munder",
    "munderover",
];

static HYPHENATED_WORDS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[a-zA-Z]{3,}-[a-zA-Z]{2,}").expect("static pattern"));
static LATEX_ENVIRONMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\begin\{[^}]+\}").expect("static pattern"));

/// `node.querySelector(...)` candidates: zest's `querySelector` also matches the context element.
fn candidates(dom: &Dom, node: NodeId) -> Vec<NodeId> {
    let mut all = vec![node];
    all.extend(dom.doc.descendants(node));
    all.into_iter().filter(|&n| dom.is_element(n)).collect()
}

/// The first `annotation[encoding="application/x-tex"]` under `node` that `accept` takes.
fn tex_annotation(dom: &Dom, node: NodeId, accept: impl Fn(NodeId) -> bool) -> Option<NodeId> {
    candidates(dom, node).into_iter().find(|&n| {
        dom.lower_name(n) == "annotation"
            && dom.attr(n, "encoding") == Some("application/x-tex")
            && accept(n)
    })
}

/// Whether `id` is in the MathML namespace: a foreign element whose chain of foreign ancestors
/// ends in `math`.
fn is_mathml_namespace(dom: &Dom, id: NodeId) -> bool {
    let foreign = |n: NodeId| dom.doc.element(n).is_some_and(|e| e.svg);
    if !foreign(id) {
        return false;
    }
    let mut root = id;
    while let Some(parent) = dom.doc.parent_node(root).filter(|&p| foreign(p)) {
        root = parent;
    }
    dom.lower_name(root) == "math"
}

fn has_mathml_children(dom: &Dom, element: NodeId) -> bool {
    dom.children(element).into_iter().any(|c| {
        is_mathml_namespace(dom, c) || MATHML_NODE_NAMES.contains(&dom.lower_name(c).as_str())
    })
}

fn has_complex_mathml_children(dom: &Dom, node: NodeId) -> bool {
    COMPLEX_MATHML_NODE_NAMES.contains(&dom.lower_name(node).as_str())
        || dom
            .children(node)
            .into_iter()
            .any(|c| has_complex_mathml_children(dom, c))
}

/// `/\\[a-zA-Z]+|[_^{}]|[$&]|\\\\|\\begin\{/`.
fn is_likely_latex_source(value: &str) -> bool {
    let chars: Vec<char> = value.chars().collect();
    chars.iter().enumerate().any(|(i, &c)| match c {
        '_' | '^' | '{' | '}' | '$' | '&' => true,
        '\\' => chars
            .get(i + 1)
            .is_some_and(|n| n.is_ascii_alphabetic() || *n == '\\'),
        _ => false,
    })
}

fn is_trustworthy_latex_attribute(value: &str, has_complex_mathml: bool) -> bool {
    if is_likely_latex_source(value) {
        return true;
    }
    let trimmed = trim(value);
    if trimmed.is_empty() || has_complex_mathml {
        return false;
    }
    !HYPHENATED_WORDS.is_match(trimmed)
}

/// `convertMathMLToLatex(element)`: `''` where the conversion throws.
fn convert_mathml_to_latex(dom: &Dom, element: NodeId) -> String {
    let mathml = dom
        .outer_html(element)
        .replace("&amp;nbsp;", "&#xA0;")
        .replace("&nbsp;", "&#xA0;");
    match mathml_to_latex(&mathml) {
        Ok(latex) => trim(&latex).to_string(),
        Err(_) => String::new(),
    }
}

/// `extractLatex(element)`.
pub fn extract_latex(dom: &Dom, element: NodeId) -> String {
    if let Some(annotation) = tex_annotation(dom, element, |_| true) {
        let text = dom.text(annotation);
        if !trim(&text).is_empty() {
            return trim(&text).to_string();
        }
    }
    let latex = dom.attr(element, "data-latex").filter(|v| !v.is_empty());
    let alttext = dom.attr(element, "alttext").filter(|v| !v.is_empty());
    let has_mathml = has_mathml_children(dom, element);
    let has_complex = has_complex_mathml_children(dom, element);
    if let Some(latex) = latex
        && (!has_mathml || is_trustworthy_latex_attribute(latex, has_complex))
    {
        return trim(latex).to_string();
    }
    if let Some(alttext) = alttext
        && (!has_mathml || is_trustworthy_latex_attribute(alttext, has_complex))
    {
        return trim(alttext).to_string();
    }
    if dom.lower_name(element) == "math" && has_mathml {
        let converted = convert_mathml_to_latex(dom, element);
        if !converted.is_empty() {
            return converted;
        }
    }
    if let Some(latex) = latex {
        return trim(latex).to_string();
    }
    if let Some(alttext) = alttext {
        return trim(alttext).to_string();
    }
    String::new()
}

fn has_latex_environment(value: &str) -> bool {
    LATEX_ENVIRONMENT.is_match(value)
}

fn format_block_latex(value: &str) -> String {
    let latex = trim(value);
    if latex.is_empty() {
        return latex.to_string();
    }
    // mathml-to-latex wraps an unfenced `mtable` in a bare matrix; in block math that is an
    // aligned equation system.
    if let Some(body) = latex
        .strip_prefix("\\begin{matrix}")
        .and_then(|rest| rest.strip_suffix("\\end{matrix}"))
        && !has_latex_environment(body)
    {
        return format!("\\begin{{aligned}}\n{}\n\\end{{aligned}}", trim(body));
    }
    if has_latex_environment(latex) {
        return latex.to_string();
    }
    if latex.contains("\\\\") || latex.contains('&') {
        return format!("\\begin{{aligned}}\n{latex}\n\\end{{aligned}}");
    }
    latex.to_string()
}

fn is_only_math_in_paragraph(dom: &Dom, element: NodeId) -> bool {
    let Some(parent) = dom.doc.parent_node(element) else {
        return false;
    };
    if !dom.is_element(parent) || dom.lower_name(parent) != "p" {
        return false;
    }
    let element_children = dom.children(parent);
    if element_children.len() != 1 || element_children[0] != element {
        return false;
    }
    dom.doc.child_nodes(parent).into_iter().all(|child| {
        child == element
            || (dom.doc.node_type(child) == node_type::TEXT && trim(&dom.text(child)).is_empty())
    })
}

fn is_in_table(dom: &Dom, node: NodeId) -> bool {
    let mut current = Some(node);
    while let Some(c) = current {
        if dom.is_name(c, "TABLE") {
            return true;
        }
        current = dom.doc.parent_node(c);
    }
    false
}

pub fn is_math(dom: &Dom, node: NodeId) -> bool {
    dom.lower_name(node) == "math"
        || dom.class_contains(node, "mwe-math-element")
        || dom.class_contains(node, "mwe-math-fallback-image-inline")
        || dom.class_contains(node, "mwe-math-fallback-image-display")
}

pub fn math(dom: &mut Dom, node: NodeId, _: &str, _: &NodeInfo) -> String {
    let latex = extract_latex(dom, node);
    let latex = trim(&latex).to_string();
    let parent = dom.doc.parent_node(node);
    let in_previous_paragraph = parent.is_some_and(|p| {
        dom.class_contains(p, "mwe-math-element")
            && dom
                .doc
                .previous_sibling(p)
                .is_some_and(|s| dom.is_element(s) && dom.lower_name(s) == "p")
    });
    let is_block = !is_in_table(dom, node)
        && (dom.attr(node, "display") == Some("block")
            || dom.class_contains(node, "mwe-math-fallback-image-display")
            || is_only_math_in_paragraph(dom, node)
            || in_previous_paragraph);
    if is_block {
        return format!("\n$$\n{}\n$$\n", format_block_latex(&latex));
    }
    // Inline math: a space on a side only where text touches it.
    let prev = dom.doc.previous_sibling(node);
    let next = dom.doc.next_sibling(node);
    // `isGenericElement`: only an element neighbour supplies the character next to the math.
    let prev_char = prev
        .filter(|&p| dom.is_element(p))
        .and_then(|p| dom.text(p).chars().next_back());
    let next_char = next
        .filter(|&n| dom.is_element(n))
        .and_then(|n| dom.text(n).chars().next());
    let blank_text =
        |n: NodeId| dom.doc.node_type(n) == node_type::TEXT && trim(&dom.text(n)).is_empty();
    let is_start = prev.is_none_or(blank_text);
    let is_end = next.is_none_or(blank_text);
    let space_or_dollar = |c: char| is_js_whitespace(c) || c == '$';
    let left = if !is_start && prev_char.is_some_and(|c| !space_or_dollar(c)) {
        " "
    } else {
        ""
    };
    let right = if !is_end && next_char.is_some_and(|c| !space_or_dollar(c)) {
        " "
    } else {
        ""
    };
    format!("{left}${latex}${right}")
}

pub fn is_katex(dom: &Dom, node: NodeId) -> bool {
    dom.class_contains(node, "math") || dom.class_contains(node, "katex")
}

pub fn katex(dom: &mut Dom, node: NodeId, _: &str, _: &NodeInfo) -> String {
    // `.katex-mathml X`: some ancestor of `X` (anywhere above it) carries the class.
    let under_katex_mathml = |n: NodeId| {
        let mut current = dom.doc.parent_node(n);
        while let Some(c) = current {
            if dom.has_class_token(c, "katex-mathml") {
                return true;
            }
            current = dom.doc.parent_node(c);
        }
        false
    };
    let mut latex = dom
        .attr(node, "data-latex")
        .map(str::to_string)
        .unwrap_or_default();
    if latex.is_empty()
        && let Some(annotation) = tex_annotation(dom, node, under_katex_mathml)
    {
        latex = dom.text(annotation);
    }
    if latex.is_empty() {
        latex = trim(&dom.text(node)).to_string();
    }
    let math_element = candidates(dom, node)
        .into_iter()
        .find(|&n| dom.lower_name(n) == "math" && under_katex_mathml(n));
    let is_inline = dom.class_contains(node, "math-inline")
        || math_element.is_some_and(|m| dom.attr(m, "display") != Some("block"));
    if is_inline {
        format!("${latex}$")
    } else {
        format!("\n$$\n{latex}\n$$\n")
    }
}

/// `handleNestedEquations(element)` of the `table` rule.
pub fn handle_nested_equations(dom: &Dom, element: NodeId) -> String {
    dom.query_names(element, &["math"])
        .into_iter()
        .map(|math| {
            let annotation = tex_annotation(dom, math, |_| true)
                .map(|a| trim(&dom.text(a)).to_string())
                .filter(|t| !t.is_empty());
            let latex = annotation.or_else(|| {
                dom.attr(math, "alttext")
                    .map(|a| trim(a).to_string())
                    .filter(|t| !t.is_empty())
            });
            let Some(latex) = latex else {
                return String::new();
            };
            let mut inline = false;
            let mut current = Some(math);
            while let Some(c) = current {
                if dom.has_class_token(c, "ltx_eqn_inline")
                    || dom.has_class_token(c, "mwe-math-element-inline")
                {
                    inline = true;
                    break;
                }
                current = dom.doc.parent_node(c);
            }
            if inline {
                format!("${latex}$")
            } else {
                format!("\n$$\n{latex}\n$$")
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// `caption.replace(/<math.*?>(.*?)<\/math>/g, ...)` of the `figure` rule: each `<math>` in the
/// serialized caption becomes `$latex$`, spaced from touching text.
pub fn substitute_caption_math(caption: &str) -> String {
    let chars: Vec<char> = caption.chars().collect();
    let on_line = |c: char| !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
    let starts = |at: usize, text: &str| {
        text.chars()
            .enumerate()
            .all(|(k, c)| chars.get(at + k) == Some(&c))
    };
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let matched = if starts(i, "<math") {
            (i + 5..chars.len())
                .take_while(|&k| on_line(chars[k]))
                .find(|&k| chars[k] == '>')
                .and_then(|open_end| {
                    (open_end + 1..chars.len())
                        .take_while(|&k| on_line(chars[k]))
                        .find(|&k| starts(k, "</math>"))
                })
                .map(|close| close + "</math>".len())
        } else {
            None
        };
        let Some(end) = matched else {
            out.push(chars[i]);
            i += 1;
            continue;
        };
        let whole: String = chars[i..end].iter().collect();
        let fragment = parse::parse(&whole);
        let latex = fragment
            .doc
            .descendants(fragment.doc.root())
            .into_iter()
            .find(|&n| fragment.is_element(n) && fragment.lower_name(n) == "math")
            .map_or(String::new(), |m| extract_latex(&fragment, m));
        let prev = i.checked_sub(1).map(|p| chars[p]);
        let next = chars.get(end).copied();
        let is_start = i == 0 || prev.is_some_and(is_js_whitespace);
        let is_end = end == chars.len() || next.is_some_and(is_js_whitespace);
        let skip = |c: Option<char>| c.is_some_and(|c| is_js_whitespace(c) || c == '$');
        let left = if !is_start && !skip(prev) { " " } else { "" };
        let right = if !is_end && !skip(next) { " " } else { "" };
        out.push_str(&format!("{left}${latex}${right}"));
        i = end;
    }
    out
}
