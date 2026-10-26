//! `mathmlBuilder` of `environments/array.js`.

use crate::web::extract::elements::math::temml::build::{
    build_expression_row, build_group, consolidate_text,
};
use crate::web::extract::elements::math::temml::style::{DISPLAY, Style, TEXT};
use crate::web::extract::elements::math::temml::tree::{MathNode, Span, Tree};
use crate::web::extract::elements::math::temml::units::{calculate_size, to_fixed};
use crate::web::extract::elements::math::temml::val::{R, V, jserr, num_str};

const SCRIPT: i32 = 2;

fn cell(row: &mut MathNode, j: usize) -> R<&mut MathNode> {
    match row.children.get_mut(j) {
        Some(Tree::Math(m)) => Ok(m),
        _ => jserr("Cannot read properties of undefined (reading 'style')"),
    }
}

fn glue(group: &V) -> MathNode {
    let mut node = MathNode::new("mtd", Vec::new());
    node.set_style("padding", "0");
    node.set_style(
        "width",
        if group.get("envClasses").includes("multline") {
            "7.5%"
        } else {
            "50%"
        },
    );
    node
}

fn hline_style(lines: &V, side: &str, row: &mut MathNode) -> R<()> {
    if !lines.is_arr() {
        return jserr("Cannot read properties of undefined (reading 'length')");
    }
    let value = if lines.len() == 2 {
        "0.15em double".to_string()
    } else if lines.at(0).truthy() {
        "0.06em dashed".to_string()
    } else {
        "0.06em solid".to_string()
    };
    for j in 0..row.children.len() {
        cell(row, j)?.set_style(side, value.clone());
    }
    Ok(())
}

fn sep_kind(col: &V) -> &'static str {
    if col.is_type("separator") {
        "separator"
    } else {
        "other"
    }
}

/// `cols[i]`, a TypeError when out of range.
fn col_at(cols: &V, i: isize) -> R<V> {
    let col = if i < 0 { V::Undef } else { cols.at(i as usize) };
    if col.is_undef() {
        return jserr("Cannot read properties of undefined (reading 'type')");
    }
    Ok(col)
}

pub fn array_builder(group: &V, style: &Style) -> R<Tree> {
    let env_classes = group.get("envClasses");
    let has = |c: &str| env_classes.includes(c);
    let body = group.get("body");
    let rows = body.items();
    let num_rows = rows.len();
    let hlines = group.get("hLinesBeforeRow");
    let tags = group.get("tags");
    let tag_is_present = tags.is_arr() && tags.items().iter().any(V::truthy);
    let script_level = group.text("scriptLevel");
    let cell_level = match script_level.as_str() {
        "text" => TEXT,
        "script" => SCRIPT,
        _ => DISPLAY,
    };
    let mut tbl: Vec<MathNode> = Vec::new();

    for (i, rw) in rows.iter().enumerate() {
        let mut row: Vec<Tree> = Vec::new();
        let cells = rw.items();
        for c in &cells {
            let mut mtd =
                MathNode::new("mtd", vec![build_group(c, &style.with_level(cell_level))?]);
            if has("multline") {
                let align = if i == 0 {
                    "left"
                } else if i == num_rows - 1 {
                    "right"
                } else {
                    "center"
                };
                if align != "center" {
                    mtd.classes.push(format!("tml-{align}"));
                }
            }
            row.push(Tree::Math(mtd));
        }
        let num_columns = rows[0].len();
        for _ in 0..num_columns.saturating_sub(cells.len()) {
            row.push(Tree::Math(MathNode::with_style_object(
                "mtd",
                Vec::new(),
                style,
            )));
        }
        if tag_is_present {
            let tag = tags.at(i);
            let tag_element = match tag {
                V::Bool(true) => {
                    let span = Tree::Span(Span {
                        classes: vec!["tml-eqn".to_string()],
                        children: Vec::new(),
                        style: Vec::new(),
                    });
                    Tree::Math(MathNode::new("mtext", vec![span]))
                }
                V::Bool(false) => Tree::Math(MathNode::new("mtext", Vec::new())),
                ref t if t.is_arr() => {
                    let first = t.at(0);
                    if first.is_undef() {
                        return jserr("Cannot read properties of undefined (reading 'body')");
                    }
                    let level = style.with_level(cell_level);
                    let el = build_expression_row(&first.get("body").items(), &level, true)?;
                    let mut el = consolidate_text(el);
                    *el.classes_mut()? = vec!["tml-tag".to_string()];
                    el
                }
                _ => return jserr("Cannot read properties of undefined (reading '0')"),
            };
            row.insert(0, Tree::Math(glue(group)));
            row.push(Tree::Math(glue(group)));
            let k = if group.get("leqno").truthy() {
                0
            } else {
                row.len() - 1
            };
            cell_children(&mut row[k]).push(tag_element);
        }
        let mut mtr = MathNode::new("mtr", row);
        let label = group.get("labels").shift();
        if label.truthy() && tags.truthy() && tags.at(i).truthy() {
            mtr.set_attribute("id", label.as_string().unwrap_or_default());
            if tags.at(i).is_arr() {
                mtr.classes.push("tml-tageqn".to_string());
            }
        }

        if i == 0 && hlines.at(0).len() > 0 {
            hline_style(&hlines.at(0), "borderTop", &mut mtr)?;
        }
        let after = hlines.at(i + 1);
        if !after.is_arr() {
            return jserr("Cannot read properties of undefined (reading 'length')");
        }
        if after.len() > 0 {
            hline_style(&after, "borderBottom", &mut mtr)?;
        }

        let mut must_squash_row = true;
        for child in &mtr.children {
            let first = child.as_math().and_then(|m| m.children.first());
            let squashed = first
                .and_then(Tree::as_math)
                .is_some_and(|c| c.ty == "mpadded" && c.get_attribute("height") == Some("0px"));
            if !squashed {
                must_squash_row = false;
                break;
            }
        }
        if must_squash_row {
            mtr.classes.push("ff-squash".to_string());
            for j in 0..mtr.children.len() {
                let c = cell(&mut mtr, j)?;
                c.set_style("paddingTop", "0");
                c.set_style("paddingBottom", "0");
            }
        }
        tbl.push(mtr);
    }

    let arraystretch = group
        .get("arraystretch")
        .as_num()
        .filter(|n| *n != 0.0 && !n.is_nan());
    if let Some(stretch) = arraystretch
        && stretch != 1.0
    {
        let pad = format!("{}ex", num_str(1.4 * stretch - 0.8));
        for row in &mut tbl {
            for j in 0..row.children.len() {
                let c = cell(row, j)?;
                c.set_style("paddingTop", pad.clone());
                c.set_style("paddingBottom", pad.clone());
            }
        }
    }

    let mut side_padding: Option<String> = None;
    let mut side_pad_unit = String::new();
    if env_classes.len() > 0 {
        side_padding = Some(
            if has("abut") || has("cases") {
                "0"
            } else if has("small") {
                "0.1389"
            } else if has("cd") {
                "0.25"
            } else {
                "0.4"
            }
            .to_string(),
        );
        side_pad_unit = "em".to_string();
    }
    let arraycolsep = group.get("arraycolsep");
    if arraycolsep.truthy() {
        let number = arraycolsep.get("number").as_num().unwrap_or(f64::NAN);
        let size = calculate_size(number, &arraycolsep.text("unit"), style)?;
        side_padding = Some(to_fixed(size.number, 4));
        side_pad_unit = size.unit.to_string();
    }
    if let Some(side_padding) = side_padding {
        let num_cols = tbl.first().map_or(0, |r| r.children.len());
        let first_class = env_classes.at(0);
        let side_pad = |j: usize, hand: u8| -> String {
            if j == 0 && hand == 0 {
                return "0".to_string();
            }
            if j + 1 == num_cols && hand == 1 {
                return "0".to_string();
            }
            if !matches!(&first_class, V::Str(s) if s == "align") {
                return side_padding.clone();
            }
            if hand == 1 {
                return "0".to_string();
            }
            let odd = j % 2 == 1;
            if tag_is_present {
                if odd { "1" } else { "0" }
            } else if odd {
                "0"
            } else {
                "1"
            }
            .to_string()
        };
        for row in &mut tbl {
            for j in 0..row.children.len() {
                let c = cell(row, j)?;
                c.set_style("paddingLeft", format!("{}{side_pad_unit}", side_pad(j, 0)));
                c.set_style("paddingRight", format!("{}{side_pad_unit}", side_pad(j, 1)));
            }
        }
    }
    if env_classes.len() == 0 {
        let first_len = tbl.first().map_or(0, |r| r.children.len());
        for row in &mut tbl {
            cell(row, 0)?.set_style("paddingLeft", "0em");
            if row.children.len() == first_len {
                let last = row.children.len() - 1;
                cell(row, last)?.set_style("paddingRight", "0em");
            }
        }
    }

    if env_classes.len() > 0 {
        let align = has("align") || has("alignat");
        let leqno = group.get("leqno").truthy();
        for row in &mut tbl {
            let n = row.children.len();
            if align {
                for j in 0..n {
                    cell(row, j)?.classes =
                        vec![format!("tml-{}", if j % 2 == 1 { "left" } else { "right" })];
                }
                if tag_is_present {
                    let k = if leqno { 0 } else { n - 1 };
                    cell(row, k)?.classes = Vec::new();
                }
            }
            if n > 1 && has("cases") {
                cell(row, 1)?.set_style("paddingLeft", "1em");
            }
            if has("cases") || has("subarray") {
                for j in 0..n {
                    cell(row, j)?.classes.push("tml-left".to_string());
                }
            }
        }
    }

    let mut table = MathNode::new("mtable", tbl.into_iter().map(Tree::Math).collect());
    if env_classes.len() > 0 {
        if has("jot") {
            table.classes.push("tml-jot".to_string());
        } else if has("small") {
            table.classes.push("tml-small".to_string());
        }
    }
    if script_level == "display" {
        table.set_attribute("displaystyle", "true");
    }
    if group.get("autoTag").truthy() || has("multline") {
        table.set_style("width", "100%");
    }

    let cols = group.get("cols");
    if cols.is_arr() && cols.len() > 0 {
        column_separators(&cols, &mut table, tag_is_present)?;
    }

    if has("small") {
        let mut wrapped = MathNode::new("mstyle", vec![Tree::Math(table)]);
        wrapped.set_attribute("scriptlevel", "1");
        return Ok(Tree::Math(wrapped));
    }
    Ok(Tree::Math(table))
}

fn cell_children(tree: &mut Tree) -> &mut Vec<Tree> {
    match tree {
        Tree::Math(m) => &mut m.children,
        _ => unreachable!("array rows hold only <mtd> nodes"),
    }
}

fn rows_mut(table: &mut MathNode) -> impl Iterator<Item = &mut MathNode> {
    table.children.iter_mut().filter_map(Tree::as_math_mut)
}

fn double_or(cols: &V, i: isize, if_double: &str, solid: &str, dashed: &str, cur: &V) -> R<String> {
    Ok(if sep_kind(&col_at(cols, i)?) == "separator" {
        if_double.to_string()
    } else if cur.text("separator") == "|" {
        solid.to_string()
    } else {
        dashed.to_string()
    })
}

/// Column separator lines and column alignment.
fn column_separators(cols: &V, table: &mut MathNode, tag_is_present: bool) -> R<()> {
    let len = cols.len() as isize;
    let mut prev_type_was_align = false;
    let mut i_start: isize = 0;
    let mut i_end: isize = len;
    while sep_kind(&col_at(cols, i_start)?) == "separator" {
        i_start += 1;
    }
    while sep_kind(&col_at(cols, i_end - 1)?) == "separator" {
        i_end -= 1;
    }
    let first = col_at(cols, 0)?;
    if sep_kind(&first) == "separator" {
        let sep = double_or(
            cols,
            1,
            "0.15em double",
            "0.06em solid ",
            "0.06em dashed ",
            &first,
        )?;
        for row in rows_mut(table) {
            cell(row, 0)?.set_style("borderLeft", sep.clone());
        }
    }
    let mut i_col: isize = if tag_is_present { 0 } else { -1 };
    for i in i_start..i_end {
        let col = col_at(cols, i)?;
        if col.is_type("align") {
            let col_align = match col.text("align").as_str() {
                "c" => "center",
                "l" => "left",
                "r" => "right",
                _ => return jserr("Cannot read properties of undefined (reading 'trim')"),
            };
            i_col += 1;
            for row in rows_mut(table) {
                if col_align != "center" && (i_col as usize) < row.children.len() {
                    cell(row, i_col as usize)?.classes = vec![format!("tml-{col_align}")];
                }
            }
            prev_type_was_align = true;
        } else if col.is_type("separator") {
            if prev_type_was_align {
                let sep = double_or(
                    cols,
                    i + 1,
                    "0.15em double",
                    "0.06em solid",
                    "0.06em dashed",
                    &col,
                )?;
                for row in rows_mut(table) {
                    if i_col >= 0 && (i_col as usize) < row.children.len() {
                        cell(row, i_col as usize)?.set_style("borderRight", sep.clone());
                    }
                }
            }
            prev_type_was_align = false;
        }
    }
    let last = col_at(cols, len - 1)?;
    if sep_kind(&last) == "separator" {
        let sep = double_or(
            cols,
            len - 2,
            "0.15em double",
            "0.06em solid",
            "0.06em dashed",
            &last,
        )?;
        for row in rows_mut(table) {
            let n = row.children.len() - 1;
            let c = cell(row, n)?;
            c.set_style("borderRight", sep.clone());
            c.set_style("paddingRight", "0.4em");
        }
    }
    Ok(())
}
