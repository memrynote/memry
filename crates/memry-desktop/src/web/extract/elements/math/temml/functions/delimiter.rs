//! `functions/delimiter.js`: `\big`, `\left`/`\right`/`\middle` and the self-closing delimiters.

use super::{Ctx, Props, Registry, assert_node_type};
use crate::node;
use crate::web::extract::elements::math::temml::build::{build_expression, make_row, make_text};
use crate::web::extract::elements::math::temml::style::Style;
use crate::web::extract::elements::math::temml::tables::tables;
use crate::web::extract::elements::math::temml::tree::{MathNode, Tree};
use crate::web::extract::elements::math::temml::val::{R, V, jserr, perr};

const LEFT_TO_RIGHT: [(&str, &str); 28] = [
    ("(", ")"),
    ("\\lparen", "\\rparen"),
    ("[", "]"),
    ("\\lbrack", "\\rbrack"),
    ("\\{", "\\}"),
    ("\\lbrace", "\\rbrace"),
    ("⦇", "⦈"),
    ("\\llparenthesis", "\\rrparenthesis"),
    ("\\lfloor", "\\rfloor"),
    ("\u{230a}", "\u{230b}"),
    ("\\lceil", "\\rceil"),
    ("\u{2308}", "\u{2309}"),
    ("\\langle", "\\rangle"),
    ("\u{27e8}", "\u{27e9}"),
    ("\\lAngle", "\\rAngle"),
    ("\u{27ea}", "\u{27eb}"),
    ("\\llangle", "\\rrangle"),
    ("⦉", "⦊"),
    ("\\lvert", "\\rvert"),
    ("\\lVert", "\\rVert"),
    ("\\lgroup", "\\rgroup"),
    ("\u{27ee}", "\u{27ef}"),
    ("\\lmoustache", "\\rmoustache"),
    ("\u{23b0}", "\u{23b1}"),
    ("\\llbracket", "\\rrbracket"),
    ("\u{27e6}", "\u{27e7}"),
    ("\\lBrace", "\\rBrace"),
    ("\u{2983}", "\u{2984}"),
];

const DELIMITERS: &[&str] = &[
    "(",
    "\\lparen",
    ")",
    "\\rparen",
    "[",
    "\\lbrack",
    "]",
    "\\rbrack",
    "\\{",
    "\\lbrace",
    "\\}",
    "\\rbrace",
    "⦇",
    "\\llparenthesis",
    "⦈",
    "\\rrparenthesis",
    "\\lfloor",
    "\\rfloor",
    "\u{230a}",
    "\u{230b}",
    "\\lceil",
    "\\rceil",
    "\u{2308}",
    "\u{2309}",
    "<",
    ">",
    "\\langle",
    "\u{27e8}",
    "\\rangle",
    "\u{27e9}",
    "\\lAngle",
    "\u{27ea}",
    "\\rAngle",
    "\u{27eb}",
    "\\llangle",
    "⦉",
    "\\rrangle",
    "⦊",
    "\\lt",
    "\\gt",
    "\\lvert",
    "\\rvert",
    "\\lVert",
    "\\rVert",
    "\\lgroup",
    "\\rgroup",
    "\u{27ee}",
    "\u{27ef}",
    "\\lmoustache",
    "\\rmoustache",
    "\u{23b0}",
    "\u{23b1}",
    "\\llbracket",
    "\\rrbracket",
    "\u{27e6}",
    "\u{27e7}",
    "\\lBrace",
    "\\rBrace",
    "\u{2983}",
    "\u{2984}",
    "/",
    "\\backslash",
    "|",
    "\\vert",
    "\\|",
    "\\Vert",
    "\u{2016}",
    "\\uparrow",
    "\\Uparrow",
    "\\downarrow",
    "\\Downarrow",
    "\\updownarrow",
    "\\Updownarrow",
    ".",
];

const DELIMITER_SIZE_NAMES: [(&str, &str, usize); 16] = [
    ("\\bigl", "mopen", 1),
    ("\\Bigl", "mopen", 2),
    ("\\biggl", "mopen", 3),
    ("\\Biggl", "mopen", 4),
    ("\\bigr", "mclose", 1),
    ("\\Bigr", "mclose", 2),
    ("\\biggr", "mclose", 3),
    ("\\Biggr", "mclose", 4),
    ("\\bigm", "mrel", 1),
    ("\\Bigm", "mrel", 2),
    ("\\biggm", "mrel", 3),
    ("\\Biggm", "mrel", 4),
    ("\\big", "mord", 1),
    ("\\Big", "mord", 2),
    ("\\bigg", "mord", 3),
    ("\\Bigg", "mord", 4),
];

fn delimiter_size(name: &str) -> Option<(&'static str, usize)> {
    DELIMITER_SIZE_NAMES
        .iter()
        .find(|(n, _, _)| *n == name)
        .map(|(_, m, s)| (*m, *s))
}

/// `isDelimiter(str)`.
pub fn is_delimiter(text: &str) -> bool {
    !text.is_empty()
        && (DELIMITERS.contains(&text)
            || delimiter_size(text).is_some()
            || ["}", "\\left", "\\middle", "\\right"].contains(&text))
}

/// `leftToRight[name]`.
pub fn right_of(left: &str) -> Option<&'static str> {
    LEFT_TO_RIGHT
        .iter()
        .find(|(l, _)| *l == left)
        .map(|(_, r)| *r)
}

/// The names of the left delimiters (`leftDelimiterNames`).
pub fn left_delimiter_names() -> Vec<&'static str> {
    let mut seen: Vec<&'static str> = Vec::new();
    for (l, _) in LEFT_TO_RIGHT {
        if !seen.contains(&l) {
            seen.push(l);
        }
    }
    seen
}

pub fn check_symbol_node(node: &V) -> bool {
    let t = node.ty();
    t == "atom" || t == "delimiter" || (!t.is_empty() && tables().non_atoms.contains(&t))
}

/// `checkDelimiter(delim, context)`: the symbol node (its `<`/`>` rewritten to angle brackets).
pub fn check_delimiter(delim: &V, func_name: &str) -> R<V> {
    let mut delim = delim.clone();
    if delim.is_type("ordgroup") && delim.get("body").len() == 1 {
        delim = delim.get("body").items()[0].clone();
    }
    if check_symbol_node(&delim) {
        let text = delim.text("text");
        if DELIMITERS.contains(&text.as_str()) {
            if text == "<" || text == "\\lt" {
                delim.set("text", V::str("⟨"));
            }
            if text == ">" || text == "\\gt" {
                delim.set("text", V::str("⟩"));
            }
            return Ok(delim);
        }
        return perr(format!("Invalid delimiter '{text}' after '{func_name}'"));
    }
    perr(format!("Invalid delimiter type '{}'", delim.ty()))
}

const NEED_EXPLICIT_STRETCH: [&str; 6] = ["/", "\\", "\\backslash", "\u{2216}", "\\vert", "|"];

fn make_fence_mo(delim: &str, mode: &str, form: &str, is_stretchy: bool) -> MathNode {
    let text = if delim == "." { "" } else { delim };
    let mut node = MathNode::new("mo", vec![make_text(text, mode, None)]);
    node.set_attribute("fence", "true");
    node.set_attribute("form", form);
    node.set_attribute("stretchy", if is_stretchy { "true" } else { "false" });
    node
}

fn delimsizing_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    let delim = check_delimiter(&args[0], &ctx.func_name)?;
    let (mclass, size) = delimiter_size(&ctx.func_name).expect("registered name");
    let delim_node = node! {
        "type" => "delimsizing",
        "mode" => ctx.parser.mode,
        "size" => size as f64,
        "mclass" => mclass,
        "delim" => delim.text("text"),
    };
    let next = ctx.parser.fetch_text()?;
    if next != "^" && next != "_" {
        return Ok(delim_node);
    }
    let empty = node! {"type" => "ordgroup", "mode" => "math"}.with("body", V::arr(vec![]));
    Ok(
        node! {"type" => "ordgroup", "mode" => "math"}
            .with("body", V::arr(vec![delim_node, empty])),
    )
}

fn delimsizing_builder(group: &V, _style: &Style) -> R<Tree> {
    let raw = group.text("delim");
    let delim = if raw == "." { "" } else { raw.as_str() };
    let mut node = MathNode::new("mo", vec![make_text(delim, &group.text("mode"), None)]);
    let mclass = group.text("mclass");
    node.set_attribute(
        "fence",
        if mclass == "mopen" || mclass == "mclose" {
            "true"
        } else {
            "false"
        },
    );
    if NEED_EXPLICIT_STRETCH.contains(&delim) || delim.contains("arrow") {
        node.set_attribute("stretchy", "true");
    }
    node.set_attribute("symmetric", "true");
    let size = group.get("size").as_num().unwrap_or(0.0) as usize;
    let max_height = ["0", "1.2", "1.8", "2.4", "3"][size];
    node.set_attribute("minsize", format!("{max_height}em"));
    node.set_attribute("maxsize", format!("{max_height}em"));
    Ok(Tree::Math(node))
}

fn right_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    Ok(node! {
        "type" => "leftright-right",
        "mode" => ctx.parser.mode,
        "delim" => check_delimiter(&args[0], &ctx.func_name)?.text("text"),
    })
}

fn left_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    let delim = check_delimiter(&args[0], &ctx.func_name)?;
    let parser = &mut *ctx.parser;
    parser.left_right_depth += 1;
    let mut body = parser.parse_expression(false, Some("\\right"), true)?;
    let mut next = parser.fetch_text()?;
    while next == "\\middle" {
        parser.consume();
        let middle = parser.fetch_text()?;
        if !tables().symbols_math.contains_key(&middle) {
            return perr(format!("Invalid delimiter '{middle}' after '\\middle'"));
        }
        check_delimiter(
            &node! {"type" => "atom", "mode" => "math", "text" => middle.clone()},
            "\\middle",
        )?;
        body.push(node! {"type" => "middle", "mode" => "math", "delim" => middle});
        parser.consume();
        body.extend(parser.parse_expression(false, Some("\\right"), true)?);
        next = parser.fetch_text()?;
    }
    parser.left_right_depth -= 1;
    parser.expect("\\right", false)?;
    let Some(right) = parser.parse_function(None, None)? else {
        return jserr("Expected node of type leftright-right, but got null");
    };
    let right = assert_node_type(&right, "leftright-right")?;
    Ok(node! {
        "type" => "leftright",
        "mode" => parser.mode,
        "left" => delim.text("text"),
        "right" => right.text("delim"),
        "isStretchy" => true,
    }
    .with("body", V::arr(body)))
}

fn fenced_builder(group: &V, style: &Style, stretchy: bool) -> R<Tree> {
    let body = group.get("body");
    if !body.truthy() {
        return jserr("Bug: The delim ParseNode wasn't fully parsed.");
    }
    let items = body.items();
    let mut inner = build_expression(&items, style, false)?;
    let mode = group.text("mode");
    inner.insert(
        0,
        Tree::Math(make_fence_mo(
            &group.text("left"),
            &mode,
            "prefix",
            stretchy,
        )),
    );
    let mut right_node = make_fence_mo(&group.text("right"), &mode, "postfix", stretchy);
    if let Some(last) = items.last()
        && last.is_type("color")
        && !last.get("isTextColor").truthy()
    {
        right_node.set_attribute("mathcolor", last.text("color"));
    }
    inner.push(Tree::Math(right_node));
    Ok(make_row(inner, false))
}

fn leftright_builder(group: &V, style: &Style) -> R<Tree> {
    fenced_builder(group, style, true)
}

fn delimiter_builder(group: &V, style: &Style) -> R<Tree> {
    fenced_builder(group, style, false)
}

fn delimiter_handler(ctx: &mut Ctx, _args: &[V], _opt: &[V]) -> R<V> {
    let func_name = ctx.func_name.clone();
    let parser = &mut *ctx.parser;
    let loc: V = ctx
        .token
        .as_ref()
        .and_then(|t| t.borrow().loc.clone())
        .into();
    if parser.mode == "text" {
        return Ok(
            node! {"type" => "textord", "mode" => "text", "text" => func_name}.with("loc", loc),
        );
    } else if !parser.settings.wrap_delimiter_pairs.get() {
        return Ok(node! {
            "type" => "atom",
            "mode" => "math",
            "family" => "open",
            "text" => func_name,
        }
        .with("loc", loc));
    }
    let right = right_of(&func_name).expect("left delimiter");
    let body = parser.parse_expression(false, Some(right), false)?;
    let next = parser.fetch_text()?;
    if next != right {
        return perr("Unmatched delimiter");
    }
    parser.consume();
    Ok(node! {
        "type" => "delimiter",
        "mode" => parser.mode,
        "left" => func_name,
        "right" => right,
    }
    .with("body", V::arr(body)))
}

fn middle_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    let delim = check_delimiter(&args[0], &ctx.func_name)?;
    if ctx.parser.left_right_depth == 0 {
        return perr("\\middle without preceding \\left");
    }
    Ok(node! {"type" => "middle", "mode" => ctx.parser.mode, "delim" => delim.text("text")})
}

fn middle_builder(group: &V, _style: &Style) -> R<Tree> {
    let text = make_text(&group.text("delim"), &group.text("mode"), None);
    let is_slash = matches!(&text, Tree::Text(t) if t == "/");
    let mut node = MathNode::new("mo", vec![text]);
    node.set_attribute("stretchy", "true");
    node.set_attribute("form", "infix");
    if !is_slash {
        node.set_attribute("lspace", "0.05em");
        node.set_attribute("rspace", "0.05em");
    }
    Ok(Tree::Math(node))
}

pub fn register(r: &mut Registry) {
    let sizing: Vec<&'static str> = DELIMITER_SIZE_NAMES.iter().map(|(n, _, _)| *n).collect();
    let primitive = Props {
        num_args: 1,
        arg_types: Some(&["primitive"]),
        ..Props::D
    };
    r.define(
        "delimsizing",
        &sizing,
        primitive,
        delimsizing_handler,
        Some(delimsizing_builder),
    );
    r.define(
        "leftright-right",
        &["\\right"],
        primitive,
        right_handler,
        None,
    );
    r.define(
        "leftright",
        &["\\left"],
        primitive,
        left_handler,
        Some(leftright_builder),
    );
    r.define(
        "delimiter",
        &left_delimiter_names(),
        Props {
            allowed_in_text: true,
            allowed_in_math: true,
            allowed_in_argument: true,
            ..Props::D
        },
        delimiter_handler,
        Some(delimiter_builder),
    );
    r.define(
        "middle",
        &["\\middle"],
        primitive,
        middle_handler,
        Some(middle_builder),
    );
}
