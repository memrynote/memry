//! `functions/text.js`, `font.js`, `styling.js` and `sqrt.js`.

use super::{Ctx, Props, Registry, normalize_argument, ordargument};
use crate::node;
use crate::web::extract::elements::math::temml::build::{
    build_expression, build_expression_row, build_group, consolidate_text,
};
use crate::web::extract::elements::math::temml::replace::variant_each_unit;
use crate::web::extract::elements::math::temml::style::Style;
use crate::web::extract::elements::math::temml::tree::{MathNode, Tree, wrap_with_mstyle};
use crate::web::extract::elements::math::temml::val::{R, V, jserr};
use crate::web::extract::utils::js::to_number;

fn style_with_font(group: &V, style: &Style) -> Style {
    let font = group.text("font");
    if font.is_empty() {
        return style.clone();
    }
    match font.as_str() {
        "\\textrm" | "\\textnormal" => style.with_text_font_family("textrm"),
        "\\textsf" => style.with_text_font_family("textsf"),
        "\\texttt" => style.with_text_font_family("texttt"),
        "\\textsc" => style.with_text_font_family("textsc"),
        "\\textbf" => style.with_text_font_weight("textbf"),
        "\\textmd" => style.with_text_font_weight("textmd"),
        "\\emph" => {
            if style.font_shape == "textit" {
                style.with_text_font_shape("textup")
            } else {
                style.with_text_font_shape("textit")
            }
        }
        "\\textit" => style.with_text_font_shape("textit"),
        "\\textup" => style.with_text_font_shape("textup"),
        // `\text`: `textFontShapes[font]` is undefined, which resets the shape.
        _ => style.with_text_font_shape(""),
    }
}

fn text_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    Ok(node! {
        "type" => "text",
        "mode" => ctx.parser.mode,
        "font" => ctx.func_name.clone(),
    }
    .with("body", ordargument(&args[0])))
}

fn text_builder(group: &V, style: &Style) -> R<Tree> {
    let new_style = style_with_font(group, style);
    let mrow = build_expression_row(&group.get("body").items(), &new_style, false)?;
    Ok(consolidate_text(mrow))
}

fn is_long_variable_name(group: &V, font: &str) -> R<bool> {
    let body = group.get("body");
    if !["mathrm", "mathit"].contains(&font)
        || !body.truthy()
        || !body.is_type("ordgroup")
        || body.get("body").len() == 1
    {
        return Ok(false);
    }
    let items = body.get("body").items();
    let Some(first) = items.first() else {
        return jserr("Cannot read properties of undefined (reading 'type')");
    };
    if !first.is_type("mathord") {
        return Ok(false);
    }
    for item in &items[1..] {
        let ty = item.ty();
        let numeric = match item.get("text") {
            V::Str(s) => !to_number(&s).is_nan(),
            _ => false,
        };
        if !(ty == "mathord" || (ty == "textord" && numeric)) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn text_child(t: &Tree) -> Option<String> {
    match t {
        Tree::Text(s) => Some(s.clone()),
        _ => None,
    }
}

fn font_builder(group: &V, style: &Style) -> R<Tree> {
    let font = group.text("font");
    let new_style = style.with_font(&font);
    let mut math_group = build_group(&group.get("body"), &new_style)?;
    let n_children = math_group.children_mut().map(|c| c.len());
    let Some(n_children) = n_children else {
        return jserr("Cannot read properties of undefined (reading 'length')");
    };
    if n_children == 0 {
        return Ok(math_group);
    }
    if font == "boldsymbol" && ["mo", "mpadded", "mrow"].contains(&math_group.ty()) {
        math_group.set_style("fontWeight", "bold")?;
        return Ok(math_group);
    }
    if is_long_variable_name(group, &font)? {
        return long_variable_name(math_group, &font);
    }
    let children = math_group.children_mut().expect("children");
    let mut can_consolidate = children[0].is_ty("mo");
    for child in children.iter_mut().skip(1) {
        if child.is_ty("mo") && font == "boldsymbol" {
            child.set_style("fontWeight", "bold")?;
        }
        if !child.is_ty("mi") {
            can_consolidate = false;
        }
        let local_variant = child
            .as_math()
            .and_then(|m| m.get_attribute("mathvariant"))
            .filter(|v| !v.is_empty())
            .unwrap_or("");
        if local_variant != "normal" {
            can_consolidate = false;
        }
    }
    if !can_consolidate {
        return Ok(math_group);
    }
    let mut rest: Vec<Tree> = Vec::new();
    for child in children.iter().skip(1) {
        let first = match child {
            Tree::Math(m) => m.children.first().cloned(),
            _ => None,
        };
        let Some(first) = first else {
            return jserr("Cannot read properties of undefined");
        };
        rest.push(first);
    }
    let Tree::Math(mi) = &mut children[0] else {
        return jserr("Cannot read properties of undefined (reading 'push')");
    };
    mi.children.extend(rest);
    if mi.get_attribute("mathvariant") == Some("normal") {
        let mi = children.remove(0);
        // `new MathNode("mtext", new TextNode(...))`: the children are a TextNode, which has no
        // length, so nothing is written.
        let bogus = Tree::Math(MathNode::new("mtext", Vec::new()));
        return Ok(Tree::Math(MathNode::new("mrow", vec![bogus, mi])));
    }
    Ok(children.remove(0))
}

fn long_variable_name(mut math_group: Tree, font: &str) -> R<Tree> {
    let children = math_group.children_mut().expect("children");
    // `mathGroup.children[0].children[0].children ? <that> : mathGroup.children[0]`.
    let nested = matches!(
        children[0].children_mut().and_then(|c| c.first()),
        Some(Tree::Math(_) | Tree::Frag(_) | Tree::Anchor(_) | Tree::Span(_))
    );
    let mut parts: Vec<String> = Vec::new();
    for child in children.iter_mut().skip(1) {
        let kids = child
            .children_mut()
            .ok_or_else(|| super::super::val::TErr {
                message: "TypeError".into(),
                parse: false,
                loc: false,
            })?;
        let first = kids.first_mut().ok_or_else(|| super::super::val::TErr {
            message: "TypeError".into(),
            parse: false,
            loc: false,
        })?;
        let text = match first {
            Tree::Text(t) => t.clone(),
            other => match other.children_mut().and_then(|c| c.first()) {
                Some(Tree::Text(t)) => t.clone(),
                _ => return jserr("Cannot read properties of undefined (reading 'text')"),
            },
        };
        parts.push(text);
    }
    let mut mi = if nested {
        match children[0].children_mut().and_then(|c| c.first_mut()) {
            Some(Tree::Math(m)) => m.clone(),
            _ => return jserr("unsupported long variable name"),
        }
    } else {
        match &children[0] {
            Tree::Math(m) => m.clone(),
            _ => return jserr("unsupported long variable name"),
        }
    };
    mi.attributes.retain(|(k, _)| k != "mathvariant");
    let Some(Tree::Text(first)) = mi.children.first_mut() else {
        return jserr("Cannot read properties of undefined (reading 'text')");
    };
    for p in parts {
        first.push_str(&p);
    }
    if font == "mathit" {
        *first = variant_each_unit(first, "italic");
        return Ok(Tree::Math(mi));
    }
    let _ = text_child;
    let mut mpadded = MathNode::new("mpadded", vec![Tree::Math(mi)]);
    mpadded.set_attribute("lspace", "0");
    Ok(Tree::Math(mpadded))
}

fn font_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    let body = normalize_argument(&args[0]);
    let func = match ctx.func_name.as_str() {
        "\\Bbb" => "\\mathbb",
        "\\bold" => "\\mathbf",
        "\\frak" => "\\mathfrak",
        "\\bm" => "\\boldsymbol",
        other => other,
    };
    Ok(node! {
        "type" => "font",
        "mode" => ctx.parser.mode,
        "font" => func.chars().skip(1).collect::<String>(),
    }
    .with("body", body))
}

fn old_font_handler(ctx: &mut Ctx, _args: &[V], _opt: &[V]) -> R<V> {
    let mode = ctx.parser.mode;
    let break_on = ctx.break_on_token_text.clone();
    let body = ctx
        .parser
        .parse_expression(true, break_on.as_deref(), true)?;
    let font_style = format!("math{}", ctx.func_name.chars().skip(1).collect::<String>());
    let inner = node! {"type" => "ordgroup", "mode" => ctx.parser.mode}.with("body", V::arr(body));
    Ok(node! {"type" => "font", "mode" => mode, "font" => font_style}.with("body", inner))
}

fn style_level(name: &str) -> i32 {
    match name {
        "display" => 0,
        "text" => 1,
        "script" => 2,
        _ => 3,
    }
}

fn styling_handler(ctx: &mut Ctx, _args: &[V], _opt: &[V]) -> R<V> {
    let break_on = ctx.break_on_token_text.clone();
    let body = ctx
        .parser
        .parse_expression(true, break_on.as_deref(), true)?;
    let name = ctx.func_name.clone();
    let script_level: String = name
        .chars()
        .skip(1)
        .take(name.chars().count() - 6)
        .collect();
    Ok(node! {
        "type" => "styling",
        "mode" => ctx.parser.mode,
        "scriptLevel" => script_level,
    }
    .with("body", V::arr(body)))
}

fn styling_builder(group: &V, style: &Style) -> R<Tree> {
    let level = group.text("scriptLevel");
    let new_style = style.with_level(style_level(&level));
    let inner = build_expression(&group.get("body").items(), &new_style, false)?;
    let mut node = wrap_with_mstyle(inner);
    let (scriptlevel, displaystyle) = match level.as_str() {
        "display" => ("0", "true"),
        "text" => ("0", "false"),
        "script" => ("1", "false"),
        _ => ("2", "false"),
    };
    crate::web::extract::elements::math::temml::build::set_attr(
        &mut node,
        "scriptlevel",
        scriptlevel,
    )?;
    crate::web::extract::elements::math::temml::build::set_attr(
        &mut node,
        "displaystyle",
        displaystyle,
    )?;
    Ok(node)
}

const X_HEIGHTS: [&str; 34] = [
    "a",
    "c",
    "e",
    "ı",
    "m",
    "n",
    "o",
    "r",
    "s",
    "u",
    "v",
    "w",
    "x",
    "z",
    "α",
    "ε",
    "ι",
    "κ",
    "ν",
    "ο",
    "π",
    "σ",
    "τ",
    "υ",
    "ω",
    "\\alpha",
    "\\epsilon",
    "\\iota",
    "\\kappa",
    "\\nu",
    "\\omega",
    "\\pi",
    "\\tau",
    "\\omega",
];

fn sqrt_handler(ctx: &mut Ctx, args: &[V], opt: &[V]) -> R<V> {
    let index = opt[0].clone();
    let body = args[0].clone();
    let inner = body.get("body");
    if inner.truthy()
        && inner.len() == 1
        && let Some(text) = inner.items()[0]
            .get("text")
            .as_string()
            .filter(|t| !t.is_empty())
        && X_HEIGHTS.contains(&text.as_str())
    {
        let size = |number: f64, unit: &str| {
            node! {"number" => number, "unit" => unit}
        };
        let rule = node! {"type" => "rule", "mode" => "math"}
            .with("shift", V::Null)
            .with("width", size(0.0, "pt"))
            .with("height", size(0.5, "em"));
        inner.push(rule);
    }
    Ok(node! {"type" => "sqrt", "mode" => ctx.parser.mode}
        .with("body", body)
        .with("index", index))
}

fn sqrt_builder(group: &V, style: &Style) -> R<Tree> {
    let body = group.get("body");
    let index = group.get("index");
    if index.truthy() {
        Ok(Tree::Math(MathNode::new(
            "mroot",
            vec![
                build_group(&body, style)?,
                build_group(&index, &style.increment_level())?,
            ],
        )))
    } else {
        Ok(Tree::Math(MathNode::new(
            "msqrt",
            vec![build_group(&body, style)?],
        )))
    }
}

pub fn register(r: &mut Registry) {
    r.define(
        "text",
        &[
            "\\text",
            "\\textrm",
            "\\textsf",
            "\\texttt",
            "\\textnormal",
            "\\textsc",
            "\\textbf",
            "\\textmd",
            "\\textit",
            "\\textup",
            "\\emph",
        ],
        Props {
            num_args: 1,
            arg_types: Some(&["text"]),
            allowed_in_argument: true,
            allowed_in_text: true,
            ..Props::D
        },
        text_handler,
        Some(text_builder),
    );
    r.define(
        "font",
        &[
            "\\mathrm",
            "\\mathit",
            "\\mathbf",
            "\\mathnormal",
            "\\up@greek",
            "\\boldsymbol",
            "\\mathbb",
            "\\mathcal",
            "\\mathfrak",
            "\\mathscr",
            "\\mathsf",
            "\\mathsfit",
            "\\mathtt",
            "\\Bbb",
            "\\bm",
            "\\bold",
            "\\frak",
        ],
        Props {
            num_args: 1,
            allowed_in_argument: true,
            ..Props::D
        },
        font_handler,
        Some(font_builder),
    );
    r.define(
        "font",
        &["\\rm", "\\sf", "\\tt", "\\bf", "\\it", "\\cal"],
        Props {
            allowed_in_text: true,
            ..Props::D
        },
        old_font_handler,
        Some(font_builder),
    );
    r.define(
        "styling",
        &[
            "\\displaystyle",
            "\\textstyle",
            "\\scriptstyle",
            "\\scriptscriptstyle",
        ],
        Props {
            allowed_in_text: true,
            primitive: true,
            ..Props::D
        },
        styling_handler,
        Some(styling_builder),
    );
    r.define(
        "sqrt",
        &["\\sqrt"],
        Props {
            num_args: 1,
            num_optional_args: 1,
            ..Props::D
        },
        sqrt_handler,
        Some(sqrt_builder),
    );
}
