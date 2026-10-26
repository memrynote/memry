//! The `preformattedCode` rule: a `<pre>` holding a `<code>` becomes a fenced block.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::NodeId;
use crate::web::extract::markdown::turndown::NodeInfo;
use crate::web::extract::markdown::turndown::parse::Dom;
use crate::web::extract::utils::js::trim;

static LANGUAGE_CLASS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"language-([A-Za-z0-9_]+)").expect("static pattern"));

pub fn is_pre(dom: &Dom, node: NodeId) -> bool {
    dom.is_name(node, "PRE")
}

pub fn preformatted_code(dom: &mut Dom, node: NodeId, content: &str, _: &NodeInfo) -> String {
    let Some(code) = dom.query_name(node, &["code"]) else {
        return content.to_string();
    };
    let non_empty = |name: &str, id: NodeId| {
        dom.attr(id, name)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    let language = non_empty("data-lang", code)
        .or_else(|| non_empty("data-language", code))
        .or_else(|| {
            dom.attr(code, "class")
                .and_then(|class| LANGUAGE_CLASS.captures(class))
                .map(|caps| caps[1].to_string())
        })
        .or_else(|| non_empty("data-language", node))
        .unwrap_or_default();
    let clean = trim(&dom.text(code)).replace('`', "\\`");
    format!("\n```{language}\n{clean}\n```\n")
}
