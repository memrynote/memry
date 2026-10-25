//! `serializeTable` of `htmlToMarkdown.ts`: the colspan and rowspan grid, the
//! column widths (at least 10) and the padded GFM rows.

use super::inline::cell_text;
use super::{Ctx, query_tag, query_tag_all};
use crate::markdown::bn::dom::{Dom, NodeId};
use crate::markdown::frontmatter::js::parse_int;

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `String#padEnd` by UTF-16 length.
fn pad_end(text: &str, width: usize) -> String {
    let len = utf16_len(text);
    format!("{text}{}", " ".repeat(width.saturating_sub(len)))
}

fn span(dom: &Dom, cell: NodeId, name: &str) -> usize {
    let v = dom
        .attr(cell, name)
        .filter(|v| !v.is_empty())
        .map_or(1.0, |v| parse_int(v, 10));
    if v.is_finite() && v > 0.0 {
        v as usize
    } else {
        1
    }
}

fn format_row(cells: &[String], widths: &[usize], col_count: usize) -> String {
    let parts: Vec<String> = (0..col_count)
        .map(|c| {
            let cell = cells.get(c).map_or("", String::as_str);
            format!(" {} ", pad_end(cell, widths[c]))
        })
        .collect();
    format!("|{}|", parts.join("|"))
}

fn separator_row(widths: &[usize], col_count: usize) -> String {
    let parts: Vec<String> = (0..col_count)
        .map(|c| format!(" {} ", "-".repeat(widths[c])))
        .collect();
    format!("|{}|", parts.join("|"))
}

pub(super) fn table(dom: &Dom, el: NodeId, ctx: &Ctx) -> String {
    let mut col_count =
        query_tag(dom, el, "colgroup").map_or(0, |g| query_tag_all(dom, g, &["col"]).len());
    let mut has_header = false;
    let mut grid: Vec<Vec<Option<String>>> = Vec::new();

    for (row_idx, tr) in query_tag_all(dom, el, &["tr"]).into_iter().enumerate() {
        if grid.len() <= row_idx {
            grid.resize(row_idx + 1, Vec::new());
        }
        let mut grid_col = 0;
        for cell in query_tag_all(dom, tr, &["th", "td"]) {
            while grid[row_idx].get(grid_col).is_some_and(Option::is_some) {
                grid_col += 1;
            }
            if row_idx == 0 && dom.is_html(cell, "th") {
                has_header = true;
            }
            let content = cell_text(dom, cell).replace('|', "\\|");
            let (colspan, rowspan) = (span(dom, cell, "colspan"), span(dom, cell, "rowspan"));
            for r in 0..rowspan {
                for c in 0..colspan {
                    let ri = row_idx + r;
                    if grid.len() <= ri {
                        grid.resize(ri + 1, Vec::new());
                    }
                    let row = &mut grid[ri];
                    if row.len() <= grid_col + c {
                        row.resize(grid_col + c + 1, None);
                    }
                    row[grid_col + c] = Some(if r == 0 && c == 0 {
                        content.clone()
                    } else {
                        String::new()
                    });
                }
            }
            grid_col += colspan;
        }
        col_count = col_count.max(grid[row_idx].len());
    }

    let rows: Vec<Vec<String>> = grid
        .iter()
        .map(|grid_row| {
            (0..col_count)
                .map(|c| grid_row.get(c).cloned().flatten().unwrap_or_default())
                .collect()
        })
        .collect();
    if rows.is_empty() {
        return String::new();
    }
    let widths: Vec<usize> = (0..col_count)
        .map(|c| {
            let max = rows.iter().map(|r| utf16_len(&r[c])).fold(3, usize::max);
            max.max(10)
        })
        .collect();

    let mut result = String::new();
    let push = |result: &mut String, line: String| {
        result.push_str(&ctx.indent);
        result.push_str(&line);
        result.push('\n');
    };
    if has_header {
        push(&mut result, format_row(&rows[0], &widths, col_count));
        push(&mut result, separator_row(&widths, col_count));
        for row in &rows[1..] {
            push(&mut result, format_row(row, &widths, col_count));
        }
    } else {
        push(
            &mut result,
            format_row(&vec![String::new(); col_count], &widths, col_count),
        );
        push(&mut result, separator_row(&widths, col_count));
        for row in &rows {
            push(&mut result, format_row(row, &widths, col_count));
        }
    }
    result.push('\n');
    result
}
