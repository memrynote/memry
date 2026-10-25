//! The `list`, `listItem` and `arXivEnumerate` rules.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::NodeId;
use crate::web::extract::markdown::turndown::NodeInfo;
use crate::web::extract::markdown::turndown::parse::Dom;
use crate::web::extract::utils::js::{to_number, trim};
use crate::web::extract::utils::json::number_to_string;

static INPUT_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<input[^>]*>").expect("static pattern"));
static ARXIV_TAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"^<span class="ltx_tag ltx_tag_item">[0-9]+\.</span>{}*"#,
        crate::web::extract::utils::js::WS
    ))
    .expect("static pattern")
});

pub fn list(dom: &mut Dom, node: NodeId, content: &str, _: &NodeInfo) -> String {
    let top_level = !dom
        .doc
        .parent_node(node)
        .is_some_and(|p| dom.is_name(p, "UL") || dom.is_name(p, "OL"));
    format!("{}{}\n", if top_level { "\n" } else { "" }, trim(content))
}

/// `node.querySelector('input[type="checkbox"]')`: `input.type` is the lower-cased keyword.
fn checkbox(dom: &Dom, node: NodeId) -> Option<NodeId> {
    dom.query_names(node, &["input"])
        .into_iter()
        .find(|&input| {
            dom.attr(input, "type")
                .is_some_and(|t| t.eq_ignore_ascii_case("checkbox"))
        })
}

pub fn list_item(dom: &mut Dom, node: NodeId, content: &str, _: &NodeInfo) -> String {
    let mut content = content.to_string();
    let mut task_marker = "";
    if dom.class_contains(node, "task-list-item")
        && let Some(checkbox) = checkbox(dom, node)
    {
        // The markdown checkbox replaces the input in the content.
        content = INPUT_TAG.replace(&content, "").into_owned();
        task_marker = if dom.attr(checkbox, "checked").is_some_and(|c| !c.is_empty()) {
            "[x] "
        } else {
            "[ ] "
        };
    }
    let lines: Vec<&str> = content
        .trim_end_matches('\n')
        .split('\n')
        .filter(|line| !line.is_empty())
        .collect();
    let joined = lines.join("\n\t");

    // The nesting level counts the list ancestors up to the first other element.
    let parent = dom.doc.parent_node(node);
    let mut level = 0usize;
    let mut current = parent;
    while let Some(c) = current {
        if !dom.is_element(c) {
            break;
        }
        if dom.is_name(c, "UL") || dom.is_name(c, "OL") {
            level += 1;
        } else if !dom.is_name(c, "LI") {
            break;
        }
        current = dom.doc.parent_node(c);
    }
    let mut prefix = format!("{}- ", "\t".repeat(level.saturating_sub(1)));
    if let Some(p) = parent.filter(|&p| dom.is_element(p) && dom.is_name(p, "OL")) {
        let start = dom.attr(p, "start").filter(|s| !s.is_empty());
        let index = dom
            .children(p)
            .iter()
            .position(|&c| c == node)
            .map_or(1, |i| i + 1);
        let number = match start {
            Some(start) => number_to_string(to_number(start) + index as f64 - 1.0),
            None => index.to_string(),
        };
        prefix = format!("{}{number}. ", "\t".repeat(level.saturating_sub(1)));
    }
    // `content` here is the joined text, which never ends with a newline.
    let newline = if dom.doc.next_sibling(node).is_some() && !joined.ends_with('\n') {
        "\n"
    } else {
        ""
    };
    format!("{prefix}{task_marker}{}{newline}", trim(&joined))
}

pub fn is_arxiv_enumerate(dom: &Dom, node: NodeId) -> bool {
    dom.is_name(node, "OL") && dom.class_contains(node, "ltx_enumerate")
}

pub fn arxiv_enumerate(dom: &mut Dom, node: NodeId, _: &str, _: &NodeInfo) -> String {
    let items: Vec<String> = dom
        .children(node)
        .into_iter()
        .enumerate()
        .map(|(index, item)| {
            let html = dom.inner_html(item);
            let html = ARXIV_TAG.replace(&html, "");
            format!("{}. {}", index + 1, dom.turndown(&html))
        })
        .collect();
    format!("\n\n{}\n\n", items.join("\n\n"))
}
