//! `functions/label.js`, `ref.js`, `mathchoice.js`, `sizing.js` and `sfrac.js`.

use super::{Ctx, Props, Registry, ordargument};
use crate::node;
use crate::web::extract::elements::math::temml::build::{build_expression, build_expression_row};
use crate::web::extract::elements::math::temml::style::Style;
use crate::web::extract::elements::math::temml::tree::{Anchor, MathNode, Tree, wrap_with_mstyle};
use crate::web::extract::elements::math::temml::units::to_fixed;
use crate::web::extract::elements::math::temml::val::{R, V, perr};

/// `/[^A-Za-z_0-9-]/g` removed.
fn valid_id(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect()
}

fn label_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    Ok(node! {
        "type" => "label",
        "mode" => ctx.parser.mode,
        "string" => valid_id(&args[0].text("string")),
    })
}

fn label_builder(group: &V, _style: &Style) -> R<Tree> {
    let mut node = MathNode::with_classes("mrow", Vec::new(), &["tml-label"]);
    let label = group.text("string");
    if !label.is_empty() {
        node.label = label;
    }
    Ok(Tree::Math(node))
}

fn ref_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    Ok(node! {
        "type" => "ref",
        "mode" => ctx.parser.mode,
        "funcName" => ctx.func_name.clone(),
        "string" => valid_id(&args[0].text("string")),
    })
}

fn ref_builder(group: &V, _style: &Style) -> R<Tree> {
    let classes = if group.text("funcName") == "\\ref" {
        vec!["tml-ref".to_string()]
    } else {
        vec!["tml-ref".to_string(), "tml-eqref".to_string()]
    };
    Ok(Tree::Anchor(Anchor {
        href: format!("#{}", group.text("string")),
        classes,
        children: Vec::new(),
    }))
}

fn mathchoice_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    Ok(node! {"type" => "mathchoice", "mode" => ctx.parser.mode}
        .with("display", ordargument(&args[0]))
        .with("text", ordargument(&args[1]))
        .with("script", ordargument(&args[2]))
        .with("scriptscript", ordargument(&args[3])))
}

fn mathchoice_builder(group: &V, style: &Style) -> R<Tree> {
    let body = match style.level {
        0 => group.get("display"),
        1 => group.get("text"),
        2 => group.get("script"),
        3 => group.get("scriptscript"),
        _ => group.get("text"),
    };
    build_expression_row(&body.items(), style, false)
}

fn size_map(name: &str) -> f64 {
    match name {
        "\\tiny" => 0.5,
        "\\sixptsize" | "\\Tiny" => 0.6,
        "\\scriptsize" => 0.7,
        "\\footnotesize" => 0.8,
        "\\small" => 0.9,
        "\\normalsize" => 1.0,
        "\\large" => 1.2,
        "\\Large" => 1.44,
        "\\LARGE" => 1.728,
        "\\huge" => 2.074,
        _ => 2.488,
    }
}

fn sizing_handler(ctx: &mut Ctx, _args: &[V], _opt: &[V]) -> R<V> {
    let break_on = ctx.break_on_token_text.clone();
    let body = ctx
        .parser
        .parse_expression(false, break_on.as_deref(), true)?;
    Ok(node! {
        "type" => "sizing",
        "mode" => ctx.parser.mode,
        "funcName" => ctx.func_name.clone(),
    }
    .with("body", V::arr(body)))
}

fn sizing_builder(group: &V, style: &Style) -> R<Tree> {
    let size = size_map(&group.text("funcName"));
    let new_style = style.with_font_size(size);
    let inner = build_expression(&group.get("body").items(), &new_style, false)?;
    let mut node = wrap_with_mstyle(inner);
    let factor = to_fixed(size / style.font_size, 4);
    crate::web::extract::elements::math::temml::build::set_attr(
        &mut node,
        "mathsize",
        &format!("{factor}em"),
    )?;
    Ok(node)
}

fn digits_of(node: &V, what: &str) -> R<String> {
    let mut out = String::new();
    for item in node.get("body").items() {
        let text = item.text("text");
        if !item.is_type("textord") || !(text.len() == 1 && text.as_bytes()[0].is_ascii_digit()) {
            return perr(format!("{what} must be an integer."));
        }
        out.push_str(&text);
    }
    Ok(out)
}

fn sfrac_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    let numerator = digits_of(&args[0], "Numerator")?;
    let denominator = digits_of(&args[1], "Denominator")?;
    Ok(node! {
        "type" => "sfrac",
        "mode" => ctx.parser.mode,
        "numerator" => numerator,
        "denominator" => denominator,
    })
}

fn sfrac_builder(group: &V, _style: &Style) -> R<Tree> {
    const SUBS: [char; 10] = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];
    const SUPS: [char; 10] = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
    let map = |s: String, table: &[char; 10]| -> String {
        s.chars()
            .map(|c| table[c.to_digit(10).unwrap_or(0) as usize])
            .collect()
    };
    let numerator = map(group.text("numerator"), &SUPS);
    let denominator = map(group.text("denominator"), &SUBS);
    Ok(Tree::Math(MathNode::with_classes(
        "mn",
        vec![Tree::Text(format!("{numerator}\u{2044}{denominator}"))],
        &["special-fraction"],
    )))
}

pub fn register(r: &mut Registry) {
    r.define(
        "label",
        &["\\label"],
        Props {
            num_args: 1,
            arg_types: Some(&["raw"]),
            ..Props::D
        },
        label_handler,
        Some(label_builder),
    );
    r.define(
        "ref",
        &["\\ref", "\\eqref"],
        Props {
            num_args: 1,
            arg_types: Some(&["raw"]),
            ..Props::D
        },
        ref_handler,
        Some(ref_builder),
    );
    r.define(
        "mathchoice",
        &["\\mathchoice"],
        Props {
            num_args: 4,
            primitive: true,
            ..Props::D
        },
        mathchoice_handler,
        Some(mathchoice_builder),
    );
    r.define(
        "sizing",
        &[
            "\\tiny",
            "\\sixptsize",
            "\\Tiny",
            "\\scriptsize",
            "\\footnotesize",
            "\\small",
            "\\normalsize",
            "\\large",
            "\\Large",
            "\\LARGE",
            "\\huge",
            "\\Huge",
        ],
        Props {
            allowed_in_text: true,
            ..Props::D
        },
        sizing_handler,
        Some(sizing_builder),
    );
    r.define(
        "sfrac",
        &["\\sfrac"],
        Props {
            num_args: 2,
            allowed_in_text: true,
            allowed_in_math: true,
            ..Props::D
        },
        sfrac_handler,
        Some(sfrac_builder),
    );
}
