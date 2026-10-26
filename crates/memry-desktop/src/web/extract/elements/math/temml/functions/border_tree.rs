//! `environments/borderTree.js`: the parse tree of `\bordermatrix`.

use crate::node;
use crate::web::extract::elements::math::temml::val::{R, V, jserr};

fn ord_group(body: Vec<V>) -> V {
    node! {"type" => "ordgroup", "mode" => "math", "semisimple" => true}.with("body", V::arr(body))
}

fn phantom(body: Vec<V>, ty: &str) -> V {
    node! {"type" => ty, "mode" => "math"}.with("body", ord_group(body))
}

fn empty_arrays(n: usize) -> Vec<V> {
    (0..n).map(|_| V::arr(Vec::new())).collect()
}

fn repeat(n: usize, v: V) -> V {
    V::arr((0..n).map(|_| v.clone()).collect())
}

fn align_c() -> V {
    node! {"type" => "align", "align" => "c"}
}

/// `bordermatrixParseTree(matrix, delimiters)`; `delimiters` is `undefined` or `[left, right]`.
pub fn bordermatrix_parse_tree(matrix: &V, delimiters: &V) -> R<V> {
    let body = matrix.get("body");
    let rows = body.items();
    if rows.is_empty() {
        return jserr("Cannot read properties of undefined (reading 'shift')");
    }
    rows[0].shift();

    let n = rows.len();
    let left_column_body = empty_arrays(n.saturating_sub(1));
    for i in 1..n {
        left_column_body[i - 1].push(rows[i].shift());
        let phantom_body = rows[i].items();
        left_column_body[i - 1].push(phantom(phantom_body, "vphantom"));
    }

    let top_row_body = empty_arrays(n);
    let width = rows[0].len();
    for j in 0..width {
        top_row_body[0].push(rows[0].at(j));
    }
    for i in 1..n {
        for j in 0..width {
            let cell = rows[i].at(j);
            if cell.is_undef() {
                return jserr("Cannot read properties of undefined (reading 'body')");
            }
            top_row_body[i].push(phantom(cell.get("body").items(), "hphantom"));
        }
    }
    for j in 0..width {
        rows[0].set_at(j, phantom(rows[0].at(j).get("body").items(), "hphantom"));
    }

    let left_len = left_column_body.len();
    if left_len == 0 {
        return jserr("Invalid array length");
    }
    let colsep = V::new_obj();
    colsep.set("number", V::Num(0.04));
    colsep.set("unit", V::str("em"));
    let left_column =
        node! {"type" => "array", "mode" => "math", "scriptLevel" => "text", "arraystretch" => 1.0}
            .with("body", V::arr(left_column_body))
            .with("cols", V::arr(vec![align_c()]))
            .with("rowGaps", repeat(left_len - 1, V::Null))
            .with("hLinesBeforeRow", V::arr(empty_arrays(left_len + 1)))
            .with("envClasses", V::arr(Vec::new()))
            .with("labels", repeat(left_len, V::str("")))
            .with("arraycolsep", colsep);

    let top_len = top_row_body.len();
    let top_row =
        node! {"type" => "array", "mode" => "math", "scriptLevel" => "text", "arraystretch" => 1.0}
            .with("body", V::arr(top_row_body))
            .with("cols", repeat(top_len, align_c()))
            .with("rowGaps", repeat(top_len.saturating_sub(1), V::Null))
            .with("hLinesBeforeRow", V::arr(empty_arrays(top_len + 1)))
            .with("envClasses", V::arr(Vec::new()))
            .with("labels", repeat(top_len, V::str("")))
            .with("arraycolsep", V::Null);

    let top_wrapper = node! {"type" => "styling", "mode" => "math", "scriptLevel" => "text"}
        .with("body", V::arr(vec![top_row]));

    let (left, right) = if delimiters.is_arr() {
        (delimiters.at(0), delimiters.at(1))
    } else {
        (V::str("("), V::str(")"))
    };
    let container = node! {"type" => "leftright", "mode" => "math"}
        .with("body", V::arr(vec![matrix.clone()]))
        .with("left", left)
        .with("right", right)
        .with("rightColor", V::Undef);

    let base = node! {
        "type" => "op", "mode" => "math", "limits" => true, "alwaysHandleSupSub" => true,
        "parentIsSupSub" => true, "symbol" => false, "suppressBaseShift" => true
    }
    .with("body", V::arr(vec![container]));

    let mover = node! {"type" => "supsub", "mode" => "math", "stack" => true}
        .with("base", base)
        .with("sup", top_wrapper)
        .with("sub", V::Null);

    Ok(ord_group(vec![left_column, mover]))
}
