//! `functions/arrow.js`: extensible arrows.

use super::{Ctx, Props, Registry};
use crate::node;
use crate::web::extract::elements::math::temml::build::build_group;
use crate::web::extract::elements::math::temml::stretchy;
use crate::web::extract::elements::math::temml::style::Style;
use crate::web::extract::elements::math::temml::tree::{MathNode, Tree};
use crate::web::extract::elements::math::temml::units::{em_scale, to_fixed};
use crate::web::extract::elements::math::temml::val::{R, V, num_str};

/// `padding(width)`: `width` is the JS value as it prints.
pub fn padding(width: &str) -> Tree {
    let mut node = MathNode::new("mspace", Vec::new());
    node.set_attribute("width", format!("{width}em"));
    Tree::Math(node)
}

/// `paddedNode(group, space, space, mustSmash)` for a non-null group, where both spaces are the
/// `toFixed(4)` string (a string never equals the number 0, and `> 0` compares numerically).
fn padded_node(group: Tree, space: &str, must_smash: bool) -> Tree {
    let mut row = vec![padding(space), group];
    if space.parse::<f64>().is_ok_and(|n| n > 0.0) {
        row.push(padding(space));
    }
    if must_smash {
        let mut mpadded = MathNode::new("mpadded", row);
        mpadded.set_attribute("height", "0.1px");
        Tree::Math(mpadded)
    } else {
        Tree::Math(MathNode::new("mrow", row))
    }
}

fn label_size(size: f64, script_level: i32) -> f64 {
    size / em_scale(script_level)
}

fn got_label(body: &V) -> bool {
    let inner = body.get("body");
    body.truthy() && inner.truthy() && (inner.get("body").truthy() || inner.len() > 0)
}

fn munderover_node(f_name: &str, body: &V, below: &V, style: &Style) -> R<Tree> {
    let mut arrow_node = stretchy::math_ml_node(f_name);
    let is_eq = f_name.chars().skip(1).take(2).collect::<String>() == "eq";
    let min_width = if f_name.chars().nth(1) == Some('x') {
        "1.75"
    } else if f_name.chars().skip(2).take(2).collect::<String>() == "cd" {
        "3.0"
    } else if is_eq {
        "1.0"
    } else {
        "2.0"
    };
    arrow_node.set_attribute("lspace", "0");
    arrow_node.set_attribute("rspace", if is_eq { "0.5em" } else { "0" });
    let label_style = style.with_level(if style.level < 2 { 2 } else { 3 });
    let min_arrow_width = label_size(min_width.parse().expect("number"), label_style.level);
    let dummy_width = label_size(min_width.parse().expect("number"), 3);
    let empty_label = padding(&to_fixed(min_arrow_width, 4));
    let dummy_node = padding(&to_fixed(dummy_width, 4));
    let space = to_fixed(
        label_size(if is_eq { 0.0 } else { 0.3 }, label_style.level),
        4,
    );
    let mut upper_node = None;
    let mut lower_node = None;
    let got_upper = got_label(body);
    if got_upper {
        let label = build_group(body, &label_style)?;
        let must_smash = f_name == "\\\\cdrightarrow" || f_name == "\\\\cdleftarrow";
        let label = padded_node(label, &space, must_smash);
        upper_node = Some(Tree::Math(MathNode::new(
            "mover",
            vec![label, dummy_node.clone()],
        )));
    }
    let got_lower = got_label(below);
    if got_lower {
        let label = build_group(below, &label_style)?;
        let label = padded_node(label, &space, false);
        lower_node = Some(Tree::Math(MathNode::new("munder", vec![label, dummy_node])));
    }
    let arrow = Tree::Math(arrow_node);
    let mut node = match (upper_node, lower_node) {
        (None, None) => MathNode::new("mover", vec![arrow, empty_label]),
        (Some(u), Some(l)) => MathNode::new("munderover", vec![arrow, l, u]),
        (Some(u), None) => MathNode::new("mover", vec![arrow, u]),
        (None, Some(l)) => MathNode::new("munder", vec![arrow, l]),
    };
    if min_width == "3.0" {
        node.set_style("height", "1em");
    }
    node.set_attribute("accent", "false");
    Ok(Tree::Math(node))
}

fn x_arrow_handler(ctx: &mut Ctx, args: &[V], opt: &[V]) -> R<V> {
    Ok(node! {
        "type" => "xArrow",
        "mode" => ctx.parser.mode,
        "name" => ctx.func_name.clone(),
    }
    .with("body", args[0].clone())
    .with("below", opt[0].clone()))
}

fn x_arrow_builder(group: &V, style: &Style) -> R<Tree> {
    let node = munderover_node(
        &group.text("name"),
        &group.get("body"),
        &group.get("below"),
        style,
    )?;
    let gap = num_str(0.2778);
    Ok(Tree::Math(MathNode::new(
        "mrow",
        vec![padding(&gap), node, padding(&gap)],
    )))
}

fn arrow_component(name: &str) -> (&'static str, &'static str) {
    if name == "\\equilibriumRight" {
        ("\\longrightharpoonup", "\\eqleftharpoondown")
    } else {
        ("\\eqrightharpoonup", "\\longleftharpoondown")
    }
}

fn stacked_handler(ctx: &mut Ctx, args: &[V], opt: &[V]) -> R<V> {
    let mode = ctx.parser.mode;
    let hphantom =
        |body: &V| node! {"type" => "hphantom", "mode" => mode}.with("body", body.clone());
    let lower_arrow_body = if args[0].truthy() {
        hphantom(&args[0])
    } else {
        V::Null
    };
    let upper_arrow_below = if opt[0].truthy() {
        hphantom(&opt[0])
    } else {
        V::Null
    };
    Ok(
        node! {"type" => "stackedArrow", "mode" => mode, "name" => ctx.func_name.clone()}
            .with("body", args[0].clone())
            .with("upperArrowBelow", upper_arrow_below)
            .with("lowerArrowBody", lower_arrow_body)
            .with("below", opt[0].clone()),
    )
}

fn stacked_builder(group: &V, style: &Style) -> R<Tree> {
    let name = group.text("name");
    let (top_label, bot_label) = arrow_component(&name);
    let top_arrow = munderover_node(
        top_label,
        &group.get("body"),
        &group.get("upperArrowBelow"),
        style,
    )?;
    let bot_arrow = munderover_node(
        bot_label,
        &group.get("lowerArrowBody"),
        &group.get("below"),
        style,
    )?;
    let gap = num_str(0.2778);
    let mut raise_node = MathNode::new("mpadded", vec![top_arrow]);
    raise_node.set_attribute("voffset", "0.3em");
    raise_node.set_attribute("height", "+0.3em");
    raise_node.set_attribute("depth", "-0.3em");
    let mut wrapper;
    if name == "\\equilibriumLeft" {
        let mut bot_node = MathNode::new("mpadded", vec![bot_arrow]);
        bot_node.set_attribute("width", "0.5em");
        wrapper = MathNode::new(
            "mpadded",
            vec![
                padding(&gap),
                Tree::Math(bot_node),
                Tree::Math(raise_node),
                padding(&gap),
            ],
        );
    } else {
        raise_node.set_attribute(
            "width",
            if name == "\\equilibriumRight" {
                "0.5em"
            } else {
                "0"
            },
        );
        wrapper = MathNode::new(
            "mpadded",
            vec![
                padding(&gap),
                Tree::Math(raise_node),
                bot_arrow,
                padding(&gap),
            ],
        );
    }
    wrapper.set_attribute("voffset", "-0.18em");
    wrapper.set_attribute("height", "-0.18em");
    wrapper.set_attribute("depth", "+0.18em");
    Ok(Tree::Math(wrapper))
}

pub fn register(r: &mut Registry) {
    r.define(
        "xArrow",
        &[
            "\\xleftarrow",
            "\\xrightarrow",
            "\\xLeftarrow",
            "\\xRightarrow",
            "\\xleftrightarrow",
            "\\xLeftrightarrow",
            "\\xhookleftarrow",
            "\\xhookrightarrow",
            "\\xmapsto",
            "\\xrightharpoondown",
            "\\xrightharpoonup",
            "\\xleftharpoondown",
            "\\xleftharpoonup",
            "\\xlongequal",
            "\\xtwoheadrightarrow",
            "\\xtwoheadleftarrow",
            "\\xtofrom",
            "\\xleftrightharpoons",
            "\\xrightleftharpoons",
            "\\yields",
            "\\yieldsLeft",
            "\\mesomerism",
            "\\longrightharpoonup",
            "\\longleftharpoondown",
            "\\yieldsLeftRight",
            "\\chemequilibrium",
            "\\\\cdrightarrow",
            "\\\\cdleftarrow",
            "\\\\cdlongequal",
        ],
        Props {
            num_args: 1,
            num_optional_args: 1,
            ..Props::D
        },
        x_arrow_handler,
        Some(x_arrow_builder),
    );
    r.define(
        "stackedArrow",
        &["\\equilibriumRight", "\\equilibriumLeft"],
        Props {
            num_args: 1,
            num_optional_args: 1,
            ..Props::D
        },
        stacked_handler,
        Some(stacked_builder),
    );
}
