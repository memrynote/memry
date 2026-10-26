//! `dist/elements/math.js` and `math.full.js`: every rendered or raw math markup becomes
//! `<math xmlns display data-latex>` holding MathML.
//!
//! The two converters Defuddle calls: `mathml-to-latex` 1.8.0 is ported (`mathml`); `temml`
//! 0.13.3 is not yet, so it fails the way a throwing converter does and the oracle makes it
//! throw too (see `convert`).

pub mod base;
pub mod convert;
mod mathml;
mod mjx;
pub mod raw;

use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::elements::rule::Rule;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::dom::transfer_content;

use base::{
    MATH_FAST_CHECK, MATH_SELECTORS, MathData, get_basic_latex_from_element,
    get_mathml_from_element, is_block_display,
};

pub const RULES: &[Rule] = &[Rule {
    selector: MATH_SELECTORS,
    fast_check: Some(MATH_FAST_CHECK),
    transform: math,
}];

/// `getLatexFromElement(el)`: the LaTeX the element carries, else the MathML converted.
pub fn get_latex_from_element(
    doc: &mut Document,
    el: NodeId,
) -> Result<Option<String>, ExtractError> {
    if let Some(latex) = get_basic_latex_from_element(doc, el)? {
        return Ok(Some(latex));
    }
    if let Some(data) = get_mathml_from_element(doc, el)?
        && !data.mathml.is_empty()
    {
        match convert::mathml_to_latex(&data.mathml) {
            Ok(latex) => return Ok(Some(latex)),
            Err(error) => tracing::warn!(%error, "Failed to convert MathML to LaTeX"),
        }
    }
    Ok(None)
}

/// `createCleanMathEl(mathData, latex, isBlock, doc)`: existing MathML wins, else the LaTeX is
/// rendered, else it stays as text.
pub fn create_clean_math_el(
    doc: &mut Document,
    math_data: Option<&MathData>,
    latex: Option<&str>,
    is_block: bool,
) -> Result<NodeId, ExtractError> {
    let clean = doc.create_element("math");
    doc.set_attribute(clean, "xmlns", "http://www.w3.org/1998/Math/MathML");
    doc.set_attribute(clean, "display", if is_block { "block" } else { "inline" });
    doc.set_attribute(clean, "data-latex", latex.unwrap_or(""));
    if let Some(data) = math_data.filter(|d| !d.mathml.is_empty()) {
        let fragment = doc.parse_fragment(&data.mathml);
        if let Some(content) = doc.query_selector(fragment, "math")? {
            transfer_content(doc, content, clean)?;
        }
    } else if let Some(latex) = latex.filter(|l| !l.is_empty()) {
        match convert::temml_render(latex, is_block) {
            Ok(mathml) => {
                let fragment = doc.parse_fragment(&mathml);
                match doc.query_selector(fragment, "math")? {
                    Some(content) => {
                        while let Some(child) = doc.first_child(content) {
                            doc.append_child(clean, child)?;
                        }
                    }
                    None => doc.set_text_content(clean, latex)?,
                }
            }
            Err(error) => {
                tracing::warn!(%error, "Failed to convert LaTeX to MathML");
                doc.set_text_content(clean, latex)?;
            }
        }
    }
    Ok(clean)
}

fn math(doc: &mut Document, el: NodeId) -> Result<NodeId, ExtractError> {
    let math_data = get_mathml_from_element(doc, el)?;
    let latex = get_latex_from_element(doc, el)?;
    let is_block = is_block_display(doc, el)?;
    let clean = create_clean_math_el(doc, math_data.as_ref(), latex.as_deref(), is_block)?;
    // The scripts and previews that belonged to the equation go once its content is extracted.
    // A math script is replaced by the caller, and removing its siblings here would destroy
    // scripts not yet processed.
    if let Some(parent) = doc.parent_element(el)
        && !doc.matches(el, "script[type^=\"math/\"]")?
    {
        for stale in doc.query_selector_all(
            parent,
            "script[type^=\"math/\"], .MathJax_Preview, script[type=\"text/javascript\"][src*=\"mathjax\"], script[type=\"text/javascript\"][src*=\"katex\"]",
        )? {
            doc.remove(stale);
        }
    }
    Ok(clean)
}
