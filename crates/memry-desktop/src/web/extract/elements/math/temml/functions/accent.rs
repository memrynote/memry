//! `functions/accent.js` and `functions/accentunder.js`, plus `unicodeAccents.js`.

use super::{Ctx, Props, Registry, normalize_argument};
use crate::node;
use crate::web::extract::elements::math::temml::build::{build_group, make_text};
use crate::web::extract::elements::math::temml::stretchy;
use crate::web::extract::elements::math::temml::style::Style;
use crate::web::extract::elements::math::temml::tables::tables;
use crate::web::extract::elements::math::temml::tree::{MathNode, Tree};
use crate::web::extract::elements::math::temml::val::{R, V, ulen};

pub struct UnicodeAccent {
    pub text: Option<&'static str>,
    pub math: Option<&'static str>,
}

pub fn unicode_accent(key: &str) -> Option<UnicodeAccent> {
    let (text, math) = match key {
        "\u{0301}" => ("\\'", Some("\\acute")),
        "\u{0300}" => ("\\`", Some("\\grave")),
        "\u{0308}" => ("\\\"", Some("\\ddot")),
        "\u{0303}" => ("\\~", Some("\\tilde")),
        "\u{0304}" => ("\\=", Some("\\bar")),
        "\u{0306}" => ("\\u", Some("\\breve")),
        "\u{030c}" => ("\\v", Some("\\check")),
        "\u{0302}" => ("\\^", Some("\\hat")),
        "\u{0307}" => ("\\.", Some("\\dot")),
        "\u{030a}" => ("\\r", Some("\\mathring")),
        "\u{030b}" => ("\\H", None),
        "\u{0327}" => ("\\c", None),
        _ => return None,
    };
    Some(UnicodeAccent { text: Some(text), math })
}

const SMALL_NUDGE: &str = "DHKLUcegorsuvxyzΠΥΨαδηιμνοτυχϵ";
const MEDIUM_NUDGE: &str = "BCEGIMNOPQRSTXZlpqtwΓΘΞΣΦΩβεζθξρςφψϑϕϱ";
const LARGE_NUDGE: &str = "AFJdfΔΛ";

const NON_STRETCHY: [&str; 14] = [
    "\\acute", "\\check", "\\grave", "\\ddot", "\\dddot", "\\ddddot", "\\tilde", "\\bar",
    "\\breve", "\\check", "\\hat", "\\vec", "\\dot", "\\mathring",
];

const NEEDS_WEBKIT_SHIFT: [&str; 19] = [
    "\\acute", "\\bar", "\\breve", "\\check", "\\dot", "\\ddot", "\\grave", "\\hat", "\\mathring",
    "\\`", "\\'", "\\^", "\\=", "\\u", "\\.", "\\\"", "\\r", "\\H", "\\v",
];

fn combining_char(name: &str) -> Option<&'static str> {
    Some(match name {
        "\\`" => "\u{0300}",
        "\\'" => "\u{0301}",
        "\\^" => "\u{0302}",
        "\\~" => "\u{0303}",
        "\\=" => "\u{0304}",
        "\\u" => "\u{0306}",
        "\\." => "\u{0307}",
        "\\\"" => "\u{0308}",
        "\\r" => "\u{030A}",
        "\\H" => "\u{030B}",
        "\\v" => "\u{030C}",
        "\\c" => "\u{0327}",
        _ => return None,
    })
}

fn mathml_builder(group: &V, style: &Style) -> R<Tree> {
    let label = group.text("label");
    let is_stretchy = group.get("isStretchy").truthy();
    let mut accent_node = if is_stretchy {
        stretchy::accent_node(group)
    } else {
        MathNode::new("mo", vec![make_text(&label, &group.text("mode"), None)])
    };
    if !is_stretchy {
        accent_node.set_attribute("stretchy", "false");
    }
    if label != "\\vec" {
        accent_node.set_style("mathDepth", "0");
    }
    let tag = if label == "\\c" { "munder" } else { "mover" };
    let needs_wbk = NEEDS_WEBKIT_SHIFT.contains(&label.as_str());
    let base_text = group.get("base").get("text");
    let base_text = base_text.as_string().filter(|t| !t.is_empty());
    if tag == "mover"
        && group.text("mode") == "math"
        && !is_stretchy
        && base_text.as_ref().is_some_and(|t| ulen(t) == 1)
    {
        let text = base_text.expect("checked");
        let is_vec = label == "\\vec";
        if is_vec {
            accent_node.classes.push("tml-vec".to_string());
        }
        let wbk_postfix = if is_vec {
            "-vec"
        } else if needs_wbk {
            "-acc"
        } else {
            ""
        };
        // `vecPostfix` is `isVec === "\\vec"`, a boolean against a string: always "".
        if SMALL_NUDGE.contains(&text) {
            accent_node.classes.push("chr-sml".to_string());
            accent_node.classes.push(format!("wbk-sml{wbk_postfix}"));
        } else if MEDIUM_NUDGE.contains(&text) {
            accent_node.classes.push("chr-med".to_string());
            accent_node.classes.push(format!("wbk-med{wbk_postfix}"));
        } else if LARGE_NUDGE.contains(&text) {
            accent_node.classes.push("chr-lrg".to_string());
            accent_node.classes.push(format!("wbk-lrg{wbk_postfix}"));
        } else if is_vec {
            accent_node.classes.push("wbk-vec".to_string());
        } else if needs_wbk {
            accent_node.classes.push("wbk-acc".to_string());
        }
    } else if needs_wbk {
        accent_node.classes.push("wbk-acc".to_string());
    }
    let base = build_group(&group.get("base"), style)?;
    Ok(Tree::Math(MathNode::new(tag, vec![base, Tree::Math(accent_node)])))
}

fn handler_stretchy(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    let base = normalize_argument(&args[0]);
    let is_stretchy = !NON_STRETCHY.contains(&ctx.func_name.as_str());
    Ok(node! {
        "type" => "accent",
        "mode" => ctx.parser.mode,
        "label" => ctx.func_name.clone(),
        "isStretchy" => is_stretchy,
    }
    .with("base", base))
}

fn handler_text(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    let base = normalize_argument(&args[0]);
    let mode = ctx.parser.mode;
    let base_text = base.get("text").as_string().filter(|t| !t.is_empty());
    let name = ctx.func_name.as_str();
    if mode == "text"
        && let Some(t) = &base_text
        && ulen(t) == 1
        && let Some(c) = combining_char(name)
        && tables().smalls.contains(t.as_str())
    {
        return Ok(node! {"type" => "textord", "mode" => "text", "text" => format!("{t}{c}")});
    } else if name == "\\c"
        && mode == "text"
        && let Some(t) = &base_text
        && ulen(t) == 1
    {
        return Ok(node! {"type" => "textord", "mode" => "text", "text" => format!("{t}\u{0327}")});
    }
    Ok(node! {
        "type" => "accent",
        "mode" => mode,
        "label" => name.to_string(),
        "isStretchy" => false,
    }
    .with("base", base))
}

fn under_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    Ok(node! {
        "type" => "accentUnder",
        "mode" => ctx.parser.mode,
        "label" => ctx.func_name.clone(),
    }
    .with("base", args[0].clone()))
}

fn under_builder(group: &V, style: &Style) -> R<Tree> {
    let mut accent_node = stretchy::accent_node(group);
    accent_node.set_style("math-depth", "0");
    let base = build_group(&group.get("base"), style)?;
    Ok(Tree::Math(MathNode::new("munder", vec![base, Tree::Math(accent_node)])))
}

pub fn register(r: &mut Registry) {
    r.define(
        "accent",
        &[
            "\\acute", "\\grave", "\\ddot", "\\dddot", "\\ddddot", "\\tilde", "\\bar", "\\breve",
            "\\check", "\\hat", "\\vec", "\\dot", "\\mathring", "\\overparen", "\\widecheck",
            "\\widehat", "\\wideparen", "\\widetilde", "\\overrightarrow", "\\overleftarrow",
            "\\Overrightarrow", "\\overleftrightarrow", "\\overgroup", "\\overleftharpoon",
            "\\overrightharpoon",
        ],
        Props { num_args: 1, ..Props::D },
        handler_stretchy,
        Some(mathml_builder),
    );
    r.define(
        "accent",
        &["\\'", "\\`", "\\^", "\\~", "\\=", "\\c", "\\u", "\\.", "\\\"", "\\r", "\\H", "\\v"],
        Props {
            num_args: 1,
            allowed_in_text: true,
            allowed_in_math: true,
            arg_types: Some(&["primitive"]),
            ..Props::D
        },
        handler_text,
        Some(mathml_builder),
    );
    r.define(
        "accentUnder",
        &[
            "\\underleftarrow", "\\underrightarrow", "\\underleftrightarrow", "\\undergroup",
            "\\underparen", "\\utilde",
        ],
        Props { num_args: 1, ..Props::D },
        under_handler,
        Some(under_builder),
    );
}
