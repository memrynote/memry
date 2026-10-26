//! `functions/mclass.js`, `multiscript.js`, `horizBracket.js` and `envTag.js`.

use super::arrow::padding;
use super::{Ctx, Props, Registry, is_character_box, ordargument};
use crate::node;
use crate::web::extract::elements::math::temml::build::{build_expression, build_group};
use crate::web::extract::elements::math::temml::stretchy;
use crate::web::extract::elements::math::temml::style::Style;
use crate::web::extract::elements::math::temml::tables::symbol;
use crate::web::extract::elements::math::temml::tree::{MathNode, Tree};
use crate::web::extract::elements::math::temml::val::{R, V, jserr, num_str, perr};

fn mclass_builder(group: &V, style: &Style) -> R<Tree> {
    let mut inner = build_expression(&group.get("body").items(), style, false)?;
    let mclass = group.text("mclass");
    let mut node: MathNode;
    if mclass == "minner" {
        node = MathNode::new("mpadded", inner);
    } else if mclass == "mord" {
        if group.get("isCharacterBox").truthy() || inner.first().is_some_and(|t| t.is_ty("mathord")) {
            let Some(Tree::Math(mut first)) = inner.drain(..1).next() else {
                return jserr("Cannot set properties of undefined (setting 'type')");
            };
            first.ty = "mi".to_string();
            if first.children.len() == 1 && matches!(&first.children[0], Tree::Text(t) if t == "∇") {
                first.set_attribute("mathvariant", "normal");
            }
            return Ok(Tree::Math(first));
        }
        node = MathNode::new("mi", inner);
    } else {
        if group.get("mustPromote").truthy() {
            let Some(Tree::Math(mut first)) = inner.drain(..1).next() else {
                return jserr("Cannot set properties of undefined (setting 'type')");
            };
            first.ty = "mo".to_string();
            let body0 = group.get("body").items().first().cloned().unwrap_or(V::Undef);
            if group.get("isCharacterBox").truthy()
                && body0.get("text").as_string().is_some_and(|t| t.chars().any(|c| c.is_ascii_alphabetic()))
            {
                first.set_attribute("mathvariant", "italic");
            }
            node = first;
        } else {
            node = MathNode::new("mrow", inner);
        }
        let do_spacing = style.level < 2;
        if node.ty == "mrow" {
            if do_spacing {
                match mclass.as_str() {
                    "mbin" => {
                        node.children.insert(0, padding(&num_str(0.2222)));
                        node.children.push(padding(&num_str(0.2222)));
                    }
                    "mrel" => {
                        node.children.insert(0, padding(&num_str(0.2778)));
                        node.children.push(padding(&num_str(0.2778)));
                    }
                    "mpunct" => node.children.push(padding(&num_str(0.1667))),
                    "minner" => {
                        node.children.insert(0, padding(&num_str(0.0556)));
                        node.children.push(padding(&num_str(0.0556)));
                    }
                    _ => {}
                }
            }
        } else {
            let s = |on: &'static str| if do_spacing { on } else { "0" };
            match mclass.as_str() {
                "mbin" => {
                    node.set_attribute("lspace", s("0.2222em"));
                    node.set_attribute("rspace", s("0.2222em"));
                }
                "mrel" => {
                    node.set_attribute("lspace", s("0.2778em"));
                    node.set_attribute("rspace", s("0.2778em"));
                }
                "mpunct" => {
                    node.set_attribute("lspace", "0em");
                    node.set_attribute("rspace", s("0.1667em"));
                }
                "mopen" | "mclose" => {
                    node.set_attribute("lspace", "0em");
                    node.set_attribute("rspace", "0em");
                }
                "minner" if do_spacing => {
                    node.set_attribute("lspace", "0.0556em");
                    node.set_attribute("width", "+0.1111em");
                }
                _ => {}
            }
        }
        if !(mclass == "mopen" || mclass == "mclose") {
            node.attributes.retain(|(k, _)| k != "stretchy" && k != "form");
        }
    }
    Ok(Tree::Math(node))
}

fn mclass_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    let body = &args[0];
    let char_box = is_character_box(body);
    let mut must_promote = true;
    let mut mord_text = String::new();
    let arr = if body.get("body").truthy() { body.get("body").items() } else { vec![body.clone()] };
    let mode = ctx.parser.mode;
    for arg in &arr {
        if ["text", "textord", "mathord", "atom"].contains(&arg.ty().as_str()) {
            let text = arg.get("text");
            let sym = text.as_string().and_then(|t| symbol(mode, &t));
            if let Some(s) = sym {
                mord_text.push_str(s.replace.as_deref().unwrap_or("undefined"));
            } else if text.truthy() {
                mord_text.push_str(&text.as_string().unwrap_or_default());
            } else if arg.get("body").truthy() {
                for e in arg.get("body").items() {
                    mord_text.push_str(&e.get("text").as_string().unwrap_or_else(|| "undefined".to_string()));
                }
            }
        } else {
            must_promote = false;
            break;
        }
    }
    let mord = node! {"type" => "mathord", "text" => mord_text.clone(), "mode" => mode};
    if must_promote && ctx.func_name == "\\mathord" && crate::web::extract::elements::math::temml::val::ulen(&mord_text) > 1 {
        return Ok(mord);
    }
    let body_arg = ordargument(&if must_promote { mord } else { body.clone() });
    Ok(node! {
        "type" => "mclass",
        "mode" => mode,
        "mclass" => format!("m{}", ctx.func_name.chars().skip(5).collect::<String>()),
        "isCharacterBox" => char_box,
        "mustPromote" => must_promote,
    }
    .with("body", body_arg))
}

fn binrel_class(arg: &V) -> R<&'static str> {
    let atom = if arg.is_type("ordgroup") && arg.get("body").len() == 1 {
        arg.get("body").items()[0].clone()
    } else {
        arg.clone()
    };
    if !atom.is_type("atom") {
        return Ok("mord");
    }
    let body = arg.get("body");
    let first_text = body.items().first().and_then(|f| f.get("text").as_string()).filter(|t| !t.is_empty());
    let family = match first_text.as_deref().and_then(|t| symbol("math", t)) {
        Some(s) if body.len() > 0 => s.group.clone(),
        _ => atom.text("family"),
    };
    if body.len() == 0 && !body.is_arr() {
        return jserr("Cannot read properties of undefined (reading 'length')");
    }
    Ok(match family.as_str() {
        "bin" => "mbin",
        "rel" => "mrel",
        _ => "mord",
    })
}

fn binrel_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    Ok(node! {
        "type" => "mclass",
        "mode" => ctx.parser.mode,
        "mclass" => binrel_class(&args[0])?,
        "isCharacterBox" => is_character_box(&args[1]),
    }
    .with("body", ordargument(&args[1])))
}

fn stackrel_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    let base_arg = &args[1];
    let shifted = &args[0];
    let mclass = if ctx.func_name != "\\stackrel" { binrel_class(base_arg)? } else { "mrel" };
    let base_type = if mclass == "mrel" || mclass == "mbin" { "op" } else { "ordgroup" };
    let base_op = node! {
        "type" => base_type,
        "limits" => true,
        "alwaysHandleSupSub" => true,
        "parentIsSupSub" => false,
        "symbol" => false,
        "suppressBaseShift" => ctx.func_name != "\\stackrel",
    }
    .with("mode", base_arg.get("mode"))
    .with("body", ordargument(base_arg));
    let under = ctx.func_name == "\\underset";
    Ok(node! {"type" => "supsub", "stack" => true}
        .with("mode", shifted.get("mode"))
        .with("base", base_op)
        .with("sup", if under { V::Null } else { shifted.clone() })
        .with("sub", if under { shifted.clone() } else { V::Null }))
}

fn multiscript_node(el: &V, style: &Style, none: &MathNode) -> R<Tree> {
    if !el.truthy() {
        return Ok(Tree::Math(none.clone()));
    }
    let node = build_group(el, style)?;
    if let Tree::Math(m) = &node
        && m.ty == "mrow"
        && m.children.is_empty()
    {
        return Ok(Tree::Math(none.clone()));
    }
    Ok(node)
}

fn multiscript_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    let base_items = args[2].get("body");
    if base_items.len() == 0 {
        return perr(format!("{}cannot parse an empty base.", ctx.func_name));
    }
    let base = base_items.items()[0].clone();
    let pre_items = args[0].get("body");
    let post_items = args[1].get("body");
    let not_supsub = |v: &V| v.len() > 0 && v.items()[0].ty() != "supsub";
    if not_supsub(&pre_items) || not_supsub(&post_items) {
        return perr("\\sideset can parse only subscripts and superscripts in its first two arguments");
    }
    let pre = if pre_items.len() > 0 { pre_items.items()[0].clone() } else { V::Null };
    let post = if post_items.len() > 0 { post_items.items()[0].clone() } else { V::Null };
    let mode = ctx.parser.mode;
    if !pre.truthy() && !post.truthy() {
        return Ok(base);
    }
    if !pre.truthy() {
        let sup = node! {"type" => "supsub", "mode" => mode}
            .with("base", base)
            .with("sup", post.get("sup"))
            .with("sub", post.get("sub"));
        return Ok(node! {"type" => "styling", "mode" => mode, "scriptLevel" => "text"}
            .with("body", V::arr(vec![sup])));
    }
    Ok(node! {
        "type" => "multiscript",
        "mode" => mode,
        "isSideset" => ctx.func_name == "\\sideset",
    }
    .with("prescripts", pre)
    .with("postscripts", post)
    .with("base", base))
}

fn multiscript_builder(group: &V, style: &Style) -> R<Tree> {
    let base = build_group(&group.get("base"), style)?;
    let prescripts_node = Tree::Math(MathNode::new("mprescripts", Vec::new()));
    let none = MathNode::new("none", Vec::new());
    let pre = group.get("prescripts");
    let mut pre_sub = multiscript_node(&pre.get("sub"), style, &none)?;
    let mut pre_sup = multiscript_node(&pre.get("sup"), style, &none)?;
    if group.get("isSideset").truthy() {
        crate::web::extract::elements::math::temml::build::set_attr(&mut pre_sub, "style", "text-align: left;")?;
        crate::web::extract::elements::math::temml::build::set_attr(&mut pre_sup, "style", "text-align: left;")?;
    }
    let post = group.get("postscripts");
    let children = if post.truthy() {
        let post_sub = multiscript_node(&post.get("sub"), style, &none)?;
        let post_sup = multiscript_node(&post.get("sup"), style, &none)?;
        vec![base, post_sub, post_sup, prescripts_node, pre_sub, pre_sup]
    } else {
        vec![base, prescripts_node, pre_sub, pre_sup]
    };
    Ok(Tree::Math(MathNode::new("mmultiscripts", children)))
}

fn horiz_bracket_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    Ok(node! {
        "type" => "horizBracket",
        "mode" => ctx.parser.mode,
        "label" => ctx.func_name.clone(),
        "isOver" => ctx.func_name.starts_with("\\over"),
    }
    .with("base", args[0].clone()))
}

fn horiz_bracket_builder(group: &V, style: &Style) -> R<Tree> {
    let mut accent = stretchy::math_ml_node(&group.text("label"));
    accent.set_style("math-depth", "0");
    let base = build_group(&group.get("base"), style)?;
    let ty = if group.get("isOver").truthy() { "mover" } else { "munder" };
    Ok(Tree::Math(MathNode::new(ty, vec![base, Tree::Math(accent)])))
}

fn env_tag_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    Ok(node! {"type" => "envTag", "mode" => ctx.parser.mode}.with("body", args[0].clone()))
}

fn no_tag_handler(ctx: &mut Ctx, _args: &[V], _opt: &[V]) -> R<V> {
    Ok(node! {"type" => "noTag", "mode" => ctx.parser.mode})
}

fn empty_row(_group: &V, _style: &Style) -> R<Tree> {
    Ok(Tree::Math(MathNode::new("mrow", Vec::new())))
}

pub fn register(r: &mut Registry) {
    r.define(
        "mclass",
        &["\\mathord", "\\mathbin", "\\mathrel", "\\mathopen", "\\mathclose", "\\mathpunct", "\\mathinner"],
        Props { num_args: 1, primitive: true, ..Props::D },
        mclass_handler,
        Some(mclass_builder),
    );
    r.define(
        "mclass",
        &["\\@binrel"],
        Props { num_args: 2, ..Props::D },
        binrel_handler,
        None,
    );
    r.define(
        "mclass",
        &["\\stackrel", "\\overset", "\\underset"],
        Props { num_args: 2, ..Props::D },
        stackrel_handler,
        None,
    );
    r.define(
        "multiscript",
        &["\\sideset", "\\pres@cript"],
        Props { num_args: 3, ..Props::D },
        multiscript_handler,
        Some(multiscript_builder),
    );
    r.define(
        "horizBracket",
        &["\\overbrace", "\\underbrace", "\\overbracket", "\\underbracket"],
        Props { num_args: 1, ..Props::D },
        horiz_bracket_handler,
        Some(horiz_bracket_builder),
    );
    r.define(
        "envTag",
        &["\\env@tag"],
        Props { num_args: 1, arg_types: Some(&["math"]), ..Props::D },
        env_tag_handler,
        Some(empty_row),
    );
    r.define("noTag", &["\\env@notag"], Props::D, no_tag_handler, Some(empty_row));
}
