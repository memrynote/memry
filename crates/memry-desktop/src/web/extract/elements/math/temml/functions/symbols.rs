//! `functions/symbolsOrd.js`, `symbolsOp.js` and `symbolsSpacing.js`: the builders of the symbol
//! node types.

use super::Registry;
use super::arrow::padding;
use crate::web::extract::elements::math::temml::build::make_text;
use crate::web::extract::elements::math::temml::replace::{
    small_caps, variant_char, variant_each_unit,
};
use crate::web::extract::elements::math::temml::style::Style;
use crate::web::extract::elements::math::temml::tree::{MathNode, Tree};
use crate::web::extract::elements::math::temml::val::{R, V, num_str, perr, ulen};
use crate::web::extract::elements::math::temml::variant::get_variant;

fn text_of(t: &Tree) -> String {
    match t {
        Tree::Text(s) => s.clone(),
        _ => String::new(),
    }
}

fn first_code_point(s: &str) -> Option<u32> {
    s.chars().next().map(|c| c as u32)
}

/// `/^\d(?:[\d,.]*\d)?$/`.
fn is_number(s: &str) -> bool {
    let b = s.as_bytes();
    if b.is_empty() || !b[0].is_ascii_digit() {
        return false;
    }
    if b.len() == 1 {
        return true;
    }
    b[b.len() - 1].is_ascii_digit()
        && b[1..b.len() - 1]
            .iter()
            .all(|c| c.is_ascii_digit() || *c == b',' || *c == b'.')
}

const PRIMES: [&str; 7] = [
    "\\prime",
    "\\dprime",
    "\\trprime",
    "\\qprime",
    "\\backprime",
    "\\backdprime",
    "\\backtrprime",
];

fn italic_number(text: String, variant: &str, tag: &str) -> Tree {
    let mn = MathNode::new(tag, vec![Tree::Text(text)]);
    let mut wrapper = MathNode::new("mstyle", vec![Tree::Math(mn)]);
    wrapper.set_style("font-style", "italic");
    wrapper.set_style("font-family", "Cambria, 'Times New Roman', serif");
    if variant == "bold-italic" {
        wrapper.set_style("font-weight", "bold");
    }
    Tree::Math(wrapper)
}

fn mathord_builder(group: &V, style: &Style) -> R<Tree> {
    let mut text = text_of(&make_text(
        &group.text("text"),
        &group.text("mode"),
        Some(style),
    ));
    let default_variant = match first_code_point(&text) {
        Some(cp) if 0x0390 < cp && cp < 0x03aa => "normal",
        _ => "italic",
    };
    let variant = get_variant(group, style).unwrap_or(default_variant);
    if variant == "script" {
        text = variant_char(&text, variant);
        return Ok(Tree::Math(MathNode::with_classes(
            "mi",
            vec![Tree::Text(text)],
            &[style.font.as_str()],
        )));
    } else if variant != "italic" {
        text = variant_char(&text, variant);
    }
    let one_unit = ulen(&text) == 1;
    let mut node = MathNode::new("mi", vec![Tree::Text(text)]);
    if variant == "normal" {
        node.set_attribute("mathvariant", "normal");
        if one_unit {
            let mspace = MathNode::new("mspace", Vec::new());
            node = MathNode::new("mrow", vec![Tree::Math(node), Tree::Math(mspace)]);
        }
    }
    Ok(Tree::Math(node))
}

fn textord_builder(group: &V, style: &Style) -> R<Tree> {
    let group_text = group.text("text");
    let mut ch = Some(group_text.clone());
    let cp = first_code_point(&group_text);
    if style.font_family == "textsc" && matches!(cp, Some(c) if 96 < c && c < 123) {
        ch = small_caps(&group_text).map(str::to_string);
    }
    let mode = group.text("mode");
    let mut text = match &ch {
        Some(c) => text_of(&make_text(c, &mode, Some(style))),
        None => "undefined".to_string(),
    };
    let variant = get_variant(group, style).unwrap_or("normal");
    let node;
    if is_number(&group_text) {
        let tag = if mode == "text" { "mtext" } else { "mn" };
        if variant == "italic" || variant == "bold-italic" {
            return Ok(italic_number(text, variant, tag));
        }
        if variant != "normal" {
            text = variant_each_unit(&text, variant);
        }
        node = MathNode::new(tag, vec![Tree::Text(text)]);
    } else if mode == "text" {
        if variant != "normal" {
            text = variant_char(&text, variant);
        }
        node = MathNode::new("mtext", vec![Tree::Text(text)]);
    } else if PRIMES.contains(&group_text.as_str()) {
        let mut n = MathNode::new("mo", vec![Tree::Text(text)]);
        n.classes.push("tml-prime".to_string());
        node = n;
    } else {
        let orig = text.clone();
        if variant != "italic" {
            text = variant_char(&text, variant);
        }
        let unchanged = text == orig;
        let mut n = MathNode::new("mi", vec![Tree::Text(text)]);
        // `/[A-Ba-z]/`: temml's range really stops at B.
        if unchanged && orig.chars().any(|c| matches!(c, 'A'..='B' | 'a'..='z')) {
            n.set_attribute("mathvariant", "italic");
        }
        node = n;
    }
    Ok(Tree::Math(node))
}

const SHORT: [&str; 5] = [
    "\\shortmid",
    "\\nshortmid",
    "\\shortparallel",
    "\\nshortparallel",
    "\\smallsetminus",
];
const ARROWS: [&str; 3] = ["\\Rsh", "\\Lsh", "\\restriction"];

fn is_arrow(s: &str) -> bool {
    if ulen(s) == 1 {
        let cp = first_code_point(s).unwrap_or(0);
        return 0x218f < cp && cp < 0x2200;
    }
    s.contains("arrow") || s.contains("harpoon") || ARROWS.contains(&s)
}

fn atom_builder(group: &V, _style: &Style) -> R<Tree> {
    let text = group.text("text");
    let family = group.text("family");
    let mut node = MathNode::new("mo", vec![make_text(&text, &group.text("mode"), None)]);
    if family == "punct" {
        node.set_attribute("separator", "true");
    } else if family == "open" || family == "close" {
        if family == "open" {
            node.set_attribute("form", "prefix");
            node.set_attribute("stretchy", "false");
        } else {
            node.set_attribute("form", "postfix");
            node.set_attribute("stretchy", "false");
        }
    } else if text == "\\mid" {
        node.set_attribute("lspace", "0.22em");
        node.set_attribute("rspace", "0.22em");
        node.set_attribute("stretchy", "false");
    } else if family == "rel" && is_arrow(&text) {
        node.set_attribute("stretchy", "false");
    } else if SHORT.contains(&text.as_str()) {
        node.set_attribute("mathsize", "70%");
    } else if text == ":" {
        node.set_attribute("lspace", "0.2222em");
        node.set_attribute("rspace", "0.2222em");
    } else if group.get("needsSpacing").truthy() {
        let gap = if family == "bin" { 0.222 } else { 0.2778 };
        let gap = num_str(gap);
        return Ok(Tree::Math(MathNode::new(
            "mrow",
            vec![padding(&gap), Tree::Math(node), padding(&gap)],
        )));
    }
    Ok(Tree::Math(node))
}

fn spacing_builder(group: &V, _style: &Style) -> R<Tree> {
    let text = group.text("text");
    let node = if [" ", "\\ ", "~", "\\space", "\\nobreakspace"].contains(&text.as_str()) {
        MathNode::new("mtext", vec![Tree::Text("\u{a0}".to_string())])
    } else if text == "\\nobreak" || text == "\\allowbreak" {
        let mut n = MathNode::new("mo", Vec::new());
        if text == "\\nobreak" {
            n.set_attribute("linebreak", "nobreak");
        }
        n
    } else {
        return perr(format!("Unknown type of space \"{text}\""));
    };
    Ok(Tree::Math(node))
}

pub fn register(r: &mut Registry) {
    r.builder("mathord", mathord_builder);
    r.builder("textord", textord_builder);
    r.builder("atom", atom_builder);
    r.builder("spacing", spacing_builder);
}
