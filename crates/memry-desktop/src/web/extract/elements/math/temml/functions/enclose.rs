//! `functions/enclose.js`.

use super::color::{color_from_spec, validate_color};
use super::{Ctx, Props, Registry, assert_node_type};
use crate::node;
use crate::web::extract::elements::math::temml::build::build_group;
use crate::web::extract::elements::math::temml::style::Style;
use crate::web::extract::elements::math::temml::tree::{MathNode, Tree};
use crate::web::extract::elements::math::temml::val::{R, V};

fn mrow_with(classes: &[&str]) -> Tree {
    Tree::Math(MathNode::with_classes("mrow", Vec::new(), classes))
}

fn builder(group: &V, style: &Style) -> R<Tree> {
    let label = group.text("label");
    let tag = if ["\\boxed", "\\fcolorbox", "\\colorbox"].contains(&label.as_str()) {
        "mrow"
    } else {
        "menclose"
    };
    let mut node = MathNode::new(tag, vec![build_group(&group.get("body"), style)?]);
    match label.as_str() {
        "\\overline" => {
            node.set_attribute("notation", "top");
            node.classes.push("tml-overline".to_string());
        }
        "\\underline" => {
            node.set_attribute("notation", "bottom");
            node.classes.push("tml-underline".to_string());
        }
        "\\cancel" => {
            node.set_attribute("notation", "updiagonalstrike");
            node.children.push(mrow_with(&["tml-cancel", "upstrike"]));
        }
        "\\bcancel" => {
            node.set_attribute("notation", "downdiagonalstrike");
            node.children.push(mrow_with(&["tml-cancel", "downstrike"]));
        }
        "\\sout" => {
            node.set_attribute("notation", "horizontalstrike");
            node.children.push(mrow_with(&["tml-cancel", "sout"]));
        }
        "\\xcancel" => {
            node.set_attribute("notation", "updiagonalstrike downdiagonalstrike");
            node.children
                .push(mrow_with(&["tml-cancel", "tml-xcancel"]));
        }
        "\\longdiv" => {
            node.set_attribute("notation", "longdiv");
            node.classes.push("longdiv-top".to_string());
            node.children.push(mrow_with(&["longdiv-arc"]));
        }
        "\\phase" => {
            node.set_attribute("notation", "phasorangle");
            node.classes.push("phasor-bottom".to_string());
            node.children.push(mrow_with(&["phasor-angle"]));
        }
        "\\textcircled" => {
            node.set_attribute("notation", "circle");
            node.classes.push("circle-pad".to_string());
            node.children.push(mrow_with(&["textcircle"]));
        }
        "\\angl" => {
            node.set_attribute("notation", "actuarial");
            node.classes.push("actuarial".to_string());
        }
        "\\boxed" => {
            node.set_style("padding", "3pt");
            node.set_style("border", "1px solid");
            node.set_attribute("scriptlevel", "0");
            node.set_attribute("displaystyle", "true");
        }
        "\\fbox" => {
            node.set_attribute("notation", "box");
            node.classes.push("tml-fbox".to_string());
        }
        "\\fcolorbox" | "\\colorbox" => {
            node.set_style("padding", "0.3em");
            if label == "\\fcolorbox" {
                node.set_style(
                    "border",
                    format!("0.0667em solid {}", group.text("borderColor")),
                );
            }
        }
        _ => {}
    }
    if group.get("backgroundColor").truthy() {
        node.set_attribute("mathbackground", group.text("backgroundColor"));
    }
    Ok(Tree::Math(node))
}

fn raw(node: &V) -> R<String> {
    Ok(assert_node_type(node, "raw")?.text("string"))
}

/// `model` of `\colorbox` and `\fcolorbox`: the optional color model, `""` when there is none.
fn model(opt: &[V]) -> R<String> {
    if opt[0].truthy() {
        raw(&opt[0])
    } else {
        Ok(String::new())
    }
}

fn colorbox_handler(ctx: &mut Ctx, args: &[V], opt: &[V]) -> R<V> {
    let model = model(opt)?;
    let color = if !model.is_empty() {
        color_from_spec(&model, &raw(&args[0])?)?
    } else {
        validate_color(&raw(&args[0])?, &ctx.parser.gullet.macros, None)?
    };
    Ok(node! {"type" => "enclose", "mode" => ctx.parser.mode, "label" => &*ctx.func_name, "backgroundColor" => color}
        .with("body", args[1].clone()))
}

fn fcolorbox_handler(ctx: &mut Ctx, args: &[V], opt: &[V]) -> R<V> {
    let model = model(opt)?;
    let (border, background);
    if !model.is_empty() {
        // The source reads the background spec from `args[0]` too.
        let border_spec = raw(&args[0])?;
        let background_spec = raw(&args[0])?;
        border = color_from_spec(&model, &border_spec)?;
        background = color_from_spec(&model, &background_spec)?;
    } else {
        border = validate_color(&raw(&args[0])?, &ctx.parser.gullet.macros, None)?;
        background = validate_color(&raw(&args[1])?, &ctx.parser.gullet.macros, None)?;
    }
    Ok(node! {
        "type" => "enclose", "mode" => ctx.parser.mode, "label" => &*ctx.func_name,
        "backgroundColor" => background, "borderColor" => border
    }
    .with("body", args[2].clone()))
}

fn fbox_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    Ok(
        node! {"type" => "enclose", "mode" => ctx.parser.mode, "label" => "\\fbox"}
            .with("body", args[0].clone()),
    )
}

fn enclose_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    Ok(
        node! {"type" => "enclose", "mode" => ctx.parser.mode, "label" => &*ctx.func_name}
            .with("body", args[0].clone()),
    )
}

pub fn register(r: &mut Registry) {
    r.define(
        "enclose",
        &["\\colorbox"],
        Props {
            num_args: 2,
            num_optional_args: 1,
            allowed_in_text: true,
            arg_types: Some(&["raw", "raw", "text"]),
            ..Props::D
        },
        colorbox_handler,
        Some(builder),
    );
    r.define(
        "enclose",
        &["\\fcolorbox"],
        Props {
            num_args: 3,
            num_optional_args: 1,
            allowed_in_text: true,
            arg_types: Some(&["raw", "raw", "raw", "text"]),
            ..Props::D
        },
        fcolorbox_handler,
        Some(builder),
    );
    r.define(
        "enclose",
        &["\\fbox"],
        Props {
            num_args: 1,
            arg_types: Some(&["hbox"]),
            allowed_in_text: true,
            ..Props::D
        },
        fbox_handler,
        Some(builder),
    );
    r.define(
        "enclose",
        &[
            "\\angl",
            "\\cancel",
            "\\bcancel",
            "\\xcancel",
            "\\overline",
            "\\boxed",
            "\\longdiv",
            "\\phase",
        ],
        Props {
            num_args: 1,
            ..Props::D
        },
        enclose_handler,
        Some(builder),
    );
    r.define(
        "enclose",
        &["\\sout", "\\underline"],
        Props {
            num_args: 1,
            allowed_in_text: true,
            ..Props::D
        },
        enclose_handler,
        Some(builder),
    );
    r.define(
        "enclose",
        &["\\textcircled"],
        Props {
            num_args: 1,
            arg_types: Some(&["text"]),
            allowed_in_argument: true,
            allowed_in_text: true,
            ..Props::D
        },
        enclose_handler,
        Some(builder),
    );
}
