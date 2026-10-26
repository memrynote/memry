//! `environments/cd.js`: the `{CD}` environment and its internal label functions.

use super::array::assert_symbol;
use super::{Ctx, Props, Registry};
use crate::node;
use crate::web::extract::elements::math::temml::build::build_group;
use crate::web::extract::elements::math::temml::macro_expander::MacroDef;
use crate::web::extract::elements::math::temml::parser::Parser;
use crate::web::extract::elements::math::temml::style::Style;
use crate::web::extract::elements::math::temml::tree::{MathNode, Tree};
use crate::web::extract::elements::math::temml::val::{R, V, perr};

fn new_cell() -> V {
    node! {"type" => "styling", "mode" => "math", "scriptLevel" => "display"}
        .with("body", V::arr(Vec::new()))
}

fn is_start_of_arrow(n: &V) -> bool {
    n.is_type("textord") && n.text("text") == "@"
}

fn is_label_end(n: &V, end_char: &str) -> bool {
    (n.is_type("mathord") || n.is_type("atom")) && n.text("text") == end_char
}

fn cd_arrow(arrow_char: &str, labels: &[V], parser: &mut Parser) -> R<V> {
    let call = |parser: &mut Parser, name: &str, args: &[V], opt: &[V]| {
        parser.call_function(name, args, opt, None, None)
    };
    match arrow_char {
        ">" => call(
            parser,
            "\\\\cdrightarrow",
            &[labels[0].clone()],
            &[labels[1].clone()],
        ),
        "<" => call(
            parser,
            "\\\\cdleftarrow",
            &[labels[0].clone()],
            &[labels[1].clone()],
        ),
        "A" | "V" => {
            let func = if arrow_char == "A" {
                "\\uparrow"
            } else {
                "\\downarrow"
            };
            let left_label = call(parser, "\\\\cdleft", &[labels[0].clone()], &[])?;
            let bare_arrow =
                node! {"type" => "atom", "text" => func, "mode" => "math", "family" => "rel"};
            let sized_arrow = call(parser, "\\Big", &[bare_arrow], &[])?;
            let right_label = call(parser, "\\\\cdright", &[labels[1].clone()], &[])?;
            let arrow_group = node! {"type" => "ordgroup", "mode" => "math", "semisimple" => true}
                .with("body", V::arr(vec![left_label, sized_arrow, right_label]));
            call(parser, "\\\\cdparent", &[arrow_group], &[])
        }
        "=" => call(parser, "\\\\cdlongequal", &[], &[]),
        "|" => {
            let arrow = node! {"type" => "textord", "text" => "\\Vert", "mode" => "math"};
            call(parser, "\\Big", &[arrow], &[])
        }
        _ => Ok(node! {"type" => "textord", "text" => " ", "mode" => "math"}),
    }
}

pub fn parse_cd(parser: &mut Parser) -> R<V> {
    let mut parsed_rows: Vec<Vec<V>> = Vec::new();
    parser.gullet.begin_group();
    parser
        .gullet
        .macros
        .set("\\cr", MacroDef::Text("\\\\\\relax".to_string()), false);
    parser.gullet.begin_group();
    loop {
        parsed_rows.push(parser.parse_expression(false, Some("\\\\"), false)?);
        parser.gullet.end_group()?;
        parser.gullet.begin_group();
        let next_tok = parser.fetch()?;
        let next = next_tok.borrow().text.clone();
        if next == "&" || next == "\\\\" {
            parser.consume();
        } else if next == "\\end" {
            if parsed_rows.last().is_some_and(Vec::is_empty) {
                parsed_rows.pop();
            }
            break;
        } else {
            return crate::web::extract::elements::math::temml::val::perr_at(
                "Expected \\\\ or \\cr or \\end",
                &next_tok,
            );
        }
    }

    let mut row: Vec<V> = Vec::new();
    let mut body: Vec<Vec<V>> = Vec::new();
    for (i, row_nodes) in parsed_rows.iter().enumerate() {
        let mut cell = new_cell();
        let mut j = 0;
        while j < row_nodes.len() {
            if !is_start_of_arrow(&row_nodes[j]) {
                cell.get("body").push(row_nodes[j].clone());
            } else {
                row.push(cell);
                j += 1;
                let arrow_char =
                    assert_symbol(&row_nodes.get(j).cloned().unwrap_or(V::Undef))?.text("text");
                let labels = [
                    node! {"type" => "ordgroup", "mode" => "math"}.with("body", V::arr(Vec::new())),
                    node! {"type" => "ordgroup", "mode" => "math"}.with("body", V::arr(Vec::new())),
                ];
                if "=|.".contains(arrow_char.as_str()) {
                } else if "<>AV".contains(arrow_char.as_str()) {
                    for label in &labels {
                        let mut in_label = true;
                        for k in j + 1..row_nodes.len() {
                            if is_label_end(&row_nodes[k], &arrow_char) {
                                in_label = false;
                                j = k;
                                break;
                            }
                            if is_start_of_arrow(&row_nodes[k]) {
                                return perr(format!(
                                    "Missing a {arrow_char} character to complete a CD arrow."
                                ));
                            }
                            label.get("body").push(row_nodes[k].clone());
                        }
                        if in_label {
                            return perr(format!(
                                "Missing a {arrow_char} character to complete a CD arrow."
                            ));
                        }
                    }
                } else {
                    return perr("Expected one of \"<>AV=|.\" after @.");
                }
                row.push(cd_arrow(&arrow_char, &labels, parser)?);
                cell = new_cell();
            }
            j += 1;
        }
        if i % 2 == 0 {
            row.push(cell);
        } else if !row.is_empty() {
            row.remove(0);
        }
        body.push(std::mem::take(&mut row));
    }

    parser.gullet.end_group()?;
    parser.gullet.end_group()?;

    let n = body.len();
    let empty_lines: Vec<V> = (0..=n).map(|_| V::arr(Vec::new())).collect();
    Ok(node! {"type" => "array", "mode" => "math"}
        .with("body", V::arr(body.into_iter().map(V::arr).collect()))
        .with("tags", V::Null)
        .with("labels", V::arr((0..=n).map(|_| V::str("")).collect()))
        .with("envClasses", V::arr(vec![V::str("jot"), V::str("cd")]))
        .with("cols", V::arr(Vec::new()))
        .with("hLinesBeforeRow", V::arr(empty_lines)))
}

fn label_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    Ok(
        node! {"type" => "cdlabel", "mode" => ctx.parser.mode, "side" => &ctx.func_name[4..]}
            .with("label", args[0].clone()),
    )
}

fn label_builder(group: &V, style: &Style) -> R<Tree> {
    let label = group.get("label");
    if label.get("body").len() == 0 {
        return Ok(Tree::Math(MathNode::new("mrow", Vec::new())));
    }
    let mut mrow = build_group(&label, style)?;
    if group.text("side") == "left" {
        mrow.classes_mut()?.push("tml-shift-left".to_string());
    }
    let mut mtd = MathNode::new("mtd", vec![mrow]);
    mtd.set_style("padding", "0");
    let mtr = MathNode::new("mtr", vec![Tree::Math(mtd)]);
    let mtable = MathNode::new("mtable", vec![Tree::Math(mtr)]);
    let mut node = MathNode::new("mpadded", vec![Tree::Math(mtable)]);
    node.set_attribute("width", "0.1px");
    node.set_attribute("displaystyle", "false");
    node.set_attribute("scriptlevel", "1");
    Ok(Tree::Math(node))
}

fn parent_handler(ctx: &mut Ctx, args: &[V], _opt: &[V]) -> R<V> {
    Ok(node! {"type" => "cdlabelparent", "mode" => ctx.parser.mode}
        .with("fragment", args[0].clone()))
}

fn parent_builder(group: &V, style: &Style) -> R<Tree> {
    Ok(Tree::Math(MathNode::new(
        "mrow",
        vec![build_group(&group.get("fragment"), style)?],
    )))
}

pub fn register(r: &mut Registry) {
    r.define(
        "cdlabel",
        &["\\\\cdleft", "\\\\cdright"],
        Props {
            num_args: 1,
            ..Props::D
        },
        label_handler,
        Some(label_builder),
    );
    r.define(
        "cdlabelparent",
        &["\\\\cdparent"],
        Props {
            num_args: 1,
            ..Props::D
        },
        parent_handler,
        Some(parent_builder),
    );
}
