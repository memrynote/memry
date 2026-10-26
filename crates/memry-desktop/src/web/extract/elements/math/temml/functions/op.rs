//! `functions/op.js` and `functions/operatorname.js`.

use super::{Ctx, Props, Registry, is_delimiter, ordargument};
use crate::node;
use crate::web::extract::elements::math::temml::build::{build_expression, make_text};
use crate::web::extract::elements::math::temml::style::Style;
use crate::web::extract::elements::math::temml::tree::{MathNode, Tree};
use crate::web::extract::elements::math::temml::val::{R, V};
use crate::web::extract::utils::js::to_number;

const ORD_TYPES: [&str; 6] = ["textord", "mathord", "ordgroup", "close", "leftright", "font"];

fn thin_space() -> Tree {
    let mut s = MathNode::new("mspace", Vec::new());
    s.set_attribute("width", "0.1667em");
    Tree::Math(s)
}

fn set_spacing(node: &mut MathNode) {
    node.set_attribute("lspace", "0.1667em");
    node.set_attribute("rspace", "0.1667em");
}

fn op_builder(group: &V, style: &Style) -> R<Tree> {
    let name = group.text("name");
    let mut node;
    if group.get("symbol").truthy() {
        let mut n = MathNode::new("mo", vec![make_text(&name, &group.text("mode"), None)]);
        if name == "\\smallint" {
            n.set_attribute("largeop", "false");
        } else {
            n.set_attribute("movablelimits", "false");
        }
        if group.get("fromMathOp").truthy() {
            set_spacing(&mut n);
        }
        node = Tree::Math(n);
    } else if group.get("body").truthy() {
        let mut n = MathNode::new("mo", build_expression(&group.get("body").items(), style, false)?);
        if group.get("fromMathOp").truthy() {
            set_spacing(&mut n);
        }
        node = Tree::Math(n);
    } else {
        let mi = MathNode::new("mi", vec![Tree::Text(name.chars().skip(1).collect())]);
        node = Tree::Math(mi);
        if !group.get("parentIsSupSub").truthy() {
            let operator = Tree::Math(MathNode::new("mo", vec![make_text("\u{2061}", "text", None)]));
            let mut row = vec![node, operator];
            if group.get("needsLeadingSpace").truthy() {
                row.insert(0, thin_space());
            }
            if !group.get("isFollowedByDelimiter").truthy() {
                row.push(thin_space());
            }
            node = Tree::Math(MathNode::new("mrow", row));
        }
    }
    Ok(node)
}

fn single_char_big_op(c: &str) -> &'static str {
    match c {
        "\u{220F}" => "\\prod",
        "\u{2210}" => "\\coprod",
        "\u{2211}" => "\\sum",
        "\u{22c0}" => "\\bigwedge",
        "\u{22c1}" => "\\bigvee",
        "\u{22c2}" => "\\bigcap",
        "\u{22c3}" => "\\bigcup",
        "\u{2a00}" => "\\bigodot",
        "\u{2a01}" => "\\bigoplus",
        "\u{2a02}" => "\\bigotimes",
        "\u{2a04}" => "\\biguplus",
        "\u{2a05}" => "\\bigsqcap",
        "\u{2a06}" => "\\bigsqcup",
        "\u{2a03}" => "\\bigcupdot",
        "\u{2a07}" => "\\bigdoublevee",
        "\u{2a08}" => "\\bigdoublewedge",
        _ => "\\bigtimes",
    }
}

fn single_char_integral(c: &str) -> &'static str {
    match c {
        "\u{222b}" => "\\int",
        "\u{222c}" => "\\iint",
        "\u{222d}" => "\\iiint",
        "\u{222e}" => "\\oint",
        "\u{222f}" => "\\oiint",
        "\u{2230}" => "\\oiiint",
        "\u{2231}" => "\\intclockwise",
        "\u{2232}" => "\\varointclockwise",
        "\u{2a0c}" => "\\iiiint",
        "\u{2a0d}" => "\\intbar",
        "\u{2a0e}" => "\\intBar",
        "\u{2a0f}" => "\\fint",
        "\u{2a12}" => "\\rppolint",
        "\u{2a13}" => "\\scpolint",
        "\u{2a15}" => "\\pointint",
        "\u{2a16}" => "\\sqint",
        "\u{2a17}" => "\\intlarhk",
        "\u{2a18}" => "\\intx",
        "\u{2a19}" => "\\intcap",
        _ => "\\intcup",
    }
}

fn big_op_handler(ctx: &mut Ctx, _args: &[V], _opt: &[V]) -> R<V> {
    let name = if ctx.func_name.chars().count() == 1 {
        single_char_big_op(&ctx.func_name).to_string()
    } else {
        ctx.func_name.clone()
    };
    Ok(node! {
        "type" => "op",
        "mode" => ctx.parser.mode,
        "limits" => true,
        "parentIsSupSub" => false,
        "symbol" => true,
        "stack" => false,
        "name" => name,
    })
}

fn mathop_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    let body = &args[0];
    let arr = if body.get("body").truthy() { body.get("body").items() } else { vec![body.clone()] };
    let is_symbol = arr.len() == 1 && ["textord", "mathord", "atom"].contains(&arr[0].ty().as_str());
    let n = node! {
        "type" => "op",
        "mode" => ctx.parser.mode,
        "limits" => true,
        "parentIsSupSub" => false,
        "symbol" => is_symbol,
        "fromMathOp" => true,
        "stack" => false,
    };
    n.set("name", if is_symbol { arr[0].get("text") } else { V::Null });
    n.set("body", if is_symbol { V::Null } else { ordargument(body) });
    Ok(n)
}

fn named_op(ctx: &mut Ctx, limits: bool) -> R<V> {
    let prev = ctx.parser.prev_atom_type.clone();
    let next = ctx.parser.gullet.future()?.borrow().text.clone();
    Ok(node! {
        "type" => "op",
        "mode" => ctx.parser.mode,
        "limits" => limits,
        "parentIsSupSub" => false,
        "symbol" => false,
        "stack" => false,
        "isFollowedByDelimiter" => is_delimiter(&next),
        "needsLeadingSpace" => !prev.is_empty() && ORD_TYPES.contains(&prev.as_str()),
        "name" => ctx.func_name.clone(),
    })
}

fn nolimits_handler(ctx: &mut Ctx, _args: &[V], _opt: &[V]) -> R<V> {
    named_op(ctx, false)
}

fn limits_handler(ctx: &mut Ctx, _args: &[V], _opt: &[V]) -> R<V> {
    named_op(ctx, true)
}

fn integral_handler(ctx: &mut Ctx, _args: &[V], _opt: &[V]) -> R<V> {
    let name = if ctx.func_name.chars().count() == 1 {
        single_char_integral(&ctx.func_name).to_string()
    } else {
        ctx.func_name.clone()
    };
    Ok(node! {
        "type" => "op",
        "mode" => ctx.parser.mode,
        "limits" => false,
        "parentIsSupSub" => false,
        "symbol" => true,
        "stack" => false,
        "name" => name,
    })
}

fn operatorname_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    let prev = ctx.parser.prev_atom_type.clone();
    let next = ctx.parser.gullet.future()?.borrow().text.clone();
    Ok(node! {
        "type" => "operatorname",
        "mode" => ctx.parser.mode,
        "alwaysHandleSupSub" => ctx.func_name == "\\operatornamewithlimits",
        "limits" => false,
        "parentIsSupSub" => false,
        "isFollowedByDelimiter" => is_delimiter(&next),
        "needsLeadingSpace" => !prev.is_empty() && ORD_TYPES.contains(&prev.as_str()),
    }
    .with("body", ordargument(&args[0])))
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

/// Does `node` stand for its first child (`mrow`/`mpadded` of one element, or an `mrow` of an
/// element and an empty width-less `mspace`)?
fn descends(node: &MathNode) -> bool {
    let is_math = |t: &Tree| matches!(t, Tree::Math(_));
    if (node.ty == "mrow" || node.ty == "mpadded")
        && node.children.len() == 1
        && is_math(&node.children[0])
    {
        return true;
    }
    node.ty == "mrow"
        && node.children.len() == 2
        && is_math(&node.children[0])
        && matches!(&node.children[1], Tree::Math(m)
            if m.ty == "mspace" && m.get_attribute("width").is_none_or(str::is_empty) && m.children.is_empty())
}

fn operatorname_builder(group: &V, style: &Style) -> R<Tree> {
    let mut expression =
        build_expression(&group.get("body").items(), &style.with_font("mathrm"), false)?;
    let mut is_all_string = true;
    for i in 0..expression.len() {
        let Tree::Math(top) = &mut expression[i] else {
            is_all_string = false;
            continue;
        };
        let node: &mut MathNode = if descends(top) {
            match &mut top.children[0] {
                Tree::Math(m) => m,
                _ => unreachable!("checked by descends"),
            }
        } else {
            top
        };
        match node.ty.as_str() {
            "mi" | "mn" | "ms" | "mtext" => {}
            "mspace" => {
                if let Some(width) = node.get_attribute("width").filter(|w| !w.is_empty()) {
                    let ch = space_character(to_number(&width.replacen("em", "", 1)));
                    if ch.is_empty() {
                        is_all_string = false;
                    } else {
                        expression[i] =
                            Tree::Math(MathNode::new("mtext", vec![Tree::Text(ch.to_string())]));
                    }
                }
            }
            "mo" => {
                if node.children.len() == 1
                    && let Tree::Text(t) = &mut node.children[0]
                {
                    *t = t.replacen('\u{2212}', "-", 1).replacen('\u{2217}', "*", 1);
                } else {
                    is_all_string = false;
                }
            }
            _ => is_all_string = false,
        }
    }
    let operator = || Tree::Math(MathNode::new("mo", vec![make_text("\u{2061}", "text", None)]));
    if is_all_string {
        let word: String = expression.iter().map(Tree::to_text).collect();
        expression = vec![Tree::Text(word)];
    } else if expression.len() == 1
        && (expression[0].is_ty("mover") || expression[0].is_ty("munder"))
        && let Tree::Math(m) = &mut expression[0]
        && matches!(m.children.first(), Some(Tree::Math(c)) if c.ty == "mi" || c.ty == "mtext")
    {
        if let Some(Tree::Math(c)) = m.children.first_mut() {
            c.ty = "mi".to_string();
        }
        let first = expression.remove(0);
        if group.get("parentIsSupSub").truthy() {
            return Ok(Tree::Math(MathNode::new("mrow", vec![first])));
        }
        return Ok(Tree::frag(vec![first, operator()]));
    }
    let wrapper = if is_all_string {
        let one_unit = matches!(&expression[0], Tree::Text(t) if crate::web::extract::elements::math::temml::val::ulen(t) == 1);
        let mut w = MathNode::new("mi", expression);
        if one_unit {
            w.set_attribute("mathvariant", "normal");
        }
        Tree::Math(w)
    } else {
        Tree::Math(MathNode::new("mrow", expression))
    };
    if !group.get("parentIsSupSub").truthy() {
        let mut fragment = vec![wrapper, operator()];
        if group.get("needsLeadingSpace").truthy() {
            fragment.insert(0, thin_space());
        }
        if !group.get("isFollowedByDelimiter").truthy() {
            fragment.push(thin_space());
        }
        return Ok(Tree::frag(fragment));
    }
    Ok(wrapper)
}

pub fn register(r: &mut Registry) {
    r.define(
        "op",
        &[
            "\\coprod", "\\bigvee", "\\bigwedge", "\\biguplus", "\\bigcupplus", "\\bigcupdot",
            "\\bigcap", "\\bigcup", "\\bigdoublevee", "\\bigdoublewedge", "\\intop", "\\prod",
            "\\sum", "\\bigotimes", "\\bigoplus", "\\bigodot", "\\bigsqcap", "\\bigsqcup",
            "\\bigtimes", "\\smallint", "\u{220F}", "\u{2210}", "\u{2211}", "\u{22c0}",
            "\u{22c1}", "\u{22c2}", "\u{22c3}", "\u{2a00}", "\u{2a01}", "\u{2a02}", "\u{2a03}",
            "\u{2a04}", "\u{2a05}", "\u{2a06}", "\u{2a07}", "\u{2a08}", "\u{2a09}",
        ],
        Props::D,
        big_op_handler,
        Some(op_builder),
    );
    r.define(
        "op",
        &["\\mathop"],
        Props { num_args: 1, primitive: true, ..Props::D },
        mathop_handler,
        Some(op_builder),
    );
    r.define(
        "op",
        &[
            "\\arcsin", "\\arccos", "\\arctan", "\\arctg", "\\arcctg", "\\arg", "\\ch", "\\cos",
            "\\cosec", "\\cosh", "\\cot", "\\cotg", "\\coth", "\\csc", "\\ctg", "\\cth", "\\deg",
            "\\dim", "\\exp", "\\hom", "\\ker", "\\lg", "\\ln", "\\log", "\\sec", "\\sin",
            "\\sinh", "\\sh", "\\sgn", "\\tan", "\\tanh", "\\tg", "\\th",
        ],
        Props::D,
        nolimits_handler,
        Some(op_builder),
    );
    r.define(
        "op",
        &["\\det", "\\gcd", "\\inf", "\\lim", "\\max", "\\min", "\\Pr", "\\sup"],
        Props::D,
        limits_handler,
        Some(op_builder),
    );
    r.define(
        "op",
        &[
            "\\int", "\\iint", "\\iiint", "\\iiiint", "\\oint", "\\oiint", "\\oiiint",
            "\\intclockwise", "\\varointclockwise", "\\intbar", "\\intBar", "\\fint", "\\rppolint",
            "\\scpolint", "\\pointint", "\\sqint", "\\intlarhk", "\\intx", "\\intcap", "\\intcup",
            "\u{222b}", "\u{222c}", "\u{222d}", "\u{222e}", "\u{222f}", "\u{2230}", "\u{2231}",
            "\u{2232}", "\u{2a0c}", "\u{2a0d}", "\u{2a0e}", "\u{2a0f}", "\u{2a12}", "\u{2a13}",
            "\u{2a15}", "\u{2a16}", "\u{2a17}", "\u{2a18}", "\u{2a19}", "\u{2a1a}",
        ],
        Props { allowed_in_argument: true, ..Props::D },
        integral_handler,
        Some(op_builder),
    );
    r.define(
        "operatorname",
        &["\\operatorname@", "\\operatornamewithlimits"],
        Props { num_args: 1, allowed_in_argument: true, ..Props::D },
        operatorname_handler,
        Some(operatorname_builder),
    );
}
