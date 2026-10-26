//! `kern.js`, `rule.js`, `verb.js`, `phantom.js`, `lap.js`, `raise.js`, `smash.js`, `vcenter.js`,
//! `hbox.js`, `pmb.js`, `not.js`, `reflect.js`, `label.js`, `ref.js`, `mathchoice.js`,
//! `sizing.js`, `sfrac.js`.

use super::{Ctx, Props, Registry, assert_node_type, is_character_box, ordargument};
use crate::node;
use crate::web::extract::elements::math::temml::build::{
    build_expression, build_expression_row, build_group, consolidate_text,
};
use crate::web::extract::elements::math::temml::style::Style;
use crate::web::extract::elements::math::temml::tables::symbol;
use crate::web::extract::elements::math::temml::tree::{Anchor, MathNode, Tree, wrap_with_mstyle};
use crate::web::extract::elements::math::temml::units::{calculate_size, to_fixed};
use crate::web::extract::elements::math::temml::val::{R, V, jserr, num_str, perr};

fn size_of(dimension: &V) -> (f64, String) {
    (
        dimension.get("number").as_num().unwrap_or(f64::NAN),
        dimension.text("unit"),
    )
}

fn space_character(width: f64) -> &'static str {
    if (0.05555..=0.05556).contains(&width) {
        "\u{200a}"
    } else if (0.1666..=0.1667).contains(&width) {
        "\u{2009}"
    } else if (0.2222..=0.2223).contains(&width) {
        "\u{2005}"
    } else if (0.2777..=0.2778).contains(&width) {
        "\u{2005}\u{200a}"
    } else {
        ""
    }
}

fn kern_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    let size = assert_node_type(&args[0], "size")?;
    Ok(node! {"type" => "kern", "mode" => ctx.parser.mode}.with("dimension", size.get("value")))
}

fn kern_builder(group: &V, style: &Style) -> R<Tree> {
    let (number, unit) = size_of(&group.get("dimension"));
    let d = calculate_size(number, &unit, style)?;
    let ch = if d.number > 0.0 && d.unit == "em" {
        space_character(d.number)
    } else {
        ""
    };
    if group.text("mode") == "text" && !ch.is_empty() {
        return Ok(Tree::Math(MathNode::new(
            "mtext",
            vec![Tree::Text(ch.to_string())],
        )));
    }
    if d.number >= 0.0 {
        let mut node = MathNode::new("mspace", Vec::new());
        node.set_attribute("width", format!("{}{}", num_str(d.number), d.unit));
        Ok(Tree::Math(node))
    } else {
        let mut node = MathNode::new("mrow", Vec::new());
        node.set_style("marginLeft", format!("{}{}", num_str(d.number), d.unit));
        Ok(Tree::Math(node))
    }
}

fn rule_handler(ctx: &mut Ctx, args: &[V], opt: &[V]) -> R<V> {
    let shift = if opt[0].truthy() {
        assert_node_type(&opt[0], "size")?.get("value")
    } else {
        opt[0].clone()
    };
    let width = assert_node_type(&args[0], "size")?;
    let height = assert_node_type(&args[1], "size")?;
    Ok(node! {"type" => "rule", "mode" => ctx.parser.mode}
        .with("shift", shift)
        .with("width", width.get("value"))
        .with("height", height.get("value")))
}

fn rule_builder(group: &V, style: &Style) -> R<Tree> {
    let (wn, wu) = size_of(&group.get("width"));
    let (hn, hu) = size_of(&group.get("height"));
    let width = calculate_size(wn, &wu, style)?;
    let height = calculate_size(hn, &hu, style)?;
    let shift_v = group.get("shift");
    let (shift_number, shift_unit) = if shift_v.truthy() {
        let (n, u) = size_of(&shift_v);
        let s = calculate_size(n, &u, style)?;
        (s.number, s.unit)
    } else {
        (0.0, "em")
    };
    let color = style
        .color
        .clone()
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| "black".to_string());
    let mut rule = MathNode::new("mspace", Vec::new());
    if width.number > 0.0 && height.number > 0.0 {
        rule.set_attribute("mathbackground", color);
    }
    rule.set_attribute("width", format!("{}{}", num_str(width.number), width.unit));
    rule.set_attribute(
        "height",
        format!("{}{}", num_str(height.number), height.unit),
    );
    if shift_number == 0.0 {
        return Ok(Tree::Math(rule));
    }
    let mut wrapper = MathNode::new("mpadded", vec![Tree::Math(rule)]);
    let shift = format!("{}{}", num_str(shift_number), shift_unit);
    if shift_number >= 0.0 {
        wrapper.set_attribute("height", format!("+{shift}"));
    } else {
        wrapper.set_attribute("height", shift.clone());
        wrapper.set_attribute(
            "depth",
            format!("+{}{}", num_str(-shift_number), shift_unit),
        );
    }
    wrapper.set_attribute("voffset", shift);
    Ok(Tree::Math(wrapper))
}

fn verb_handler(_ctx: &mut Ctx, _args: &[V], _opt: &[V]) -> R<V> {
    perr("\\verb ended by end of line instead of matching delimiter")
}

fn verb_builder(group: &V, _style: &Style) -> R<Tree> {
    let body = group.text("body");
    let space = if group.get("star").truthy() {
        "\u{2423}"
    } else {
        "\u{a0}"
    };
    let mut node = MathNode::new("mtext", vec![Tree::Text(body.replace(' ', space))]);
    node.set_attribute("mathvariant", "monospace");
    Ok(Tree::Math(node))
}

fn phantom_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    Ok(node! {"type" => "phantom", "mode" => ctx.parser.mode}.with("body", ordargument(&args[0])))
}

fn phantom_builder(group: &V, style: &Style) -> R<Tree> {
    let inner = build_expression(&group.get("body").items(), style, false)?;
    Ok(Tree::Math(MathNode::new("mphantom", inner)))
}

fn hphantom_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    Ok(node! {"type" => "hphantom", "mode" => ctx.parser.mode}.with("body", args[0].clone()))
}

fn hphantom_builder(group: &V, style: &Style) -> R<Tree> {
    let inner = build_expression(&ordargument(&group.get("body")).items(), style, false)?;
    let phantom = MathNode::new("mphantom", inner);
    let mut node = MathNode::new("mpadded", vec![Tree::Math(phantom)]);
    node.set_attribute("height", "0px");
    node.set_attribute("depth", "0px");
    Ok(Tree::Math(node))
}

fn vphantom_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    Ok(node! {"type" => "vphantom", "mode" => ctx.parser.mode}.with("body", args[0].clone()))
}

fn vphantom_builder(group: &V, style: &Style) -> R<Tree> {
    let inner = build_expression(&ordargument(&group.get("body")).items(), style, false)?;
    let phantom = MathNode::new("mphantom", inner);
    let mut node = MathNode::new("mpadded", vec![Tree::Math(phantom)]);
    node.set_attribute("width", "0.1px");
    Ok(Tree::Math(node))
}

fn lap_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    let name = ctx.func_name.as_str();
    let alignment = if ["\\clap", "\\llap", "\\rlap"].contains(&name) {
        name.chars().skip(1).collect::<String>()
    } else {
        name.chars().skip(5).collect::<String>()
    };
    Ok(
        node! {"type" => "lap", "mode" => ctx.parser.mode, "alignment" => alignment}
            .with("body", args[0].clone()),
    )
}

fn lap_builder(group: &V, style: &Style) -> R<Tree> {
    let alignment = group.text("alignment");
    let body = group.get("body");
    let mut strut = None;
    if alignment == "llap" {
        let phantom_inner = build_expression(&ordargument(&body).items(), style, false)?;
        let phantom = MathNode::new("mphantom", phantom_inner);
        let mut s = MathNode::new("mpadded", vec![Tree::Math(phantom)]);
        s.set_attribute("width", "0.1px");
        strut = Some(Tree::Math(s));
    }
    let mut inner = build_group(&body, style)?;
    let mut node;
    if alignment == "llap" {
        inner.set_style("position", "absolute")?;
        inner.set_style("right", "0")?;
        inner.set_style("bottom", "0")?;
        node = MathNode::new("mpadded", vec![strut.expect("llap"), inner]);
    } else {
        node = MathNode::new("mpadded", vec![inner]);
    }
    if alignment == "rlap" {
        let items = body.get("body");
        if items.len() > 0 && items.items()[0].is_type("genfrac") {
            node.set_attribute("lspace", "0.16667em");
        }
    } else {
        let offset = if alignment == "llap" { "-1" } else { "-0.5" };
        node.set_attribute("lspace", format!("{offset}width"));
        if alignment == "llap" {
            node.set_style("position", "relative");
        } else {
            node.set_style("display", "flex");
            node.set_style("justifyContent", "center");
        }
    }
    node.set_attribute("width", "0.1px");
    Ok(Tree::Math(node))
}

fn raise_builder(group: &V, style: &Style) -> R<Tree> {
    let new_style = style.with_level(1);
    let body = build_group(&group.get("body"), &new_style)?;
    let mut node = MathNode::new("mpadded", vec![body]);
    let (n, u) = size_of(&group.get("dy"));
    let dy = calculate_size(n, &u, style)?;
    let dy_s = format!("{}{}", num_str(dy.number), dy.unit);
    node.set_attribute("voffset", dy_s.clone());
    if dy.number > 0.0 {
        node.set_style("padding", format!("{dy_s} 0 0 0"));
    } else {
        node.set_style(
            "padding",
            format!("0 0 {}{} 0", num_str(dy.number.abs()), dy.unit),
        );
    }
    Ok(Tree::Math(node))
}

fn raise_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    let amount = assert_node_type(&args[0], "size")?.get("value");
    if ctx.func_name == "\\lower" {
        let n = amount.get("number").as_num().unwrap_or(f64::NAN);
        amount.set("number", V::Num(n * -1.0));
    }
    Ok(node! {"type" => "raise", "mode" => ctx.parser.mode}
        .with("dy", amount)
        .with("body", args[1].clone()))
}

fn raisebox_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    let amount = assert_node_type(&args[0], "size")?.get("value");
    Ok(node! {"type" => "raise", "mode" => ctx.parser.mode}
        .with("dy", amount)
        .with("body", args[1].clone()))
}

fn smash_handler(ctx: &mut Ctx, args: &[V], opt: &[V]) -> R<V> {
    let mut smash_height = false;
    let mut smash_depth = false;
    if opt[0].truthy() {
        let tb = assert_node_type(&opt[0], "ordgroup")?;
        for node in tb.get("body").items() {
            match node.get("text").as_string().as_deref() {
                Some("t") => smash_height = true,
                Some("b") => smash_depth = true,
                _ => {
                    smash_height = false;
                    smash_depth = false;
                    break;
                }
            }
        }
    } else {
        smash_height = true;
        smash_depth = true;
    }
    Ok(node! {
        "type" => "smash",
        "mode" => ctx.parser.mode,
        "smashHeight" => smash_height,
        "smashDepth" => smash_depth,
    }
    .with("body", args[0].clone()))
}

fn smash_builder(group: &V, style: &Style) -> R<Tree> {
    let mut node = MathNode::new("mpadded", vec![build_group(&group.get("body"), style)?]);
    if group.get("smashHeight").truthy() {
        node.set_attribute("height", "0px");
    }
    if group.get("smashDepth").truthy() {
        node.set_attribute("depth", "0px");
    }
    Ok(Tree::Math(node))
}

fn vcenter_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    Ok(node! {"type" => "vcenter", "mode" => ctx.parser.mode}.with("body", args[0].clone()))
}

fn vcenter_builder(group: &V, style: &Style) -> R<Tree> {
    let mut mtd = MathNode::new("mtd", vec![build_group(&group.get("body"), style)?]);
    mtd.set_style("padding", "0");
    let mtr = MathNode::new("mtr", vec![Tree::Math(mtd)]);
    Ok(Tree::Math(MathNode::new("mtable", vec![Tree::Math(mtr)])))
}

fn hbox_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    Ok(node! {"type" => "hbox", "mode" => ctx.parser.mode}.with("body", ordargument(&args[0])))
}

fn hbox_builder(group: &V, style: &Style) -> R<Tree> {
    let mrow = build_expression_row(&group.get("body").items(), &style.with_level(1), false)?;
    Ok(consolidate_text(mrow))
}

fn pmb_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    Ok(node! {"type" => "pmb", "mode" => ctx.parser.mode}.with("body", ordargument(&args[0])))
}

fn pmb_builder(group: &V, style: &Style) -> R<Tree> {
    let inner = build_expression(&group.get("body").items(), style, false)?;
    let mut node = wrap_with_mstyle(inner);
    crate::web::extract::elements::math::temml::build::set_attr(
        &mut node,
        "style",
        "font-weight:bold",
    )?;
    Ok(node)
}

fn not_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    let character_box = is_character_box(&args[0]);
    let body;
    if character_box {
        body = ordargument(&args[0]);
        let first = body.items().first().cloned().unwrap_or(V::Undef);
        let Some(mut text) = first.get("text").as_string() else {
            return jserr("Cannot read properties of undefined (reading 'charAt')");
        };
        if text.starts_with('\\') {
            let Some(replace) = symbol("math", &text).and_then(|s| s.replace.clone()) else {
                return jserr("Cannot read properties of undefined (reading 'replace')");
            };
            text = replace;
        }
        // `text.slice(0, 1) + "\u0338" + text.slice(1)` cuts by UTF-16 unit: an astral first
        // character is split, and both halves are lone surrogates (U+FFFD in a Rust string).
        let mut chars = text.chars();
        let head = chars.next().unwrap_or(' ');
        let rest: String = chars.collect();
        let combined = if (head as u32) < 0x10000 {
            format!("{head}\u{0338}{rest}")
        } else {
            format!("\u{FFFD}\u{0338}\u{FFFD}{rest}")
        };
        first.set("text", V::Str(combined));
    } else {
        let not_node = node! {"type" => "textord", "mode" => "math", "text" => "\u{0338}"};
        let dimension = node! {"number" => -0.6, "unit" => "em"};
        let kern_node = node! {"type" => "kern", "mode" => "math"}.with("dimension", dimension);
        body = V::arr(vec![not_node, kern_node, args[0].clone()]);
    }
    Ok(
        node! {"type" => "not", "mode" => ctx.parser.mode, "isCharacterBox" => character_box}
            .with("body", body),
    )
}

fn not_builder(group: &V, style: &Style) -> R<Tree> {
    let items = group.get("body").items();
    if group.get("isCharacterBox").truthy() {
        let mut inner = build_expression(&items, style, true)?;
        if inner.is_empty() {
            return jserr("undefined is not a tree");
        }
        Ok(inner.swap_remove(0))
    } else {
        build_expression_row(&items, style, false)
    }
}

fn reflect_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    Ok(node! {"type" => "reflect", "mode" => ctx.parser.mode}.with("body", args[0].clone()))
}

fn reflect_builder(group: &V, style: &Style) -> R<Tree> {
    let mut node = build_group(&group.get("body"), style)?;
    node.set_style("transform", "scaleX(-1)")?;
    Ok(node)
}

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
    let text_ok = Props {
        num_args: 1,
        allowed_in_text: true,
        ..Props::D
    };
    r.define(
        "kern",
        &["\\kern", "\\mkern", "\\hskip", "\\mskip"],
        Props {
            num_args: 1,
            arg_types: Some(&["size"]),
            primitive: true,
            allowed_in_text: true,
            ..Props::D
        },
        kern_handler,
        Some(kern_builder),
    );
    r.define(
        "rule",
        &["\\rule"],
        Props {
            num_args: 2,
            num_optional_args: 1,
            allowed_in_text: true,
            allowed_in_math: true,
            arg_types: Some(&["size", "size", "size"]),
            ..Props::D
        },
        rule_handler,
        Some(rule_builder),
    );
    r.define(
        "verb",
        &["\\verb"],
        Props {
            allowed_in_text: true,
            ..Props::D
        },
        verb_handler,
        Some(verb_builder),
    );
    r.define(
        "phantom",
        &["\\phantom"],
        text_ok,
        phantom_handler,
        Some(phantom_builder),
    );
    r.define(
        "hphantom",
        &["\\hphantom"],
        text_ok,
        hphantom_handler,
        Some(hphantom_builder),
    );
    r.define(
        "vphantom",
        &["\\vphantom"],
        text_ok,
        vphantom_handler,
        Some(vphantom_builder),
    );
    r.define(
        "lap",
        &[
            "\\mathllap",
            "\\mathrlap",
            "\\mathclap",
            "\\clap",
            "\\llap",
            "\\rlap",
        ],
        text_ok,
        lap_handler,
        Some(lap_builder),
    );
    r.define(
        "raise",
        &["\\raise", "\\lower"],
        Props {
            num_args: 2,
            arg_types: Some(&["size", "primitive"]),
            primitive: true,
            ..Props::D
        },
        raise_handler,
        Some(raise_builder),
    );
    r.define(
        "raise",
        &["\\raisebox"],
        Props {
            num_args: 2,
            arg_types: Some(&["size", "hbox"]),
            allowed_in_text: true,
            ..Props::D
        },
        raisebox_handler,
        Some(raise_builder),
    );
    r.define(
        "smash",
        &["\\smash"],
        Props {
            num_args: 1,
            num_optional_args: 1,
            allowed_in_text: true,
            ..Props::D
        },
        smash_handler,
        Some(smash_builder),
    );
    r.define(
        "vcenter",
        &["\\vcenter"],
        Props {
            num_args: 1,
            arg_types: Some(&["original"]),
            ..Props::D
        },
        vcenter_handler,
        Some(vcenter_builder),
    );
    r.define(
        "hbox",
        &["\\hbox"],
        Props {
            num_args: 1,
            arg_types: Some(&["hbox"]),
            allowed_in_argument: true,
            ..Props::D
        },
        hbox_handler,
        Some(hbox_builder),
    );
    r.define("pmb", &["\\pmb"], text_ok, pmb_handler, Some(pmb_builder));
    r.define(
        "not",
        &["\\not"],
        Props {
            num_args: 1,
            primitive: true,
            ..Props::D
        },
        not_handler,
        Some(not_builder),
    );
    r.define(
        "reflect",
        &["\\reflectbox"],
        Props {
            num_args: 1,
            arg_types: Some(&["hbox"]),
            allowed_in_text: true,
            ..Props::D
        },
        reflect_handler,
        Some(reflect_builder),
    );
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
