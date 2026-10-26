//! `functions/cancelto.js`.

use super::{Ctx, Props, Registry, is_character_box};
use crate::node;
use crate::web::extract::elements::math::temml::build::{build_group, make_row};
use crate::web::extract::elements::math::temml::style::Style;
use crate::web::extract::elements::math::temml::tables::tables;
use crate::web::extract::elements::math::temml::tree::{MathNode, Tree};
use crate::web::extract::elements::math::temml::val::{R, V, jserr};

fn handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    let to = args[0].clone();
    let body = args[1].clone();
    Ok(node! {
        "type" => "cancelto",
        "mode" => ctx.parser.mode,
        "isCharacterBox" => is_character_box(&body),
    }
    .with("body", body)
    .with("to", to))
}

fn style_color(style: &Style) -> String {
    style
        .color
        .clone()
        .unwrap_or_else(|| "undefined".to_string())
}

fn builder(group: &V, style: &Style) -> R<Tree> {
    let body = group.get("body");
    let is_char_box = group.get("isCharacterBox").truthy();
    let from_node =
        MathNode::with_classes("mrow", vec![build_group(&body, style)?], &["ff-narrow"]);
    let phantom = MathNode::new("mphantom", vec![build_group(&body, style)?]);
    let mut arrow = MathNode::with_classes("mrow", vec![Tree::Math(phantom)], &["tml-cancelto"]);
    arrow.set_style("color", style_color(style));
    // `group.body.body[0].text`: the character box's text, `undefined` when it has none.
    let first_text = || -> R<String> {
        let first = body.get("body");
        if !first.is_arr() || first.len() == 0 {
            return jserr("Cannot read properties of undefined (reading 'text')");
        }
        Ok(first.items()[0]
            .get("text")
            .as_string()
            .unwrap_or_else(|| "undefined".to_string()))
    };
    if is_char_box && tables().smalls.contains(first_text()?.as_str()) {
        arrow.set_style("left", "0.1em");
        arrow.set_style("width", "90%");
    }
    let mut node = MathNode::with_classes("mrow", vec![], &["menclose"]);
    let mut from_node = from_node;
    let wide = !is_char_box || first_text()?.chars().any(|c| matches!(c, 'f' | '∫' | '∑'));
    // `phantom` lives inside `arrow`; its style is set through the arrow's first child.
    if let Some(Tree::Math(phantom)) = arrow.children.first_mut() {
        if wide {
            phantom.set_style("paddingRight", "0.2em");
        } else {
            phantom.set_style("padding", "0.5ex 0.1em 0 0");
            let mut strut = MathNode::new("mspace", Vec::new());
            strut.set_attribute("height", "0.85em");
            from_node.children.push(Tree::Math(strut));
        }
    }
    node.children = vec![Tree::Math(from_node), Tree::Math(arrow)];
    let dummy_node = if is_char_box {
        let mut d = MathNode::new("mspace", Vec::new());
        d.set_attribute("height", "1em");
        d
    } else {
        let inner = build_group(&body, style)?;
        let mut zero = MathNode::new("mpadded", vec![inner]);
        zero.set_attribute("width", "0.1px");
        MathNode::new("mphantom", vec![Tree::Math(zero)])
    };
    let mut to_node = build_group(&group.get("to"), style)?;
    to_node.set_style("color", style_color(style))?;
    let mut zero_width_to = MathNode::new("mpadded", vec![to_node]);
    if wide {
        let mut w = MathNode::new("mspace", Vec::new());
        w.set_attribute("width", "0.2em");
        zero_width_to.children.insert(0, Tree::Math(w));
    }
    zero_width_to.set_attribute("width", "0.1px");
    let mover = MathNode::new(
        "mover",
        vec![Tree::Math(dummy_node), Tree::Math(zero_width_to)],
    );
    let nudge_left = MathNode::with_classes("mrow", vec![], &["ff-nudge-left"]);
    let row = make_row(vec![Tree::Math(node), Tree::Math(mover)], false);
    Ok(Tree::frag(vec![row, Tree::Math(nudge_left)]))
}

pub fn register(r: &mut Registry) {
    r.define(
        "cancelto",
        &["\\cancelto"],
        Props {
            num_args: 2,
            ..Props::D
        },
        handler,
        Some(builder),
    );
}
