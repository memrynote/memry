//! The `table` rule: layout tables flatten, tables with spans stay HTML, the rest become
//! pipe tables.

use crate::web::extract::dom::NodeId;
use crate::web::extract::markdown::turndown::NodeInfo;
use crate::web::extract::markdown::turndown::parse::Dom;
use crate::web::extract::utils::js::trim;

/// The attributes `cleanupTableHTML` keeps.
const TABLE_ATTRIBUTES: &[&str] = &[
    "src", "href", "style", "align", "width", "height", "rowspan", "colspan", "bgcolor", "scope",
    "valign", "headers",
];

/// `isDirectTableChild(el, ancestor)`: `el` belongs to `ancestor`, not to a table between them.
fn is_direct_table_child(dom: &Dom, el: NodeId, ancestor: NodeId) -> bool {
    let mut parent = dom.doc.parent_node(el);
    while let Some(p) = parent {
        if p == ancestor {
            return true;
        }
        if dom.is_name(p, "TABLE") {
            return false;
        }
        parent = dom.doc.parent_node(p);
    }
    false
}

/// `cleanupTableHTML(element)`: the table's HTML without attributes outside the allow list.
fn cleanup_table_html(dom: &mut Dom, table: NodeId) -> String {
    let clone = dom.doc.clone_node(table, true);
    let mut elements = vec![clone];
    elements.extend(dom.doc.descendants(clone));
    elements.retain(|&e| dom.is_element(e));
    for element in elements {
        let names: Vec<String> = dom
            .doc
            .attributes(element)
            .iter()
            .map(|a| a.name.clone())
            .filter(|name| !TABLE_ATTRIBUTES.contains(&name.as_str()))
            .collect();
        for name in names {
            dom.doc.remove_attribute(element, &name);
        }
    }
    // outerHTML encodes `&` as `&amp;`, which breaks LaTeX alignment characters; the output goes
    // into markdown, not back through an HTML parser.
    dom.outer_html(clone)
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn format_row(cells: &[String], columns: usize) -> String {
    let mut padded: Vec<&str> = cells.iter().map(String::as_str).collect();
    padded.resize(columns, "");
    format!("| {} |", padded.join(" | "))
}

pub fn table(dom: &mut Dom, node: NodeId, content: &str, _: &NodeInfo) -> String {
    // Equation tables (arXiv, Wikipedia) hold their LaTeX in nested `math` elements.
    if ["ltx_equation", "ltx_eqn_table", "numblk"]
        .iter()
        .any(|class| dom.class_contains(node, class))
    {
        return super::math::handle_nested_equations(dom, node);
    }
    let has_nested_tables = !dom.query_names(node, &["table"]).is_empty();
    let direct_cells: Vec<NodeId> = dom
        .query_names(node, &["td", "th"])
        .into_iter()
        .filter(|&el| is_direct_table_child(dom, el, node))
        .collect();
    if has_nested_tables || direct_cells.len() <= 1 {
        let direct_rows: Vec<NodeId> = dom
            .query_names(node, &["tr"])
            .into_iter()
            .filter(|&el| is_direct_table_child(dom, el, node))
            .collect();
        let cell_counts: Vec<usize> = direct_rows
            .iter()
            .map(|&tr| {
                direct_cells
                    .iter()
                    .filter(|&&c| dom.doc.parent_node(c) == Some(tr))
                    .count()
            })
            .collect();
        let is_single_column = !direct_rows.is_empty()
            && cell_counts.iter().all(|&n| n == cell_counts[0])
            && cell_counts[0] <= 1;
        // Layout tables position content: a single column, or cells that embed tables. Their
        // cells flatten, and each nested data table becomes its own markdown table.
        if is_single_column || has_nested_tables {
            let html: String = direct_cells.iter().map(|&c| dom.inner_html(c)).collect();
            return format!("\n\n{}\n\n", dom.turndown(&html));
        }
    }
    let cells = dom.query_names(node, &["td", "th"]);
    if cells
        .iter()
        .any(|&c| dom.attr(c, "colspan").is_some() || dom.attr(c, "rowspan").is_some())
    {
        return format!("\n\n{}\n\n", cleanup_table_html(dom, node));
    }
    // `table.rows` and `row.cells` are domino's `getElementsByTagName('tr')` and
    // `querySelectorAll('td,th')`; there is no nested table here, so they are the direct ones.
    let rows: Vec<Vec<String>> = dom
        .query_names(node, &["tr"])
        .into_iter()
        .map(|row| {
            dom.query_names(row, &["td", "th"])
                .into_iter()
                .map(|cell| {
                    let markdown = dom.turndown(&dom.inner_html(cell)).replace('\n', " ");
                    trim(&markdown).replace('|', "\\|")
                })
                .collect()
        })
        .collect();
    if rows.is_empty() {
        return content.to_string();
    }
    // A markdown table is as wide as its separator row; size every row to the widest one.
    let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
    if columns == 0 {
        return content.to_string();
    }
    let separator = format!("| {} |", vec!["---"; columns].join(" | "));
    let mut lines = vec![format_row(&rows[0], columns), separator];
    lines.extend(rows[1..].iter().map(|row| format_row(row, columns)));
    format!("\n\n{}\n\n", lines.join("\n"))
}
