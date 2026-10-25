//! HTML emitter: `tokensToHtml`, `emitListItems`, `emitTable`.

use super::block::{ListKind, Table, Token, tokenize};
use super::inline::{escape_html, parse_inline};
use super::scan::is_js_ws;

/// JS `String(Number)` for the values `parseInt` can produce.
fn js_number(n: f64) -> String {
    if n.is_infinite() {
        "Infinity".to_string()
    } else if n >= 1e21 {
        let e = format!("{n:e}");
        let (m, exp) = e.split_once('e').expect("exponent");
        format!("{m}e+{exp}")
    } else {
        format!("{n}")
    }
}

pub(super) fn tokens_to_html(tokens: &[Token]) -> String {
    let mut html = String::new();
    let mut i = 0;
    while i < tokens.len() {
        match &tokens[i] {
            Token::Heading { level, content } => {
                html.push_str(&format!("<h{level}>{}</h{level}>", parse_inline(content)));
            }
            Token::Paragraph(c) => html.push_str(&format!("<p>{}</p>", parse_inline(c))),
            Token::CodeBlock { language, code } => {
                let attr = if language.is_empty() {
                    String::new()
                } else {
                    format!(" data-language=\"{}\"", escape_html(language))
                };
                html.push_str(&format!(
                    "<pre><code{attr}>{}</code></pre>",
                    escape_html(code)
                ));
            }
            Token::Blockquote(c) => {
                html.push_str(&format!(
                    "<blockquote>{}</blockquote>",
                    tokens_to_html(&tokenize(c))
                ));
            }
            Token::Hr => html.push_str("<hr>"),
            Token::ListItem(_) => {
                let (h, next) = emit_list_items(tokens, i);
                html.push_str(&h);
                i = next;
                continue;
            }
            Token::Table(t) => html.push_str(&emit_table(t)),
            Token::RawHtml(c) => html.push_str(c),
        }
        i += 1;
    }
    html
}

fn emit_list_items(tokens: &[Token], start: usize) -> (String, usize) {
    let mut html = String::new();
    let mut i = start;
    let mut current: Option<bool> = None; // Some(ordered)
    let close = |ordered: bool| if ordered { "</ol>" } else { "</ul>" };

    while let Some(Token::ListItem(item)) = tokens.get(i) {
        let ordered = item.kind == ListKind::Ordered;
        if let Some(cur) = current
            && cur != ordered
        {
            html.push_str(close(cur));
            current = None;
        }
        if current.is_none() {
            if ordered {
                match item.start {
                    Some(s) if s != 1.0 => {
                        html.push_str(&format!("<ol start=\"{}\">", js_number(s)))
                    }
                    _ => html.push_str("<ol>"),
                }
            } else {
                html.push_str("<ul>");
            }
            current = Some(ordered);
        }
        if item.kind == ListKind::Task {
            let checked = if item.checked { " checked" } else { "" };
            html.push_str(&format!(
                "<li><input type=\"checkbox\" disabled{checked}><p>{}</p>",
                parse_inline(&item.content)
            ));
        } else {
            html.push_str(&format!("<li><p>{}</p>", parse_inline(&item.content)));
        }
        if let Some(child) = &item.child_content {
            html.push_str(&tokens_to_html(&tokenize(child)));
        }
        html.push_str("</li>");
        i += 1;
    }
    if let Some(cur) = current {
        html.push_str(close(cur));
    }
    (html, i)
}

fn emit_table(table: &Table) -> String {
    let mut html = String::from("<table>");
    let header_empty = table.headers.iter().all(|h| h.chars().all(is_js_ws));
    let cols = table.headers.len();
    let align = |c: usize| {
        table
            .alignments
            .get(c)
            .copied()
            .flatten()
            .map_or_else(String::new, |a| format!(" align=\"{a}\""))
    };
    if !header_empty {
        html.push_str("<thead><tr>");
        for c in 0..cols {
            html.push_str(&format!(
                "<th{}>{}</th>",
                align(c),
                parse_inline(&table.headers[c])
            ));
        }
        html.push_str("</tr></thead>");
    }
    if !table.rows.is_empty() {
        html.push_str("<tbody>");
        for row in &table.rows {
            html.push_str("<tr>");
            for c in 0..cols {
                let cell = row.get(c).map_or("", String::as_str);
                html.push_str(&format!("<td{}>{}</td>", align(c), parse_inline(cell)));
            }
            html.push_str("</tr>");
        }
        html.push_str("</tbody>");
    }
    html.push_str("</table>");
    html
}
