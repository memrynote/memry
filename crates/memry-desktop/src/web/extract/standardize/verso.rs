//! `mergeAdjacentVersoCodeBlocks`: Verso (Lean docs) emits many adjacent command and output
//! blocks; runs of them in one language merge back into one block.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::node::node_type;
use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::{WS, to_lower, trim};

/// `/(?:^|\s)language-([a-z0-9_+-]+)(?:\s|$)/i`.
static LANGUAGE_CLASS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        "(?:^|{WS})(?i-u:language-)([a-zA-Z0-9_+-]+)(?:{WS}|$)"
    ))
    .expect("static pattern")
});

/// The one `<code>` child of `pre`, or `None` when `pre` holds anything else.
fn code_node(doc: &Document, pre: NodeId) -> Option<NodeId> {
    let mut code = None;
    for child in doc.children(pre) {
        if doc.local_name(child).map(str::to_lowercase).as_deref() != Some("code") || code.is_some()
        {
            return None;
        }
        code = Some(child);
    }
    code
}

fn language(doc: &Document, code: NodeId) -> String {
    let data_lang = to_lower(&doc.get_attribute(code, "data-lang").unwrap_or_default());
    if !data_lang.is_empty() {
        return data_lang;
    }
    let class_name = doc.get_attribute(code, "class").unwrap_or_default();
    LANGUAGE_CLASS
        .captures(&class_name)
        .map(|c| to_lower(&c[1]))
        .unwrap_or_default()
}

fn is_verso_pre(doc: &Document, node: NodeId) -> bool {
    doc.local_name(node).map(str::to_lowercase).as_deref() == Some("pre")
        && doc.get_attribute(node, "data-verso-code").as_deref() == Some("true")
}

/// `\r?\n$` removed from a block's text.
fn strip_final_newline(text: &str) -> &str {
    text.strip_suffix("\r\n")
        .or_else(|| text.strip_suffix('\n'))
        .unwrap_or(text)
}

/// `.replace(/\n{3,}/g, '\n\n')`.
fn collapse_blank_lines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut newlines = 0;
    for c in text.chars() {
        if c == '\n' {
            newlines += 1;
            if newlines <= 2 {
                out.push(c);
            }
        } else {
            newlines = 0;
            out.push(c);
        }
    }
    out
}

pub fn merge_adjacent_verso_code_blocks(
    doc: &mut Document,
    root: NodeId,
) -> Result<(), ExtractError> {
    // Only the parents of Verso code blocks are visited.
    let mut parents: Vec<NodeId> = Vec::new();
    for candidate in doc.query_selector_all(root, "pre[data-verso-code=\"true\"]")? {
        if let Some(parent) = doc.parent_element(candidate)
            && !parents.contains(&parent)
        {
            parents.push(parent);
        }
    }
    for container in parents {
        let children = doc.child_nodes(container);
        let mut i = 0;
        while i < children.len() {
            let start = children[i];
            let Some(start_code) = Some(start)
                .filter(|&n| doc.is_element(n) && is_verso_pre(doc, n))
                .and_then(|n| code_node(doc, n))
            else {
                i += 1;
                continue;
            };
            let lang = language(doc, start_code);
            if lang != "lean" && lang != "lean4" {
                i += 1;
                continue;
            }
            let mut run = vec![(start, start_code)];
            let mut between: Vec<NodeId> = Vec::new();
            let mut j = i + 1;
            while j < children.len() {
                let node = children[j];
                if doc.node_type(node) == node_type::TEXT
                    && trim(&doc.text_content(node).unwrap_or_default()).is_empty()
                {
                    between.push(node);
                    j += 1;
                    continue;
                }
                if !doc.is_element(node) || !is_verso_pre(doc, node) {
                    break;
                }
                let Some(code) = code_node(doc, node) else {
                    break;
                };
                if language(doc, code) != lang {
                    break;
                }
                run.push((node, code));
                j += 1;
            }
            if run.len() <= 1 {
                i += 1;
                continue;
            }
            let joined = run
                .iter()
                .map(|&(_, code)| {
                    strip_final_newline(&doc.text_content(code).unwrap_or_default()).to_string()
                })
                .collect::<Vec<_>>()
                .join("\n");
            let merged = collapse_blank_lines(&joined);
            doc.set_text_content(start_code, merged.trim_matches('\n'))?;
            for &(pre, _) in &run[1..] {
                doc.remove(pre);
            }
            for node in between {
                if let Some(parent) = doc.parent_node(node) {
                    doc.remove_child(parent, node)?;
                }
            }
            // Scanning continues after the merged run.
            i = j;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{collapse_blank_lines, strip_final_newline};

    #[test]
    fn text_helpers_match_the_js_regexes() {
        // `'a\r\n\n'.replace(/\r?\n$/, '')` is `'a\r\n'` in Node, and `'a\r\n'` gives `'a'`.
        assert_eq!(strip_final_newline("a\r\n\n"), "a\r\n");
        assert_eq!(strip_final_newline("a\r\n"), "a");
        assert_eq!(strip_final_newline("a"), "a");
        assert_eq!(collapse_blank_lines("a\n\n\n\nb\n\nc"), "a\n\nb\n\nc");
    }
}
