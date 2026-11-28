//! The nesting cap counts what desktop's HTML parse keeps open, not the number
//! of handled tags a note spells (`inline/raw-html.ts`): `<li>`, `<td>`, `<tr>`
//! and their kin close by themselves, a paragraph ends the marks opened in it,
//! and the parse keeps three of any identical `<b>`. A line holding a handled
//! tag that desktop leaves to its parse falls back here, so the lines that fall
//! back are the lines the cap left alone.

use memry_core::crdt::markdown_seed::plan;

/// Every line the plan keeps as literal text because it holds a handled tag.
fn fallback_lines(markdown: &str) -> Vec<String> {
    plan(markdown)
        .fallbacks
        .into_iter()
        .flat_map(|fallback| fallback.lines)
        .collect()
}

fn numbered(count: usize, make: impl Fn(usize) -> String, join: &str) -> String {
    (0..count).map(make).collect::<Vec<_>>().join(join)
}

#[test]
fn paragraphs_of_an_unclosed_mark_are_all_left_to_the_parse() {
    let markdown = numbered(102, |i| format!("<b>x{i}"), "\n\n");
    let lines = fallback_lines(&markdown);
    assert_eq!(lines.len(), 102);
    assert_eq!(lines[101], "<b>x101");
}

#[test]
fn list_items_with_no_close_are_all_left_to_the_parse() {
    // A blank line between them makes each its own block, so a line the cap
    // left alone is one that falls back.
    let items = numbered(105, |i| format!("<li>item{i}"), "\n\n");
    let lines = fallback_lines(&format!("<ul>\n\n{items}\n\n</ul>"));
    assert_eq!(lines.len(), 105 + 2);
}

#[test]
fn table_rows_of_unclosed_cells_are_all_left_to_the_parse() {
    let rows = numbered(60, |i| format!("<tr><td>a{i}<td>b{i}"), "\n\n");
    let lines = fallback_lines(&format!("<table>\n\n{rows}\n\n</table>"));
    assert_eq!(lines.len(), 60 + 2);
}
