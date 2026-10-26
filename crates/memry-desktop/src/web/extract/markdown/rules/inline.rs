//! The `link`, `complexLinkStructure`, `strikethrough`, `highlight` and `button` rules.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::NodeId;
use crate::web::extract::markdown::turndown::NodeInfo;
use crate::web::extract::markdown::turndown::parse::Dom;
use crate::web::extract::utils::js::WS;

static WHITESPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(WS).expect("static pattern"));
/// `/(\n+\s*)+/g`: a newline and the whitespace after it, which is one run.
static NEWLINE_RUNS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"\n{WS}*")).expect("static pattern"));

/// `formatMarkdownLinkDestination(href)`.
fn format_link_destination(href: &str) -> String {
    if !WHITESPACE.is_match(href) {
        let mut out = String::with_capacity(href.len());
        for c in href.chars() {
            if c == '(' || c == ')' {
                out.push('\\');
            }
            out.push(c);
        }
        return out;
    }
    format!("<{}>", href.replace('>', "\\>"))
}

/// `formatMarkdownLinkTitle(title)`.
fn format_link_title(title: Option<&str>) -> String {
    match title {
        Some(title) if !title.is_empty() => {
            let collapsed = NEWLINE_RUNS.replace_all(title, "\n");
            format!(" \"{}\"", collapsed.replace('"', "\\\""))
        }
        _ => String::new(),
    }
}

pub fn link(dom: &mut Dom, node: NodeId, content: &str, _: &NodeInfo) -> String {
    let Some(href) = dom.attr(node, "href").filter(|h| !h.is_empty()) else {
        return content.to_string();
    };
    let title = format_link_title(dom.attr(node, "title"));
    format!("[{content}]({}{title})", format_link_destination(href))
}

pub fn is_complex_link(dom: &Dom, node: NodeId) -> bool {
    dom.is_name(node, "A")
        && dom.doc.child_nodes(node).len() > 1
        && dom.doc.child_nodes(node).into_iter().any(|child| {
            matches!(
                dom.node_name(child).as_str(),
                "H1" | "H2" | "H3" | "H4" | "H5" | "H6"
            )
        })
}

pub fn complex_link(dom: &mut Dom, node: NodeId, _: &str, _: &NodeInfo) -> String {
    let href = dom.attr(node, "href").map(str::to_string);
    let title = dom.attr(node, "title").map(str::to_string);
    let heading = dom.query_name(node, &["h1", "h2", "h3", "h4", "h5", "h6"]);
    // The heading keeps its tag, so turndown renders it as a heading.
    let heading_content = heading.map_or(String::new(), |h| dom.turndown(&dom.outer_html(h)));
    if let Some(h) = heading {
        dom.doc.remove(h);
    }
    let remaining = dom.turndown(&dom.inner_html(node));
    let mut markdown = format!("{heading_content}\n\n{remaining}\n\n");
    if let Some(href) = href {
        markdown.push_str(&format!(
            "[View original]({}{})",
            format_link_destination(&href),
            format_link_title(title.as_deref())
        ));
    }
    markdown
}

pub fn is_strikethrough(dom: &Dom, node: NodeId) -> bool {
    matches!(dom.node_name(node).as_str(), "DEL" | "S" | "STRIKE")
}

pub fn strikethrough(_: &mut Dom, _: NodeId, content: &str, _: &NodeInfo) -> String {
    format!("~~{content}~~")
}

pub fn highlight(_: &mut Dom, _: NodeId, content: &str, _: &NodeInfo) -> String {
    format!("=={content}==")
}

pub fn button(_: &mut Dom, _: NodeId, content: &str, _: &NodeInfo) -> String {
    content.to_string()
}
