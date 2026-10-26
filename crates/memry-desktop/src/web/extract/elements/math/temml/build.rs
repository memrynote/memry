//! `buildMathML.js`: parse tree to MathML tree.

use super::functions;
use super::linebreak::set_line_breaks;
use super::settings::Settings;
use super::style::Style;
use super::tables::{symbol, tables};
use super::tree::{Anchor, MathNode, Tree};
use super::val::{R, V, jserr, perr};

/// `makeText(text, mode, style)`.
pub fn make_text(text: &str, mode: &str, style: Option<&Style>) -> Tree {
    let mut text = text.to_string();
    if let Some(replace) = symbol(mode, &text).and_then(|s| s.replace.as_ref())
        && !replace.is_empty()
    {
        let first_is_math_alnum = text.chars().next().is_some_and(|c| {
            let u = c as u32;
            (0x1D400..=0x1D7FF).contains(&u)
        });
        let tt = |s: &str| s.chars().skip(4).take(2).collect::<String>() == "tt";
        let ligature_in_tt = tables().ligatures.contains(&text)
            && style.is_some_and(|st| tt(&st.font_family) || tt(&st.font));
        if !first_is_math_alnum && !ligature_in_tt {
            text = replace.clone();
        }
    }
    Tree::Text(text)
}

fn text_of(tree: &Tree) -> String {
    match tree {
        Tree::Text(t) => t.clone(),
        _ => String::new(),
    }
}

fn copy_char(new_row: &mut MathNode, child: &MathNode) {
    let ch = child.children.first().map(text_of).unwrap_or_default();
    match new_row.children.last_mut() {
        Some(Tree::Math(last)) if last.ty == "mtext" => {
            if let Some(Tree::Text(t)) = last.children.first_mut() {
                t.push_str(&ch);
            }
        }
        _ => new_row
            .children
            .push(Tree::Math(MathNode::new("mtext", vec![Tree::Text(ch)]))),
    }
}

/// `consolidateText(mrow)`.
pub fn consolidate_text(mrow: Tree) -> Tree {
    let Tree::Math(src) = &mrow else {
        return mrow;
    };
    if src.ty != "mrow" && src.ty != "mstyle" {
        return mrow;
    }
    if src.children.is_empty() {
        return mrow;
    }
    let mut new_row = MathNode::new("mrow", Vec::new());
    for child in &src.children {
        match child {
            Tree::Math(c) if c.ty == "mtext" && c.attributes.is_empty() => {
                copy_char(&mut new_row, c);
            }
            Tree::Math(c) if c.ty == "mrow" => {
                let can = c.children.iter().all(|g| {
                    matches!(g, Tree::Math(m) if m.ty == "mtext") && c.attributes.is_empty()
                });
                if can {
                    for g in &c.children {
                        if let Tree::Math(m) = g {
                            copy_char(&mut new_row, m);
                        }
                    }
                } else {
                    new_row.children.push(child.clone());
                }
            }
            _ => new_row.children.push(child.clone()),
        }
    }
    for child in &mut new_row.children {
        if let Tree::Math(m) = child
            && m.ty == "mtext"
        {
            if let Some(Tree::Text(t)) = m.children.first_mut() {
                if t.starts_with(' ') {
                    *t = format!("\u{a0}{}", &t[1..]);
                }
                if t.ends_with(' ') {
                    t.pop();
                    t.push('\u{a0}');
                }
            }
            for (k, v) in &src.attributes {
                m.set_attribute(k, v.clone());
            }
        }
    }
    if new_row.children.len() == 1 && new_row.children[0].is_ty("mtext") {
        new_row.children.remove(0)
    } else {
        Tree::Math(new_row)
    }
}

fn is_fence_free_mo(t: &Tree) -> bool {
    matches!(t, Tree::Math(m) if m.ty == "mo" && m.get_attribute("fence").is_none_or(str::is_empty))
}

/// `makeRow(body, semisimple)`.
pub fn make_row(mut body: Vec<Tree>, semisimple: bool) -> Tree {
    if body.len() == 1 && !matches!(body[0], Tree::Frag(_)) {
        return body.remove(0);
    } else if !semisimple {
        if !body.is_empty() && is_fence_free_mo(&body[0]) {
            if let Tree::Math(m) = &mut body[0] {
                m.set_attribute("lspace", "0em");
                m.set_attribute("rspace", "0em");
            }
        }
        let end = body.len().wrapping_sub(1);
        if !body.is_empty() && is_fence_free_mo(&body[end]) {
            if let Tree::Math(m) = &mut body[end] {
                m.set_attribute("lspace", "0em");
                m.set_attribute("rspace", "0em");
            }
        }
    }
    Tree::Math(MathNode::new("mrow", body))
}

fn single_text(group: &MathNode) -> Option<&str> {
    match group.children.as_slice() {
        [Tree::Text(t)] => Some(t.as_str()),
        _ => None,
    }
}

fn is_number_punctuation(group: Option<&Tree>) -> bool {
    let Some(Tree::Math(g)) = group else {
        return false;
    };
    match g.ty.as_str() {
        "mi" => single_text(g) == Some("."),
        "mtext" => single_text(g) == Some("\u{2008}"),
        "mo" => {
            g.children.len() == 1
                && g.get_attribute("separator") == Some("true")
                && g.get_attribute("lspace") == Some("0em")
                && g.get_attribute("rspace") == Some("0em")
                && single_text(g) == Some(",")
        }
        _ => false,
    }
}

fn is_comma(expression: &[V], i: usize) -> bool {
    let node = &expression[i];
    let Some(following) = expression.get(i + 1) else {
        return false;
    };
    let text_is_comma = node.is_type("atom") && matches!(node.get("text"), V::Str(s) if s == ",");
    match (node.loc(), following.loc()) {
        (Some(a), Some(b)) => text_is_comma && a.end == b.start,
        _ => false,
    }
}

fn is_rel(item: &V) -> bool {
    (item.is_type("atom") && matches!(item.get("family"), V::Str(f) if f == "rel"))
        || (item.is_type("mclass") && matches!(item.get("mclass"), V::Str(f) if f == "mrel"))
}

/// `group.setAttribute(name, value)` on a tree that has no such method throws.
pub fn set_attr(tree: &mut Tree, name: &str, value: &str) -> R<()> {
    match tree {
        Tree::Math(m) => {
            m.set_attribute(name, value);
            Ok(())
        }
        _ => jserr("group.setAttribute is not a function"),
    }
}

/// `buildExpression(expression, style, semisimple)`.
pub fn build_expression(expression: &[V], style: &Style, semisimple: bool) -> R<Vec<Tree>> {
    if !semisimple && expression.len() == 1 {
        let mut group = build_group(&expression[0], style)?;
        if group.is_ty("mo") {
            set_attr(&mut group, "lspace", "0em")?;
            set_attr(&mut group, "rspace", "0em")?;
        }
        return Ok(vec![group]);
    }
    let mut groups: Vec<Tree> = Vec::new();
    let mut group_array = Vec::new();
    for e in expression {
        group_array.push(build_group(e, style)?);
    }
    for i in 0..group_array.len() {
        let mut group = group_array[i].clone();
        if i + 1 < expression.len() && is_rel(&expression[i]) && is_rel(&expression[i + 1]) {
            set_attr(&mut group, "rspace", "0em")?;
        }
        if i > 0 && is_rel(&expression[i]) && is_rel(&expression[i - 1]) {
            set_attr(&mut group, "lspace", "0em")?;
        }
        let last_is_mn = groups.last().is_some_and(|l| l.is_ty("mn"));
        let group_children = |g: &Tree| g.as_math().map(|m| m.children.clone()).unwrap_or_default();
        if group.is_ty("mn") && last_is_mn {
            let extra = group_children(&group);
            if let Some(Tree::Math(l)) = groups.last_mut() {
                l.children.extend(extra);
            }
            continue;
        } else if is_number_punctuation(Some(&group)) && last_is_mn {
            let extra = group_children(&group);
            if let Some(Tree::Math(l)) = groups.last_mut() {
                l.children.extend(extra);
            }
            continue;
        } else if last_is_mn
            && i + 1 < group_array.len()
            && group_array[i + 1].is_ty("mn")
            && is_comma(expression, i)
        {
            let extra = group_children(&group);
            if let Some(Tree::Math(l)) = groups.last_mut() {
                l.children.extend(extra);
            }
            continue;
        } else if group.is_ty("mn") && is_number_punctuation(groups.last()) {
            let mut merged = groups.last().map(group_children).unwrap_or_default();
            merged.extend(group_children(&group));
            if let Tree::Math(g) = &mut group {
                g.children = merged;
            }
            groups.pop();
        } else if (group.is_ty("msup") || group.is_ty("msub"))
            && group.as_math().is_some_and(|g| !g.children.is_empty())
            && groups
                .last()
                .is_some_and(|l| l.is_ty("mn") || is_number_punctuation(Some(l)))
        {
            let last_children = groups.last().map(group_children).unwrap_or_default();
            if let Tree::Math(g) = &mut group
                && let Some(Tree::Math(base)) = g.children.first_mut()
                && base.ty == "mn"
            {
                let mut merged = last_children;
                merged.extend(base.children.clone());
                base.children = merged;
                groups.pop();
            }
        }
        groups.push(group);
    }
    Ok(groups)
}

pub fn build_expression_row(expression: &[V], style: &Style, semisimple: bool) -> R<Tree> {
    Ok(make_row(
        build_expression(expression, style, semisimple)?,
        semisimple,
    ))
}

/// `buildGroup(group, style)`.
pub fn build_group(group: &V, style: &Style) -> R<Tree> {
    if group.is_nullish() {
        return Ok(Tree::Math(MathNode::new("mrow", Vec::new())));
    }
    match functions::builder(&group.ty()) {
        Some(builder) => builder(group, style),
        None => perr(format!("Got group of unknown type: '{}'", group.ty())),
    }
}

fn glue() -> Tree {
    let mut n = MathNode::new("mtd", Vec::new());
    n.set_style("padding", "0");
    n.set_style("width", "50%");
    Tree::Math(n)
}

const LABEL_CONTAINERS: [&str; 4] = ["mrow", "mtd", "mtable", "mtr"];

fn get_label(parent: &Tree) -> Option<String> {
    let children = match parent {
        Tree::Math(m) => &m.children,
        Tree::Frag(f) => &f.children,
        _ => return None,
    };
    for node in children {
        match node {
            Tree::Math(m) if LABEL_CONTAINERS.contains(&m.ty.as_str()) => {
                if m.classes.first().is_some_and(|c| c == "tml-label") {
                    return Some(m.label.clone());
                }
                if let Some(label) = get_label(node).filter(|l| !l.is_empty()) {
                    return Some(label);
                }
            }
            Tree::Frag(_) => {
                if let Some(label) = get_label(node).filter(|l| !l.is_empty()) {
                    return Some(label);
                }
            }
            _ => {}
        }
    }
    None
}

fn tagged_expression(expression: Tree, tag: &[V], style: &Style, leqno: bool) -> R<Tree> {
    let body = tag.first().map(|t| t.get("body")).unwrap_or(V::Undef);
    let mut tag_row = build_expression_row(&body.items(), style, false)?;
    tag_row = consolidate_text(tag_row);
    tag_row.classes_mut()?.push("tml-tag".to_string());
    let label = get_label(&expression);
    let expression = Tree::Math(MathNode::new("mtd", vec![expression]));
    let mut row_array = vec![glue(), expression, glue()];
    let idx = if leqno { 0 } else { 2 };
    if let Some(c) = row_array[idx].children_mut() {
        c.push(tag_row);
    }
    let mut mtr = MathNode::with_classes("mtr", row_array, &["tml-tageqn"]);
    if let Some(label) = label {
        mtr.set_attribute("id", label);
    }
    let mut table = MathNode::new("mtable", vec![Tree::Math(mtr)]);
    table.set_style("width", "100%");
    table.set_attribute("displaystyle", "true");
    Ok(Tree::Math(table))
}

/// `buildMathML(tree, texExpression, style, settings)`.
pub fn build_mathml(mut tree: Vec<V>, style: &Style, settings: &Settings) -> R<Tree> {
    let mut tag: Option<V> = None;
    if tree.len() == 1 && tree[0].is_type("tag") {
        tag = Some(tree[0].get("tag"));
        let body = tree[0].get("body");
        tree = body.items();
    }
    let mut expression = build_expression(&tree, style, false)?;
    if expression.len() == 1 && matches!(expression[0], Tree::Anchor(Anchor { .. })) {
        return Ok(expression.remove(0));
    }
    let wrap = "none";
    let mut wrapper = if expression.len() == 1 && tag.is_none() && expression[0].as_math().is_some()
    {
        expression.remove(0)
    } else {
        set_line_breaks(expression, wrap, settings.display_mode)?
    };
    if let Some(tag) = tag {
        wrapper = tagged_expression(wrapper, &tag.items(), style, false)?;
    }
    let mut math = MathNode::new("math", vec![wrapper]);
    if settings.display_mode {
        math.set_attribute("display", "block");
        math.set_style("display", "block math");
        math.classes = vec!["tml-display".to_string()];
    }
    Ok(Tree::Math(math))
}
