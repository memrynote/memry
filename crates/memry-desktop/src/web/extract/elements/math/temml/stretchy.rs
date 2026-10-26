//! `stretchy.js`.

use super::tree::{MathNode, Tree};
use super::val::V;

fn estimated_width(node: &V) -> f64 {
    let body = node.get("body");
    let mut width = 0.0;
    if body.truthy() && body.is_arr() {
        for item in body.items() {
            width += estimated_width(&item);
        }
    } else if body.truthy() {
        width += estimated_width(&body);
    } else if node.is_type("supsub") {
        width += estimated_width(&node.get("base"));
        if node.get("sub").truthy() {
            width += 0.7 * estimated_width(&node.get("sub"));
        }
        if node.get("sup").truthy() {
            width += 0.7 * estimated_width(&node.get("sup"));
        }
    } else if node.is_type("mathord") || node.is_type("textord") {
        for unit in node.text("text").encode_utf16() {
            let cp = u32::from(unit);
            if (0x60 < cp && cp < 0x7B) || (0x03B0 < cp && cp < 0x3CA) {
                width += 0.56;
            } else if 0x2F < cp && cp < 0x3A {
                width += 0.50;
            } else {
                width += 0.92;
            }
        }
    } else {
        width += 1.0;
    }
    width
}

fn stretchy_code_point(name: &str) -> &'static str {
    match name {
        "widehat" => "^",
        "widecheck" => "ˇ",
        "widetilde" | "utilde" => "~",
        "wideparen" | "overparen" => "⏜",
        "overleftarrow" | "underleftarrow" | "xleftarrow" | "yieldsLeft" | "\\cdleftarrow" => "\u{2190}",
        "overrightarrow" | "underrightarrow" | "xrightarrow" | "yields" | "\\cdrightarrow" => "\u{2192}",
        "underbrace" => "\u{23df}",
        "overbrace" => "\u{23de}",
        "overbracket" => "\u{23b4}",
        "underbracket" => "\u{23b5}",
        "overgroup" => "\u{23e0}",
        "undergroup" => "\u{23e1}",
        "underparen" => "\u{23dd}",
        "overleftrightarrow" | "underleftrightarrow" | "xleftrightarrow" | "mesomerism" => "\u{2194}",
        "Overrightarrow" | "xRightarrow" => "\u{21d2}",
        "overleftharpoon" | "xleftharpoonup" => "\u{21bc}",
        "overrightharpoon" | "xrightharpoonup" | "eqrightharpoonup" | "longrightharpoonup" => "\u{21c0}",
        "xLeftarrow" => "\u{21d0}",
        "xLeftrightarrow" => "\u{21d4}",
        "xhookleftarrow" => "\u{21a9}",
        "xhookrightarrow" => "\u{21aa}",
        "xmapsto" => "\u{21a6}",
        "xrightharpoondown" => "\u{21c1}",
        "xleftharpoondown" | "longleftharpoondown" | "eqleftharpoondown" => "\u{21bd}",
        "xtwoheadleftarrow" => "\u{219e}",
        "xtwoheadrightarrow" => "\u{21a0}",
        "xlongequal" | "\\cdlongequal" => "=",
        "xrightleftarrows" | "xtofrom" | "yieldsLeftRight" => "\u{21c4}",
        "xleftrightharpoons" => "\u{21cb}",
        "xrightleftharpoons" | "chemequilibrium" => "\u{21cc}",
        _ => "undefined",
    }
}

/// `mathMLnode(label)`.
pub fn math_ml_node(label: &str) -> MathNode {
    let name = label.chars().skip(1).collect::<String>();
    let mut node = MathNode::new("mo", vec![Tree::Text(stretchy_code_point(&name).to_string())]);
    node.set_attribute("stretchy", "true");
    node
}

const CROOKED_WIDES: [&str; 4] = ["\\widetilde", "\\widehat", "\\widecheck", "\\utilde"];

/// `accentNode(group)`.
pub fn accent_node(group: &V) -> MathNode {
    let label = group.text("label");
    let mut mo = math_ml_node(&label);
    if CROOKED_WIDES.contains(&label.as_str()) {
        let width = estimated_width(&group.get("base"));
        if 1.0 < width && width < 1.6 {
            mo.classes.push("tml-crooked-2".to_string());
        } else if 1.6 <= width && width < 2.5 {
            mo.classes.push("tml-crooked-3".to_string());
        } else if 2.5 <= width {
            mo.classes.push("tml-crooked-4".to_string());
        }
    }
    mo
}
