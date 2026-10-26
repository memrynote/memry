//! `functions/supsub.js`.

use super::Registry;
use crate::web::extract::elements::math::temml::build::{build_group, make_text, set_attr};
use crate::web::extract::elements::math::temml::style::{DISPLAY, Style};
use crate::web::extract::elements::math::temml::tree::{MathNode, Tree};
use crate::web::extract::elements::math::temml::val::{R, V, ulen};

const SMALL_PAD: &str = "DHKLUcegorsuvxyzΠΥΨαδηιμνοτυχϵ";
const MEDIUM_PAD: &str = "BCEFGIMNOPQRSTXZlpqtwΓΘΞΣΦΩβεζθξρςφψϑϕϱ";
const LARGE_PAD: &str = "AJdfΔΛ";

fn builder(group: &V, style: &Style) -> R<Tree> {
    let base = group.get("base");
    let sub = group.get("sub");
    let sup = group.get("sup");
    let stack = group.get("stack").truthy();
    let mut is_bracket = false;
    let mut is_over = false;
    let mut append_apply_function = false;
    let mut append_space = false;
    let mut needs_leading_space = false;
    if base.truthy() && base.is_type("horizBracket") {
        let is_sup = sup.truthy();
        if is_sup == base.get("isOver").truthy() {
            is_bracket = true;
            is_over = base.get("isOver").truthy();
        }
    }
    if base.truthy() && !stack && (base.is_type("op") || base.is_type("operatorname")) {
        base.set("parentIsSupSub", V::Bool(true));
        append_apply_function = !base.get("symbol").truthy();
        append_space = append_apply_function && !group.get("isFollowedByDelimiter").truthy();
        needs_leading_space = base.get("needsLeadingSpace").truthy();
    }
    let mut children = if stack && base.get("body").len() == 1 {
        vec![build_group(&base.get("body").items()[0], style)?]
    } else {
        vec![build_group(&base, style)?]
    };
    let child_style = style.in_sub_or_sup();
    if sub.truthy() {
        let mut s = build_group(&sub, &child_style)?;
        if style.level == 3 {
            set_attr(&mut s, "scriptlevel", "2")?;
        }
        children.push(s);
    }
    if sup.truthy() {
        let mut s = build_group(&sup, &child_style)?;
        if style.level == 3 {
            set_attr(&mut s, "scriptlevel", "2")?;
        }
        if base.truthy()
            && let Some(text) = base.get("text").as_string().filter(|t| !t.is_empty())
            && ulen(&text) == 1
        {
            let class = if SMALL_PAD.contains(&text) {
                Some("tml-sml-pad")
            } else if MEDIUM_PAD.contains(&text) {
                Some("tml-med-pad")
            } else if LARGE_PAD.contains(&text) {
                Some("tml-lrg-pad")
            } else {
                None
            };
            if let Some(c) = class {
                s.classes_mut()?.push(c.to_string());
            }
        }
        children.push(s);
    }
    let base_alt = base.get("alwaysHandleSupSub").truthy();
    let base_limits = base.get("limits").truthy();
    let node_type = if is_bracket {
        if is_over { "mover" } else { "munder" }
    } else if !sub.truthy() {
        if base.is_type("op") && base_limits && (style.level == DISPLAY || base_alt) {
            "mover"
        } else if base.is_type("operatorname")
            && base_alt
            && (base_limits || style.level == DISPLAY)
        {
            "mover"
        } else {
            "msup"
        }
    } else if !sup.truthy() {
        if stack {
            "munder"
        } else if base.is_type("op") && base_limits && (style.level == DISPLAY || base_alt) {
            "munder"
        } else if base.is_type("operatorname")
            && base_alt
            && (base_limits || style.level == DISPLAY)
        {
            "munder"
        } else {
            "msub"
        }
    } else if base.truthy()
        && ((base.is_type("op") && base_limits) || base.is_type("multiscript"))
        && (style.level == DISPLAY || base_alt)
    {
        "munderover"
    } else if base.is_type("operatorname") && base_alt && (style.level == DISPLAY || base_limits) {
        "munderover"
    } else {
        "msubsup"
    };
    let mut node = Tree::Math(MathNode::new(node_type, children));
    if append_apply_function {
        let operator = Tree::Math(MathNode::new(
            "mo",
            vec![make_text("\u{2061}", "text", None)],
        ));
        let thin = || {
            let mut space = MathNode::new("mspace", Vec::new());
            space.set_attribute("width", "0.1667em");
            Tree::Math(space)
        };
        node = if needs_leading_space {
            Tree::frag(vec![thin(), node, operator])
        } else {
            Tree::frag(vec![node, operator])
        };
        if append_space && let Some(c) = node.children_mut() {
            c.push(thin());
        }
    } else if matches!(node_type, "mover" | "munder" | "munderover") {
        node = Tree::Math(MathNode::new("mrow", vec![node]));
    }
    Ok(node)
}

pub fn register(r: &mut Registry) {
    r.builder("supsub", builder);
}
