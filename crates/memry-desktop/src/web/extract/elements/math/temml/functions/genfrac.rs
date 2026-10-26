//! `functions/genfrac.js`: fractions, binomials and the infix `\over` family.

use super::{Ctx, Props, Registry, assert_node_type, normalize_argument};
use crate::node;
use crate::web::extract::elements::math::temml::build::{build_group, make_row, set_attr};
use crate::web::extract::elements::math::temml::style::Style;
use crate::web::extract::elements::math::temml::tree::{MathNode, Tree};
use crate::web::extract::elements::math::temml::units::calculate_size;
use crate::web::extract::elements::math::temml::val::{R, V, jserr, num_str};
use crate::web::extract::utils::js::to_number;

fn adjust_style(function_size: Option<&str>, original: &Style) -> Style {
    match function_size {
        Some("display") => original.with_level(if original.level >= 2 { 1 } else { 0 }),
        Some("text") if original.level == 0 => original.with_level(1),
        Some("auto") => original.increment_level(),
        Some("script") => original.with_level(2),
        Some("scriptscript") => original.with_level(3),
        _ => original.clone(),
    }
}

fn script_level_number(name: Option<&str>) -> String {
    match name {
        Some("auto") => "-1",
        Some("display") | Some("text") => "0",
        Some("script") => "1",
        Some("scriptscript") => "2",
        _ => "undefined",
    }
    .to_string()
}

fn builder(group: &V, style: &Style) -> R<Tree> {
    let script_level = group.get("scriptLevel").as_string();
    let style = adjust_style(script_level.as_deref(), style);
    let mut numer = build_group(&group.get("numer"), &style)?;
    let mut denom = build_group(&group.get("denom"), &style)?;
    if style.level == 3 {
        numer.set_style("mathDepth", "2")?;
        set_attr(&mut numer, "scriptlevel", "2")?;
        denom.set_style("mathDepth", "2")?;
        set_attr(&mut denom, "scriptlevel", "2")?;
    }
    let mut node = MathNode::new("mfrac", vec![numer, denom]);
    let bar_size = group.get("barSize");
    if !group.get("hasBarLine").truthy() {
        node.set_attribute("linethickness", "0px");
    } else if bar_size.truthy() {
        let n = bar_size.get("number").as_num().unwrap_or(f64::NAN);
        let rule = calculate_size(n, &bar_size.text("unit"), &style)?;
        node.set_attribute(
            "linethickness",
            format!("{}{}", num_str(rule.number), rule.unit),
        );
    }
    let left = group.get("leftDelim");
    let right = group.get("rightDelim");
    let mut result = Tree::Math(node);
    if !left.is_nullish() || !right.is_nullish() {
        let mut with_delims = Vec::new();
        let fence = |d: &V| -> Tree {
            let text = d
                .as_string()
                .unwrap_or_else(|| "undefined".to_string())
                .replacen('\\', "", 1);
            let mut op = MathNode::new("mo", vec![Tree::Text(text)]);
            op.set_attribute("fence", "true");
            Tree::Math(op)
        };
        if !left.is_nullish() {
            with_delims.push(fence(&left));
        }
        with_delims.push(result);
        if !right.is_nullish() {
            with_delims.push(fence(&right));
        }
        result = make_row(with_delims, false);
    }
    if script_level.as_deref() != Some("auto") {
        let mut wrapper = MathNode::new("mstyle", vec![result]);
        wrapper.set_attribute(
            "displaystyle",
            if script_level.as_deref() == Some("display") {
                "true"
            } else {
                "false"
            },
        );
        wrapper.set_attribute("scriptlevel", script_level_number(script_level.as_deref()));
        result = Tree::Math(wrapper);
    }
    Ok(result)
}

fn genfrac_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    let name = ctx.func_name.as_str();
    let (has_bar_line, left, right) = match name {
        "\\cfrac" | "\\dfrac" | "\\frac" | "\\tfrac" => (true, V::Null, V::Null),
        "\\\\atopfrac" => (false, V::Null, V::Null),
        "\\dbinom" | "\\binom" | "\\tbinom" => (false, V::str("("), V::str(")")),
        "\\\\bracefrac" => (false, V::str("\\{"), V::str("\\}")),
        "\\\\brackfrac" => (false, V::str("["), V::str("]")),
        _ => return jserr("Unrecognized genfrac command"),
    };
    let script_level = if name == "\\cfrac" || name.starts_with("\\d") {
        "display"
    } else if name.starts_with("\\t") {
        "text"
    } else {
        "auto"
    };
    Ok(node! {
        "type" => "genfrac",
        "mode" => ctx.parser.mode,
        "continued" => false,
        "hasBarLine" => has_bar_line,
        "scriptLevel" => script_level,
    }
    .with("numer", args[0].clone())
    .with("denom", args[1].clone())
    .with("leftDelim", left)
    .with("rightDelim", right)
    .with("barSize", V::Null))
}

fn infix_handler(ctx: &mut Ctx, _args: &[V], _opt: &[V]) -> R<V> {
    let replace_with = match ctx.func_name.as_str() {
        "\\over" => "\\frac",
        "\\choose" => "\\binom",
        "\\atop" => "\\\\atopfrac",
        "\\brace" => "\\\\bracefrac",
        "\\brack" => "\\\\brackfrac",
        _ => return jserr("Unrecognized infix genfrac command"),
    };
    let n = node! {"type" => "infix", "mode" => ctx.parser.mode, "replaceWith" => replace_with};
    if let Some(t) = &ctx.token {
        n.set("token", V::Tok(t.clone()));
    }
    Ok(n)
}

fn delim_from_value(delim: &str) -> V {
    if !delim.is_empty() && delim != "." {
        V::str(delim)
    } else {
        V::Null
    }
}

fn genfrac_full_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    let numer = args[4].clone();
    let denom = args[5].clone();
    let left_node = normalize_argument(&args[0]);
    let left = if left_node.is_type("atom") && left_node.text("family") == "open" {
        delim_from_value(&left_node.text("text"))
    } else {
        V::Null
    };
    let right_node = normalize_argument(&args[1]);
    let right = if right_node.is_type("atom") && right_node.text("family") == "close" {
        delim_from_value(&right_node.text("text"))
    } else {
        V::Null
    };
    let bar_node = assert_node_type(&args[2], "size")?;
    let has_bar_line;
    let mut bar_size = V::Null;
    if bar_node.get("isBlank").truthy() {
        has_bar_line = true;
    } else {
        bar_size = bar_node.get("value");
        has_bar_line = bar_size.get("number").as_num().unwrap_or(f64::NAN) > 0.0;
    }
    let styl_array = ["display", "text", "script", "scriptscript"];
    let level = |text: &str| -> V {
        let n = to_number(text);
        if n.fract() == 0.0 && (0.0..4.0).contains(&n) {
            V::str(styl_array[n as usize])
        } else {
            V::Undef
        }
    };
    let mut script_level = V::str("auto");
    let styl = &args[3];
    if styl.is_type("ordgroup") {
        let body = styl.get("body");
        if body.len() > 0 {
            let text_ord = assert_node_type(&body.items()[0], "textord")?;
            script_level = level(&text_ord.text("text"));
        }
    } else {
        let t = assert_node_type(styl, "textord")?;
        script_level = level(&t.text("text"));
    }
    Ok(node! {
        "type" => "genfrac",
        "mode" => ctx.parser.mode,
        "continued" => false,
        "hasBarLine" => has_bar_line,
    }
    .with("numer", numer)
    .with("denom", denom)
    .with("barSize", bar_size)
    .with("leftDelim", left)
    .with("rightDelim", right)
    .with("scriptLevel", script_level))
}

fn above_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    let n = node! {"type" => "infix", "mode" => ctx.parser.mode, "replaceWith" => "\\\\abovefrac"}
        .with("barSize", assert_node_type(&args[0], "size")?.get("value"));
    if let Some(t) = &ctx.token {
        n.set("token", V::Tok(t.clone()));
    }
    Ok(n)
}

fn abovefrac_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    let bar_size = assert_node_type(&args[1], "infix")?.get("barSize");
    if !bar_size.truthy() {
        return jserr("Expected non-null, but got undefined");
    }
    let has_bar_line = bar_size.get("number").as_num().unwrap_or(f64::NAN) > 0.0;
    Ok(node! {
        "type" => "genfrac",
        "mode" => ctx.parser.mode,
        "continued" => false,
        "hasBarLine" => has_bar_line,
        "scriptLevel" => "auto",
    }
    .with("numer", args[0].clone())
    .with("denom", args[2].clone())
    .with("barSize", bar_size)
    .with("leftDelim", V::Null)
    .with("rightDelim", V::Null))
}

pub fn register(r: &mut Registry) {
    r.define(
        "genfrac",
        &[
            "\\cfrac",
            "\\dfrac",
            "\\frac",
            "\\tfrac",
            "\\dbinom",
            "\\binom",
            "\\tbinom",
            "\\\\atopfrac",
            "\\\\bracefrac",
            "\\\\brackfrac",
        ],
        Props {
            num_args: 2,
            allowed_in_argument: true,
            ..Props::D
        },
        genfrac_handler,
        Some(builder),
    );
    r.define(
        "infix",
        &["\\over", "\\choose", "\\atop", "\\brace", "\\brack"],
        Props {
            infix: true,
            ..Props::D
        },
        infix_handler,
        None,
    );
    r.define(
        "genfrac",
        &["\\genfrac"],
        Props {
            num_args: 6,
            allowed_in_argument: true,
            arg_types: Some(&["math", "math", "size", "text", "math", "math"]),
            ..Props::D
        },
        genfrac_full_handler,
        Some(builder),
    );
    r.define(
        "infix",
        &["\\above"],
        Props {
            num_args: 1,
            arg_types: Some(&["size"]),
            infix: true,
            ..Props::D
        },
        above_handler,
        None,
    );
    r.define(
        "genfrac",
        &["\\\\abovefrac"],
        Props {
            num_args: 3,
            arg_types: Some(&["math", "size", "math"]),
            ..Props::D
        },
        abovefrac_handler,
        Some(builder),
    );
}
