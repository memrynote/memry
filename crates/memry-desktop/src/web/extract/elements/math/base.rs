//! `dist/elements/math.base.js`: where the LaTeX and the MathML of a math element come from.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::elements::rule::{attr, attr_or_empty};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::dom::tag_lower;
use crate::web::extract::utils::js::trim;

use super::mjx::reconstruct_mathml_from_mjx;

/// `LOOKS_LIKE_LATEX_RE`: a backslash command of two or more ASCII letters.
static LOOKS_LIKE_LATEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\[a-zA-Z]{2,}").expect("static pattern"));
/// `/latex\.php\?latex=([^&]+)/`.
static LATEX_PHP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"latex\.php\?latex=([^&]+)").expect("static pattern"));
/// `LATEX_PARAM_REGEXES`: named query parameters of LaTeX rendering services (`i` flag).
static LATEX_PARAMS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    ["latex", "chl", "tex", "eq", "math"]
        .iter()
        .map(|p| Regex::new(&format!("[?&](?i-u:{p})=([^&#]+)")).expect("static pattern"))
        .collect()
});
/// `/\?([^#]+)/`.
static QUERY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\?([^#]+)").expect("static pattern"));
/// `/%5[Cc]/`.
static ENCODED_BACKSLASH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"%5[Cc]").expect("static pattern"));

/// `mathFastCheck`: a cheap presence test before the full `mathSelectors` scan.
pub const MATH_FAST_CHECK: &str = "math, mjx-container, .MathJax, .katex, img.latex, [data-math], [data-latex], script[type^=\"math/\"]";

/// `mathSelectors`.
pub const MATH_SELECTORS: &str = "img.latex[src*=\"latex.php\"],span.MathJax,mjx-container,script[type=\"math/tex\"],script[type=\"math/tex; mode=display\"],.MathJax_Preview + script[type=\"math/tex\"],.MathJax_Display,.MathJax_SVG,.MathJax_MathML,.mwe-math-element,.mwe-math-fallback-image-inline,.mwe-math-fallback-image-display,.mwe-math-mathml-inline,.mwe-math-mathml-display,.katex,.katex-display,.katex-mathml,.katex-html,[data-katex],script[type=\"math/katex\"],math,[data-math],[data-latex],[data-tex],script[type^=\"math/\"],annotation[encoding=\"application/x-tex\"]";

/// `LOOKS_LIKE_LATEX_RE.test(text)`.
pub fn looks_like_latex(text: &str) -> bool {
    LOOKS_LIKE_LATEX.is_match(text)
}

/// What `getMathMLFromElement` finds: serialized MathML, the LaTeX it carries and its display.
pub struct MathData {
    pub mathml: String,
    pub latex: Option<String>,
    pub is_block: bool,
}

/// `flattenTaggedEquationTables(mathEl)`: a tagged single equation (`\tag{x}`) is an `mtable`
/// whose only row is an `mlabeledtr`; it becomes the equation with the label on the right.
fn flatten_tagged_equation_tables(doc: &mut Document, math: NodeId) -> Result<(), ExtractError> {
    for table in doc.query_selector_all(math, "mtable")? {
        let rows: Vec<NodeId> = doc
            .children(table)
            .into_iter()
            .filter(|&c| matches!(tag_lower(doc, c).as_str(), "mtr" | "mlabeledtr"))
            .collect();
        if rows.len() != 1 || tag_lower(doc, rows[0]) != "mlabeledtr" {
            continue;
        }
        let cells: Vec<NodeId> = doc
            .children(rows[0])
            .into_iter()
            .filter(|&c| tag_lower(doc, c) == "mtd")
            .collect();
        if cells.len() < 2 {
            continue;
        }
        let replacement = doc.create_element("mrow");
        for &cell in &cells[1..] {
            while let Some(child) = doc.first_child(cell) {
                doc.append_child(replacement, child)?;
            }
        }
        if doc.has_child_nodes(cells[0]) {
            let spacer = doc.create_element("mspace");
            doc.set_attribute(spacer, "width", "2em");
            doc.append_child(replacement, spacer)?;
            while let Some(child) = doc.first_child(cells[0]) {
                doc.append_child(replacement, child)?;
            }
        }
        doc.replace_with(table, &[replacement])?;
    }
    Ok(())
}

/// `serializeNormalizedMathML(mathEl)`.
fn serialize_normalized_mathml(doc: &mut Document, math: NodeId) -> Result<String, ExtractError> {
    let clone = doc.clone_node(math, true);
    flatten_tagged_equation_tables(doc, clone)?;
    Ok(doc.outer_html(clone))
}

/// `getMathMLFromElement(el)`.
pub fn get_mathml_from_element(
    doc: &mut Document,
    el: NodeId,
) -> Result<Option<MathData>, ExtractError> {
    if tag_lower(doc, el) == "math" {
        return Ok(Some(MathData {
            is_block: attr(doc, el, "display").as_deref() == Some("block"),
            mathml: serialize_normalized_mathml(doc, el)?,
            latex: attr(doc, el, "alttext").filter(|a| !a.is_empty()),
        }));
    }
    if let Some(mathml) = attr(doc, el, "data-mathml").filter(|m| !m.is_empty()) {
        let fragment = doc.parse_fragment(&mathml);
        if let Some(math) = doc.query_selector(fragment, "math")? {
            return Ok(Some(MathData {
                is_block: attr(doc, math, "display").as_deref() == Some("block"),
                mathml: serialize_normalized_mathml(doc, math)?,
                latex: attr(doc, math, "alttext").filter(|a| !a.is_empty()),
            }));
        }
    }
    if let Some(container) = doc.query_selector(el, ".MJX_Assistive_MathML, mjx-assistive-mml")?
        && let Some(math) = doc.query_selector(container, "math")?
    {
        let is_block = attr(doc, math, "display").as_deref() == Some("block")
            || attr(doc, container, "display").as_deref() == Some("block");
        return Ok(Some(MathData {
            is_block,
            mathml: serialize_normalized_mathml(doc, math)?,
            latex: attr(doc, math, "alttext").filter(|a| !a.is_empty()),
        }));
    }
    if let Some(math) = doc.query_selector(el, ".katex-mathml math")? {
        return Ok(Some(MathData {
            mathml: serialize_normalized_mathml(doc, math)?,
            latex: None,
            is_block: false,
        }));
    }
    let mjx_math = if tag_lower(doc, el) == "mjx-math" {
        Some(el)
    } else {
        doc.query_selector(el, "mjx-math")?
    };
    match mjx_math {
        Some(mjx) => reconstruct_mathml_from_mjx(doc, mjx),
        None => Ok(None),
    }
}

/// `decodeURIComponent(s)`; `None` for the `URIError` of a malformed escape or UTF-8 sequence.
fn decode_uri_component(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let value = u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?;
            // `from_str_radix` accepts a leading `+`; a hex pair does not.
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            out.push(value);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `getBasicLatexFromElement(el)`.
pub fn get_basic_latex_from_element(
    doc: &Document,
    el: NodeId,
) -> Result<Option<String>, ExtractError> {
    for name in ["data-latex", "data-math"] {
        if let Some(value) = attr(doc, el, name).filter(|v| !v.is_empty()) {
            return Ok(Some(value));
        }
    }
    if let Some(parent) = doc.parent_element(el)
        && doc.class_list_contains(parent, "hurmet-tex")
        && let Some(entry) = attr(doc, parent, "data-entry").filter(|v| !v.is_empty())
    {
        return Ok(Some(entry));
    }
    if tag_lower(doc, el) == "img" && doc.class_list_contains(el, "latex") {
        if let Some(alt) = attr(doc, el, "alt").filter(|v| !v.is_empty()) {
            return Ok(Some(alt));
        }
        if let Some(src) = attr(doc, el, "src").filter(|v| !v.is_empty())
            && let Some(m) = LATEX_PHP.captures(&src)
        {
            // A malformed escape throws a URIError in JS, which no caller catches.
            let decoded = decode_uri_component(&m[1])
                .ok_or_else(|| ExtractError::Dom("URIError: URI malformed".to_string()))?;
            return Ok(Some(decoded.replace('+', " ").replace("%5C", "\\")));
        }
    }
    if let Some(annotation) =
        doc.query_selector(el, "annotation[encoding=\"application/x-tex\"]")?
    {
        let text = doc.text_content(annotation).unwrap_or_default();
        if !text.is_empty() {
            return Ok(Some(trim(&text).to_string()));
        }
    }
    if doc.matches(el, ".katex")?
        && let Some(annotation) = doc.query_selector(
            el,
            ".katex-mathml annotation[encoding=\"application/x-tex\"]",
        )?
    {
        let text = doc.text_content(annotation).unwrap_or_default();
        if !text.is_empty() {
            return Ok(Some(trim(&text).to_string()));
        }
    }
    let script_text = |doc: &Document, script: NodeId| {
        Some(trim(&doc.text_content(script).unwrap_or_default()).to_string())
            .filter(|t| !t.is_empty())
    };
    if doc.matches(el, "script[type=\"math/tex\"]")?
        || doc.matches(el, "script[type=\"math/tex; mode=display\"]")?
    {
        return Ok(script_text(doc, el));
    }
    if let Some(parent) = doc.parent_element(el)
        && let Some(sibling) = doc.query_selector(
            parent,
            "script[type=\"math/tex\"], script[type=\"math/tex; mode=display\"]",
        )?
    {
        return Ok(script_text(doc, sibling));
    }
    if tag_lower(doc, el) == "math" {
        let text = trim(&doc.text_content(el).unwrap_or_default()).to_string();
        if !text.is_empty() {
            return Ok(Some(text));
        }
    }
    Ok(attr(doc, el, "alt").filter(|a| !a.is_empty()))
}

/// `isBlockDisplay(el)`.
pub fn is_block_display(doc: &Document, el: NodeId) -> Result<bool, ExtractError> {
    if attr(doc, el, "display").as_deref() == Some("block") {
        return Ok(true);
    }
    let class_names = doc.class_name(el).to_lowercase();
    if class_names.contains("display") || class_names.contains("block") {
        return Ok(true);
    }
    if doc
        .closest(
            el,
            ".katex-display, .MathJax_Display, [data-display=\"block\"]",
        )?
        .is_some()
    {
        return Ok(true);
    }
    if let Some(prev) = doc.previous_element_sibling(el)
        && tag_lower(doc, prev) == "p"
    {
        return Ok(true);
    }
    if doc.matches(el, ".mwe-math-fallback-image-display")? {
        return Ok(true);
    }
    if doc.matches(el, ".katex")? {
        return Ok(doc.closest(el, ".katex-display")?.is_some());
    }
    if doc.has_attribute(el, "display") {
        return Ok(attr_or_empty(doc, el, "display") == "true");
    }
    if doc.matches(el, "script[type=\"math/tex; mode=display\"]")? {
        return Ok(true);
    }
    if let Some(container) = doc.closest(el, "[display]")? {
        return Ok(attr_or_empty(doc, container, "display") == "true");
    }
    Ok(false)
}

/// `decodeLatex(raw)`: the decoded text when it holds a LaTeX command.
fn decode_latex(raw: &str) -> Option<String> {
    let decoded = decode_uri_component(&raw.replace('+', " "))?;
    looks_like_latex(&decoded).then_some(decoded)
}

/// `extractLatexFromImageSrc(src)`: URL-encoded LaTeX in a rendering service's image URL.
pub fn extract_latex_from_image_src(src: &str) -> Option<String> {
    for re in LATEX_PARAMS.iter() {
        if let Some(m) = re.captures(src)
            && let Some(latex) = decode_latex(&m[1])
        {
            return Some(latex);
        }
    }
    if let Some(m) = QUERY.captures(src)
        && let Some(latex) = decode_latex(&m[1])
    {
        return Some(latex);
    }
    let path = src.split('?').next().unwrap_or("");
    for segment in path.split('/').rev() {
        if ENCODED_BACKSLASH.is_match(segment)
            && let Some(latex) = decode_latex(segment)
        {
            return Some(latex);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latex_commands() {
        assert!(looks_like_latex(r"\alpha + \beta"));
        assert!(!looks_like_latex(r"\a"));
        assert!(!looks_like_latex("plain"));
    }

    #[test]
    fn uri_components_decode_like_js() {
        // Values read from Node's decodeURIComponent.
        assert_eq!(
            decode_uri_component("%5Calpha%20x").as_deref(),
            Some("\\alpha x")
        );
        assert_eq!(
            decode_uri_component("%E2%82%AC").as_deref(),
            Some("\u{20ac}")
        );
        assert_eq!(decode_uri_component("%E0%A4%A"), None);
        assert_eq!(decode_uri_component("%"), None);
        assert_eq!(decode_uri_component("%+1"), None);
        assert_eq!(decode_uri_component("%C0%AF"), None);
        assert_eq!(decode_uri_component("%ED%A0%80"), None);
    }

    #[test]
    fn latex_in_image_urls() {
        assert_eq!(
            extract_latex_from_image_src("https://x.test/r.png?latex=%5Cfrac%7Ba%7D%7Bb%7D")
                .as_deref(),
            Some("\\frac{a}{b}")
        );
        assert_eq!(
            extract_latex_from_image_src("https://x.test/r.png?latex=plain"),
            None
        );
        assert_eq!(
            extract_latex_from_image_src("https://x.test/%5Cbeta%20g/img.png").as_deref(),
            Some("\\beta g")
        );
    }
}
