//! `linebreaking.js` with `wrap: "none"`, the only wrap mode Defuddle's call reaches: only the
//! explicit `\\` rows (`linebreak="newline"`) split the expression.

use super::tree::{MathNode, Tree};
use super::val::R;

pub fn set_line_breaks(expression: Vec<Tree>, wrap_mode: &str, is_display_mode: bool) -> R<Tree> {
    debug_assert_eq!(wrap_mode, "none");
    let mut mtrs: Vec<Tree> = Vec::new();
    let mut mrows: Vec<Tree> = Vec::new();
    let mut block: Vec<Tree> = Vec::new();
    let mut expression = expression;
    let mut i = 0;
    while i < expression.len() {
        while let Tree::Frag(f) = &expression[i] {
            let children = f.children.clone();
            expression.splice(i..i + 1, children);
            if i >= expression.len() {
                break;
            }
        }
        if i >= expression.len() {
            break;
        }
        let node = expression[i].clone();
        let is_newline = matches!(&node, Tree::Math(m) if m.get_attribute("linebreak") == Some("newline"));
        if is_newline {
            if !block.is_empty() {
                mrows.push(Tree::Math(MathNode::new("mrow", std::mem::take(&mut block))));
            }
            mrows.push(node);
            block = Vec::new();
            let mut mtd = MathNode::new("mtd", std::mem::take(&mut mrows));
            mtd.set_style("textAlign", "left");
            mtrs.push(Tree::Math(MathNode::new("mtr", vec![Tree::Math(mtd)])));
            i += 1;
            continue;
        }
        block.push(node);
        i += 1;
    }
    if !block.is_empty() {
        mrows.push(Tree::Math(MathNode::new("mrow", block)));
    }
    if !mtrs.is_empty() {
        let mut mtd = MathNode::new("mtd", mrows);
        mtd.set_style("textAlign", "left");
        mtrs.push(Tree::Math(MathNode::new("mtr", vec![Tree::Math(mtd)])));
        let mut mtable = MathNode::new("mtable", mtrs);
        if !is_display_mode {
            mtable.set_attribute("columnalign", "left");
            mtable.set_attribute("rowspacing", "0em");
        }
        return Ok(Tree::Math(mtable));
    }
    Ok(Tree::frag(mrows))
}
