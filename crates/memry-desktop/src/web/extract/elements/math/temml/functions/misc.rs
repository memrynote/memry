//! The small functions: `char.js`, `cr.js`, `relax.js`, `math.js`, `ordgroup.js`, `toggle.js`.

use super::{Ctx, Props, Registry, assert_node_type};
use crate::node;
use crate::web::extract::elements::math::temml::build::{build_expression, build_expression_row};
use crate::web::extract::elements::math::temml::style::Style;
use crate::web::extract::elements::math::temml::tree::{MathNode, Tree};
use crate::web::extract::elements::math::temml::units::calculate_size;
use crate::web::extract::elements::math::temml::val::{R, V, jserr, num_str, perr, perr_at};
use crate::web::extract::utils::js::parse_int;

fn char_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    let arg = assert_node_type(&args[0], "ordgroup")?;
    let mut number = String::new();
    for item in arg.get("body").items() {
        let n = assert_node_type(&item, "textord")?;
        number.push_str(&n.text("text"));
    }
    let Some(code) = parse_int(&number) else {
        return match &ctx.token {
            Some(t) => perr_at(format!("\\@char has non-numeric argument {number}"), t),
            None => perr(format!("\\@char has non-numeric argument {number}")),
        };
    };
    if !(0..=0x10FFFF).contains(&code) {
        return jserr("Invalid code point");
    }
    // A lone surrogate cannot live in a Rust string; it becomes U+FFFD as everywhere in the port.
    let ch = u32::try_from(code)
        .ok()
        .and_then(char::from_u32)
        .unwrap_or('\u{FFFD}');
    Ok(node! {"type" => "textord", "mode" => ctx.parser.mode, "text" => ch.to_string()})
}

fn cr_handler(ctx: &mut Ctx, _args: &[V], _opt: &[V]) -> R<V> {
    let parser = &mut *ctx.parser;
    let size = if parser.gullet.future()?.borrow().text == "[" {
        parser.parse_size_group(true)?
    } else {
        None
    };
    let new_line = !parser.settings.display_mode;
    let size_value = match size {
        Some(s) => assert_node_type(&s, "size")?.get("value"),
        None => V::Null,
    };
    Ok(
        node! {"type" => "cr", "mode" => parser.mode, "newLine" => new_line}
            .with("size", size_value),
    )
}

fn cr_builder(group: &V, style: &Style) -> R<Tree> {
    let mut node = MathNode::new("mo", Vec::new());
    if group.get("newLine").truthy() {
        node.set_attribute("linebreak", "newline");
        let size = group.get("size");
        if size.truthy() {
            let number = size.get("number").as_num().unwrap_or(f64::NAN);
            let s = calculate_size(number, &size.text("unit"), style)?;
            node.set_attribute("height", format!("{}{}", num_str(s.number), s.unit));
        }
    }
    Ok(Tree::Math(node))
}

fn relax_handler(ctx: &mut Ctx, _args: &[V], _opt: &[V]) -> R<V> {
    Ok(node! {"type" => "internal", "mode" => ctx.parser.mode})
}

fn math_handler(ctx: &mut Ctx, _args: &[V], _opt: &[V]) -> R<V> {
    let outer = ctx.parser.mode;
    ctx.parser.switch_mode("math");
    let close = if ctx.func_name == "\\(" { "\\)" } else { "$" };
    let body = ctx.parser.parse_expression(false, Some(close), false)?;
    ctx.parser.expect(close, true)?;
    ctx.parser.switch_mode(outer);
    Ok(node! {"type" => "ordgroup", "mode" => ctx.parser.mode}.with("body", V::arr(body)))
}

fn mismatched_handler(ctx: &mut Ctx, _args: &[V], _opt: &[V]) -> R<V> {
    perr(format!("Mismatched {}", ctx.func_name))
}

fn ordgroup_builder(group: &V, style: &Style) -> R<Tree> {
    build_expression_row(
        &group.get("body").items(),
        style,
        group.get("semisimple").truthy(),
    )
}

pub fn register(r: &mut Registry) {
    r.define(
        "textord",
        &["\\@char"],
        Props {
            num_args: 1,
            allowed_in_text: true,
            ..Props::D
        },
        char_handler,
        None,
    );
    r.define(
        "cr",
        &["\\\\"],
        Props {
            allowed_in_text: true,
            ..Props::D
        },
        cr_handler,
        Some(cr_builder),
    );
    r.define(
        "internal",
        &["\\relax"],
        Props {
            allowed_in_text: true,
            allowed_in_argument: true,
            ..Props::D
        },
        relax_handler,
        None,
    );
    r.define(
        "ordgroup",
        &["\\(", "$"],
        Props {
            allowed_in_text: true,
            allowed_in_math: false,
            ..Props::D
        },
        math_handler,
        None,
    );
    r.define(
        "text",
        &["\\)", "\\]"],
        Props {
            allowed_in_text: true,
            allowed_in_math: false,
            ..Props::D
        },
        mismatched_handler,
        None,
    );
    r.builder("ordgroup", ordgroup_builder);
}
