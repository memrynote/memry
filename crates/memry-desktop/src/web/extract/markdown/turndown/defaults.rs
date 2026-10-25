//! The rules of turndown 7.2.4 that `createMarkdownContent` leaves reachable, and the blank,
//! keep, remove and default replacements.

use std::sync::LazyLock;

use regex::Regex;

use super::node::NodeInfo;
use super::parse::Dom;
use super::{Filter, Rule};
use crate::web::extract::dom::NodeId;
use crate::web::extract::utils::js::is_js_whitespace;

pub fn blank(_: &mut Dom, _: NodeId, _: &str, info: &NodeInfo) -> String {
    if info.is_block { "\n\n" } else { "" }.to_string()
}

pub fn keep(dom: &mut Dom, node: NodeId, _: &str, info: &NodeInfo) -> String {
    if info.is_block {
        format!("\n\n{}\n\n", dom.outer_html(node))
    } else {
        dom.outer_html(node)
    }
}

pub fn remove(_: &mut Dom, _: NodeId, _: &str, _: &NodeInfo) -> String {
    String::new()
}

pub fn fallback(_: &mut Dom, _: NodeId, content: &str, info: &NodeInfo) -> String {
    if info.is_block {
        format!("\n\n{content}\n\n")
    } else {
        content.to_string()
    }
}

fn paragraph(_: &mut Dom, _: NodeId, content: &str, _: &NodeInfo) -> String {
    format!("\n\n{content}\n\n")
}

fn line_break(_: &mut Dom, _: NodeId, _: &str, _: &NodeInfo) -> String {
    "  \n".to_string()
}

fn heading(dom: &mut Dom, node: NodeId, content: &str, _: &NodeInfo) -> String {
    let level = dom
        .node_name(node)
        .chars()
        .nth(1)
        .and_then(|c| c.to_digit(10))
        .unwrap_or(0);
    format!("\n\n{} {content}\n\n", "#".repeat(level as usize))
}

/// `content.replace(/^/gm, '> ')`: `^` also matches after every `\r`, `\u2028` and `\u2029`, and
/// at the very end when the text ends with a line terminator.
fn quote_lines(content: &str) -> String {
    let mut out = String::from("> ");
    for c in content.chars() {
        out.push(c);
        if matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
            out.push_str("> ");
        }
    }
    out
}

fn blockquote(_: &mut Dom, _: NodeId, content: &str, _: &NodeInfo) -> String {
    format!("\n\n{}\n\n", quote_lines(content.trim_matches('\n')))
}

fn horizontal_rule(_: &mut Dom, _: NodeId, _: &str, _: &NodeInfo) -> String {
    "\n\n---\n\n".to_string()
}

fn emphasis(_: &mut Dom, _: NodeId, content: &str, _: &NodeInfo) -> String {
    if content.trim_matches(is_js_whitespace).is_empty() {
        return String::new();
    }
    format!("*{content}*")
}

fn strong(_: &mut Dom, _: NodeId, content: &str, _: &NodeInfo) -> String {
    if content.trim_matches(is_js_whitespace).is_empty() {
        return String::new();
    }
    format!("**{content}**")
}

fn is_code_span(dom: &Dom, node: NodeId) -> bool {
    let has_siblings =
        dom.doc.previous_sibling(node).is_some() || dom.doc.next_sibling(node).is_some();
    let in_pre = dom
        .doc
        .parent_node(node)
        .is_some_and(|p| dom.is_name(p, "PRE"));
    dom.is_name(node, "CODE") && !(in_pre && !has_siblings)
}

/// `/^`|^ .*?[^ ].* $|`$/`: the content needs a padding space.
fn needs_padding(content: &str) -> bool {
    if content.starts_with('`') || content.ends_with('`') {
        return true;
    }
    let Some(middle) = content
        .strip_prefix(' ')
        .and_then(|rest| rest.strip_suffix(' '))
    else {
        return false;
    };
    // `.*?[^ ].*` over the middle: at most one line terminator, and then it is the `[^ ]`.
    let is_terminator = |c: char| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
    let terminators = middle.chars().filter(|&c| is_terminator(c)).count();
    match terminators {
        0 => middle.chars().any(|c| c != ' '),
        1 => true,
        _ => false,
    }
}

static LINE_BREAKS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\r?\n|\r").expect("static pattern"));

fn code(_: &mut Dom, _: NodeId, content: &str, _: &NodeInfo) -> String {
    if content.is_empty() {
        return String::new();
    }
    let content = LINE_BREAKS.replace_all(content, " ");
    let padding = if needs_padding(&content) { " " } else { "" };
    let runs: Vec<&str> = content
        .split(|c| c != '`')
        .filter(|run| !run.is_empty())
        .collect();
    let mut delimiter = "`".to_string();
    while runs.contains(&delimiter.as_str()) {
        delimiter.push('`');
    }
    format!("{delimiter}{padding}{content}{padding}{delimiter}")
}

pub static RULES: &[Rule] = &[
    Rule {
        filter: Filter::Tags(&["p"]),
        replacement: paragraph,
    },
    Rule {
        filter: Filter::Tags(&["br"]),
        replacement: line_break,
    },
    Rule {
        filter: Filter::Tags(&["h1", "h2", "h3", "h4", "h5", "h6"]),
        replacement: heading,
    },
    Rule {
        filter: Filter::Tags(&["blockquote"]),
        replacement: blockquote,
    },
    Rule {
        filter: Filter::Tags(&["hr"]),
        replacement: horizontal_rule,
    },
    Rule {
        filter: Filter::Tags(&["em", "i"]),
        replacement: emphasis,
    },
    Rule {
        filter: Filter::Tags(&["strong", "b"]),
        replacement: strong,
    },
    Rule {
        filter: Filter::Predicate(is_code_span),
        replacement: code,
    },
];
