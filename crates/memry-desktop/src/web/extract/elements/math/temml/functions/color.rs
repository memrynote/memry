//! `functions/color.js`.
//!
//! Not modelled: a colour *name* that is an `Object.prototype` member (`toString`, `constructor`,
//! ...) makes temml look up an inherited function in its `xcolors` table; the port treats it as
//! an unknown name.

use std::sync::LazyLock;

use regex::Regex;

use super::{Ctx, Props, Registry, assert_node_type, ordargument};
use crate::node;
use crate::web::extract::elements::math::temml::build::build_expression;
use crate::web::extract::elements::math::temml::macro_expander::{Expansion, MacroDef, Namespace};
use crate::web::extract::elements::math::temml::style::Style;
use crate::web::extract::elements::math::temml::tree::{MathNode, Tree};
use crate::web::extract::elements::math::temml::units::to_fixed;
use crate::web::extract::elements::math::temml::val::{R, Tok, V, perr, perr_at, tok};
use crate::web::extract::utils::js::{to_number, trim};

static HTML: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u)^(#[a-f0-9]{3}|#?[a-f0-9]{6})$").expect("regex"));
static HTML_OR_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u)^(#[a-f0-9]{3}|#?[a-f0-9]{6}|[a-z]+)$").expect("regex"));
static RGB_INT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^ *[0-9]{1,3} *(?:, *[0-9]{1,3} *){2}$").expect("regex"));
static RGB_FRAC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^ *[10](?:\.[0-9]*)? *(?:, *[10](?:\.[0-9]*)? *){2}$").expect("regex")
});
static XCOLOR_HTML: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u)^[a-f0-9]{6}$").expect("regex"));

fn to_hex(num: f64) -> String {
    let n = num as i64;
    let s = format!("{n:x}");
    if s.len() == 1 { format!("0{s}") } else { s }
}

const XCOLORS: &[(&str, &str)] = &[
    ("Apricot", "#ffb484"),
    ("Aquamarine", "#08b4bc"),
    ("Bittersweet", "#c84c14"),
    ("blue", "#0000FF"),
    ("Blue", "#303494"),
    ("BlueGreen", "#08b4bc"),
    ("BlueViolet", "#503c94"),
    ("BrickRed", "#b8341c"),
    ("brown", "#BF8040"),
    ("Brown", "#802404"),
    ("BurntOrange", "#f8941c"),
    ("CadetBlue", "#78749c"),
    ("CarnationPink", "#f884b4"),
    ("Cerulean", "#08a4e4"),
    ("CornflowerBlue", "#40ace4"),
    ("cyan", "#00FFFF"),
    ("Cyan", "#08acec"),
    ("Dandelion", "#ffbc44"),
    ("darkgray", "#404040"),
    ("DarkOrchid", "#a8548c"),
    ("Emerald", "#08ac9c"),
    ("ForestGreen", "#089c54"),
    ("Fuchsia", "#90348c"),
    ("Goldenrod", "#ffdc44"),
    ("gray", "#808080"),
    ("Gray", "#98949c"),
    ("green", "#00FF00"),
    ("Green", "#08a44c"),
    ("GreenYellow", "#e0e474"),
    ("JungleGreen", "#08ac9c"),
    ("Lavender", "#f89cc4"),
    ("lightgray", "#c0c0c0"),
    ("lime", "#BFFF00"),
    ("LimeGreen", "#90c43c"),
    ("magenta", "#FF00FF"),
    ("Magenta", "#f0048c"),
    ("Mahogany", "#b0341c"),
    ("Maroon", "#b03434"),
    ("Melon", "#f89c7c"),
    ("MidnightBlue", "#086494"),
    ("Mulberry", "#b03c94"),
    ("NavyBlue", "#086cbc"),
    ("olive", "#7F7F00"),
    ("OliveGreen", "#407c34"),
    ("orange", "#FF8000"),
    ("Orange", "#f8843c"),
    ("OrangeRed", "#f0145c"),
    ("Orchid", "#b074ac"),
    ("Peach", "#f8945c"),
    ("Periwinkle", "#8074bc"),
    ("PineGreen", "#088c74"),
    ("pink", "#ff7f7f"),
    ("Plum", "#98248c"),
    ("ProcessBlue", "#08b4ec"),
    ("purple", "#BF0040"),
    ("Purple", "#a0449c"),
    ("RawSienna", "#983c04"),
    ("red", "#ff0000"),
    ("Red", "#f01c24"),
    ("RedOrange", "#f86434"),
    ("RedViolet", "#a0246c"),
    ("Rhodamine", "#f0549c"),
    ("Royallue", "#0874bc"),
    ("RoyalPurple", "#683c9c"),
    ("RubineRed", "#f0047c"),
    ("Salmon", "#f8948c"),
    ("SeaGreen", "#30bc9c"),
    ("Sepia", "#701404"),
    ("SkyBlue", "#48c4dc"),
    ("SpringGreen", "#c8dc64"),
    ("Tan", "#e09c74"),
    ("teal", "#007F7F"),
    ("TealBlue", "#08acb4"),
    ("Thistle", "#d884b4"),
    ("Turquoise", "#08b4cc"),
    ("violet", "#800080"),
    ("Violet", "#60449c"),
    ("VioletRed", "#f054a4"),
    ("WildStrawberry", "#f0246c"),
];

const XCOLORS_YELLOW: [(&str, &str); 4] = [
    ("yellow", "#FFFF00"),
    ("Yellow", "#fff404"),
    ("YellowGreen", "#98cc6c"),
    ("YellowOrange", "#ffa41c"),
];

fn xcolor(name: &str) -> Option<&'static str> {
    XCOLORS
        .iter()
        .chain(XCOLORS_YELLOW.iter())
        .find(|(k, _)| *k == name)
        .map(|(_, v)| *v)
}

/// `colorFromSpec(model, spec)`.
pub fn color_from_spec(model: &str, spec: &str) -> R<String> {
    let mut color = String::new();
    if model == "HTML" {
        if !HTML.is_match(spec) {
            return perr("Invalid HTML input.");
        }
        color = spec.to_string();
    } else if model == "RGB" {
        if !RGB_INT.is_match(spec) {
            return perr("Invalid RGB input.");
        }
        for e in spec.split(',') {
            color.push_str(&to_hex(to_number(trim(e))));
        }
    } else {
        if !RGB_FRAC.is_match(spec) {
            return perr("Invalid rbg input.");
        }
        for e in spec.split(',') {
            let num = to_number(trim(e));
            if num > 1.0 {
                return perr("Color rgb input must be < 1.");
            }
            color.push_str(&to_hex(to_number(&to_fixed(num * 255.0, 0))));
        }
    }
    if !color.starts_with('#') {
        color = format!("#{color}");
    }
    Ok(color)
}

/// `validateColor(color, macros, token)`.
pub fn validate_color(color: &str, macros: &Namespace, token: Option<&Tok>) -> R<String> {
    let macro_name = format!("\\\\color@{color}");
    if !HTML_OR_NAME.is_match(color) {
        return match token {
            Some(t) => perr_at(format!("Invalid color: '{color}'"), t),
            None => perr(format!("Invalid color: '{color}'")),
        };
    }
    if XCOLOR_HTML.is_match(color) {
        return Ok(format!("#{color}"));
    } else if color.starts_with('#') {
        return Ok(color.to_string());
    } else if macros.has(&macro_name) {
        if let Some(MacroDef::Exp(e)) = macros.get(&macro_name)
            && let Some(first) = e.tokens.first()
        {
            return Ok(first.borrow().text.clone());
        }
        return super::super::val::jserr("Cannot read properties of undefined (reading 'tokens')");
    } else if let Some(c) = xcolor(color) {
        return Ok(c.to_string());
    }
    Ok(color.to_string())
}

fn mathml_builder(group: &V, style: &Style) -> R<Tree> {
    let color = group.text("color");
    let mut expr = build_expression(&group.get("body").items(), &style.with_color(&color), false)?;
    if expr.is_empty() {
        expr.push(Tree::Math(MathNode::new("mrow", Vec::new())));
    }
    for e in &mut expr {
        e.set_style("color", color.clone())?;
    }
    Ok(Tree::frag(expr))
}

fn raw_string(node: &V) -> R<String> {
    Ok(assert_node_type(node, "raw")?.text("string"))
}

fn textcolor_handler(ctx: &mut Ctx, args: &[V], opt: &[V]) -> R<V> {
    let model = if opt[0].truthy() { raw_string(&opt[0])? } else { String::new() };
    let color = if !model.is_empty() {
        color_from_spec(&model, &raw_string(&args[0])?)?
    } else {
        validate_color(&raw_string(&args[0])?, &ctx.parser.gullet.macros, ctx.token.as_ref())?
    };
    Ok(node! {
        "type" => "color",
        "mode" => ctx.parser.mode,
        "color" => color,
        "isTextColor" => true,
    }
    .with("body", ordargument(&args[1])))
}

fn color_handler(ctx: &mut Ctx, args: &[V], opt: &[V]) -> R<V> {
    let model = if opt[0].truthy() { raw_string(&opt[0])? } else { String::new() };
    let color = if !model.is_empty() {
        color_from_spec(&model, &raw_string(&args[0])?)?
    } else {
        validate_color(&raw_string(&args[0])?, &ctx.parser.gullet.macros, ctx.token.as_ref())?
    };
    let break_on = ctx.break_on_token_text.clone();
    let body = ctx.parser.parse_expression(true, break_on.as_deref(), true)?;
    Ok(node! {
        "type" => "color",
        "mode" => ctx.parser.mode,
        "color" => color,
        "isTextColor" => false,
    }
    .with("body", V::arr(body)))
}

fn definecolor_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    let name = raw_string(&args[0])?;
    if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphabetic()) {
        return match &ctx.token {
            Some(t) => perr_at("Color name must be latin letters.", t),
            None => perr("Color name must be latin letters."),
        };
    }
    let model = raw_string(&args[1])?;
    if !["HTML", "RGB", "rgb"].contains(&model.as_str()) {
        return match &ctx.token {
            Some(t) => perr_at("Color model must be HTML, RGB, or rgb.", t),
            None => perr("Color model must be HTML, RGB, or rgb."),
        };
    }
    let color = color_from_spec(&model, &raw_string(&args[2])?)?;
    let expansion = Expansion {
        tokens: vec![tok(color, None)],
        num_args: 0,
        delimiters: None,
        unexpandable: false,
    };
    ctx.parser
        .gullet
        .macros
        .set(&format!("\\\\color@{name}"), MacroDef::Exp(std::rc::Rc::new(expansion)), false);
    Ok(node! {"type" => "internal", "mode" => ctx.parser.mode})
}

pub fn register(r: &mut Registry) {
    r.define(
        "color",
        &["\\textcolor"],
        Props {
            num_args: 2,
            num_optional_args: 1,
            allowed_in_text: true,
            arg_types: Some(&["raw", "raw", "original"]),
            ..Props::D
        },
        textcolor_handler,
        Some(mathml_builder),
    );
    r.define(
        "color",
        &["\\color"],
        Props {
            num_args: 1,
            num_optional_args: 1,
            allowed_in_text: true,
            arg_types: Some(&["raw", "raw"]),
            ..Props::D
        },
        color_handler,
        Some(mathml_builder),
    );
    r.define(
        "color",
        &["\\definecolor"],
        Props {
            num_args: 3,
            allowed_in_text: true,
            arg_types: Some(&["raw", "raw", "raw"]),
            ..Props::D
        },
        definecolor_handler,
        None,
    );
}
