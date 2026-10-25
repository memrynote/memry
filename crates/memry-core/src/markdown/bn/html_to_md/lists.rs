//! Lists and list items of `htmlToMarkdown.ts`.

use super::inline::serialize_inline_content;
use super::{Ctx, element_children, query_tag, serialize_node, tag};
use crate::markdown::bn::dom::{Dom, NodeId};
use crate::markdown::frontmatter::js::parse_int;

#[derive(Clone, Copy)]
enum Kind {
    Bullet,
    Ordered(i64),
}

pub(super) fn unordered(dom: &Dom, el: NodeId, ctx: &Ctx) -> String {
    let mut result = String::new();
    for item in element_children(dom, el) {
        if tag(dom, item) == "li" {
            result.push_str(&list_item(dom, item, Kind::Bullet, ctx));
        }
    }
    if !ctx.in_list_item {
        result.push('\n');
    }
    result
}

pub(super) fn ordered(dom: &Dom, el: NodeId, ctx: &Ctx) -> String {
    let mut result = String::new();
    let start = dom
        .attr(el, "start")
        .filter(|v| !v.is_empty())
        .map_or(1.0, |v| parse_int(v, 10));
    // `parseInt` of a bad `start` is NaN, which prints as `NaN.`; the exporter
    // only writes numbers, so a failed parse falls back to the default of 1.
    let start = if start.is_finite() { start as i64 } else { 1 };
    let items: Vec<NodeId> = element_children(dom, el)
        .into_iter()
        .filter(|i| tag(dom, *i) == "li")
        .collect();
    for (i, item) in items.into_iter().enumerate() {
        result.push_str(&list_item(dom, item, Kind::Ordered(start + i as i64), ctx));
    }
    if !ctx.in_list_item {
        result.push('\n');
    }
    result
}

fn is_checkbox(dom: &Dom, el: NodeId) -> bool {
    tag(dom, el) == "input"
        && dom
            .attr(el, "type")
            .is_some_and(|t| t.eq_ignore_ascii_case("checkbox"))
}

fn first_content_element(dom: &Dom, li: NodeId, checkbox: Option<NodeId>) -> Option<NodeId> {
    element_children(dom, li).into_iter().find(|child| {
        Some(*child) != checkbox
            && tag(dom, *child) != "input"
            && matches!(tag(dom, *child).as_str(), "p" | "span")
    })
}

fn list_item(dom: &Dom, el: NodeId, kind: Kind, ctx: &Ctx) -> String {
    let mut checkbox = None;
    let mut details = None;
    for child in element_children(dom, el) {
        if is_checkbox(dom, child) {
            checkbox = Some(child);
        }
        if tag(dom, child) == "details" {
            details = Some(child);
        }
    }
    let (marker, marker_width) = match (checkbox, kind) {
        (Some(cb), _) => {
            let state = if dom.has_attr(cb, "checked") {
                "[x]"
            } else {
                "[ ]"
            };
            (format!("* {state} "), 2)
        }
        (None, Kind::Ordered(n)) => {
            let m = format!("{n}. ");
            let w = m.len();
            (m, w)
        }
        (None, Kind::Bullet) => ("* ".to_owned(), 2),
    };

    let (inline_content, first_content) = if let Some(d) = details {
        let summary_p = query_tag(dom, d, "summary").and_then(|s| query_tag(dom, s, "p"));
        (
            summary_p
                .map(|p| serialize_inline_content(dom, p))
                .unwrap_or_default(),
            Some(d),
        )
    } else {
        let first = first_content_element(dom, el, checkbox);
        (
            first
                .map(|f| serialize_inline_content(dom, f))
                .unwrap_or_default(),
            first,
        )
    };

    let mut result = format!("{}{}{}\n", ctx.indent, marker, inline_content);
    let child_indent = format!("{}{}", ctx.indent, " ".repeat(marker_width));
    let child_ctx = Ctx {
        indent: child_indent.clone(),
        in_list_item: true,
    };

    if let Some(d) = details {
        let summary = query_tag(dom, d, "summary");
        for child in element_children(dom, d) {
            if Some(child) == summary {
                continue;
            }
            if tag(dom, child) == "p" {
                result.push_str(&format!(
                    "\n{child_indent}{}\n",
                    serialize_inline_content(dom, child)
                ));
            } else {
                result.push_str(&serialize_node(dom, child, &child_ctx));
            }
        }
    }

    for child in element_children(dom, el) {
        if Some(child) == first_content || Some(child) == checkbox || tag(dom, child) == "input" {
            continue;
        }
        match tag(dom, child).as_str() {
            "ul" | "ol" => result.push_str(&serialize_node(dom, child, &child_ctx)),
            "p" => result.push_str(&format!(
                "\n{child_indent}{}\n",
                serialize_inline_content(dom, child)
            )),
            _ => {
                result.push('\n');
                result.push_str(&serialize_node(dom, child, &child_ctx));
            }
        }
    }
    result
}
