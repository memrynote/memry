//! `MathMLToLaTeX.convert` of mathml-to-latex 1.8.0: parse the MathML as XML (xmldom), map the
//! `math` elements to its element tree, normalize fences and tables, convert every element to
//! LaTeX.

mod latex;
mod tables;
mod thickness;
mod tree;
mod xml;

use tree::Tree;
use xml::XNode;

pub use latex::ConvertError;

/// `MathMLToLaTeX.convert(mathml)`: the LaTeX of every `math` element, joined and trimmed. A
/// converter that throws (a `mfrac` without two children) makes the call throw: `Err`.
pub fn convert(mathml: &str) -> Result<String, ConvertError> {
    // `_removeLineBreaks`, then `_removeMsWordPrefixes`.
    let cleaned = mathml
        .replace("\r\n", "")
        .replace(['\n', '\r'], "")
        .replace("mml:", "");
    // A `ParseError` leaves the library without a document: no `math` elements, empty result.
    let Ok(document) = xml::parse(&cleaned) else {
        return Ok(String::new());
    };
    let mut out = String::new();
    for element in math_elements(&document) {
        let mut tree = Tree::default();
        let root = tree.build(element)?;
        out.push_str(&latex::convert_tree(&mut tree, root)?);
    }
    Ok(crate::web::extract::utils::js::trim(&out).to_string())
}

/// `document.getElementsByTagName('math')`: pre-order, so a nested `math` follows its ancestor.
fn math_elements(document: &[XNode]) -> Vec<&XNode> {
    let mut found = Vec::new();
    let mut stack: Vec<&XNode> = document.iter().rev().collect();
    while let Some(node) = stack.pop() {
        if let XNode::Element { name, children, .. } = node {
            if name == "math" {
                found.push(node);
            }
            stack.extend(children.iter().rev());
        }
    }
    found
}
