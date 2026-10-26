//! Serialize side of `inline-colors.ts`: wrap colored and underlined runs in
//! token runs, then swap the tokens for span tags once the markdown is written.

use serde_json::{Map, Value as Json, json};

use super::{
    CLOSE_TOKEN, cell_inline_content, is_safe_color_value, is_table_content, open_token,
    with_cell_content,
};
use crate::markdown::shared::block_colors::js_value::{is_record, prop};
use crate::markdown::shared::block_copy::clone_without;

/// Underline is its OWN nested span, never merged into the color span: an old
/// client rejects a whole span whose style holds a decl it does not know.
const UNDERLINE_SPAN_OPEN: &str = r#"<span style="text-decoration:underline">"#;

#[derive(Clone, PartialEq)]
struct Colors {
    text: Option<String>,
    background: Option<String>,
}

/// `pickColorStyles`: the non-default string colors, `None` when both are empty.
fn pick_color_styles(styles: &Json) -> Option<Colors> {
    let pick = |key: &str| {
        prop(styles, key)
            .and_then(Json::as_str)
            .filter(|value| *value != "default")
            .map(str::to_owned)
    };
    let colors = Colors {
        text: pick("textColor"),
        background: pick("backgroundColor"),
    };
    let set = |value: &Option<String>| value.as_deref().is_some_and(|v| !v.is_empty());
    (set(&colors.text) || set(&colors.background)).then_some(colors)
}

/// `hasColorOrUnderline`: a node whose props sit at their defaults is not colored.
fn has_color_or_underline(props: &Json) -> bool {
    let colored = |key: &str| {
        prop(props, key)
            .and_then(Json::as_str)
            .is_some_and(|value| value != "default")
    };
    colored("textColor")
        || colored("backgroundColor")
        || prop(props, "underline") == Some(&Json::Bool(true))
}

fn build_span_open(colors: &Colors) -> String {
    let mut decls: Vec<String> = Vec::new();
    if let Some(text) = colors.text.as_deref().filter(|v| !v.is_empty()) {
        decls.push(format!("color:{text}"));
    }
    if let Some(background) = colors.background.as_deref().filter(|v| !v.is_empty()) {
        decls.push(format!("background-color:{background}"));
    }
    format!("<span style=\"{}\">", decls.join(";"))
}

/// The token to span-tag map, in `Map` insertion order: `set` on a key already
/// present keeps its place.
#[derive(Default)]
struct Replacements {
    entries: Vec<(String, String)>,
}

impl Replacements {
    fn set(&mut self, token: String, html: &str) {
        match self.entries.iter_mut().find(|(key, _)| *key == token) {
            Some(entry) => entry.1 = html.to_owned(),
            None => self.entries.push((token, html.to_owned())),
        }
    }
}

struct Wrapper {
    index: usize,
    replacements: Replacements,
}

/// One `wrapInline` call: runs with identical styles share one span.
struct Group {
    out: Vec<Json>,
    open_colors: Option<Colors>,
    open_underline: bool,
}

impl Group {
    fn push_token(&mut self, text: &str) {
        self.out
            .push(json!({"type": "text", "text": text, "styles": {}}));
    }

    fn close_underline(&mut self) {
        if self.open_underline {
            self.push_token(CLOSE_TOKEN);
            self.open_underline = false;
        }
    }

    fn close_group(&mut self) {
        self.close_underline();
        if self.open_colors.take().is_some() {
            self.push_token(CLOSE_TOKEN);
        }
    }
}

impl Wrapper {
    fn open_span(&mut self, group: &mut Group, html: &str) {
        let open = open_token(self.index);
        self.index += 1;
        self.replacements.set(open.clone(), html);
        self.replacements.set(CLOSE_TOKEN.to_owned(), "</span>");
        group.push_token(&open);
    }

    fn wrap_inline(&mut self, items: &[Json]) -> Vec<Json> {
        let mut group = Group {
            out: Vec::new(),
            open_colors: None,
            open_underline: false,
        };
        for item in items {
            if let Some(nested) = prop(item, "content").and_then(Json::as_array) {
                group.close_group();
                let content = self.wrap_inline(nested);
                let mut next = item.clone();
                if let Some(map) = next.as_object_mut() {
                    map.insert("content".to_owned(), Json::Array(content));
                }
                group.out.push(next);
                continue;
            }
            self.wrap_item(&mut group, item);
        }
        group.close_group();
        group.out
    }

    fn wrap_item(&mut self, group: &mut Group, item: &Json) {
        // A custom inline node (`wikiLink`) carries its marks in `props`.
        let text = prop(item, "text").and_then(Json::as_str);
        let node_styles = match (text, prop(item, "props")) {
            (None, Some(props)) if has_color_or_underline(props) => Some(props),
            _ => None,
        };
        let run_styles = match (text, prop(item, "styles")) {
            (Some(text), Some(styles)) if !text.is_empty() && is_record(styles) => Some(styles),
            _ => None,
        };
        let styled = run_styles.or(node_styles);
        // An unsafe color value drops only the color span; underline is a literal.
        let colors = styled.and_then(pick_color_styles).filter(|picked| {
            [&picked.text, &picked.background].into_iter().all(|value| {
                value
                    .as_deref()
                    .is_none_or(|v| v.is_empty() || is_safe_color_value(v))
            })
        });
        let underline = styled.is_some_and(|s| prop(s, "underline") == Some(&Json::Bool(true)));

        if colors.is_none() && !underline {
            group.close_group();
            group.out.push(item.clone());
            return;
        }
        if group.open_colors != colors {
            group.close_group();
            if let Some(colors) = colors {
                self.open_span(group, &build_span_open(&colors));
                group.open_colors = Some(colors);
            }
        }
        if underline != group.open_underline {
            if underline {
                self.open_span(group, UNDERLINE_SPAN_OPEN);
                group.open_underline = true;
            } else {
                group.close_underline();
            }
        }
        match (node_styles, run_styles) {
            // The node passes through untouched: its colors are its props.
            (Some(_), _) | (None, None) => group.out.push(item.clone()),
            (None, Some(styles)) => {
                let rest: Map<String, Json> = styles
                    .as_object()
                    .into_iter()
                    .flatten()
                    .filter(|(key, _)| {
                        !matches!(key.as_str(), "textColor" | "backgroundColor" | "underline")
                    })
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect();
                let mut next = item.clone();
                if let Some(map) = next.as_object_mut() {
                    map.insert("styles".to_owned(), Json::Object(rest));
                }
                group.out.push(next);
            }
        }
    }

    fn wrap_table(&mut self, content: &Json) -> Option<Json> {
        let rows = prop(content, "rows")?.as_array()?;
        let mut next_rows = Vec::with_capacity(rows.len());
        for row in rows {
            let Some(cells) = prop(row, "cells").and_then(Json::as_array) else {
                next_rows.push(row.clone());
                continue;
            };
            let cells: Vec<Json> = cells
                .iter()
                .map(|cell| match cell_inline_content(cell) {
                    Some(inline) => with_cell_content(cell, self.wrap_inline(inline)),
                    None => cell.clone(),
                })
                .collect();
            let mut next = row.clone();
            if let Some(map) = next.as_object_mut() {
                map.insert("cells".to_owned(), Json::Array(cells));
            }
            next_rows.push(next);
        }
        let mut next = content.clone();
        if let Some(map) = next.as_object_mut() {
            map.insert("rows".to_owned(), Json::Array(next_rows));
        }
        Some(next)
    }

    fn wrap_blocks(&mut self, input: &[Json]) -> Vec<Json> {
        input
            .iter()
            .map(|block| {
                let mut next = clone_without(block, &["content", "children"]);
                // Code content is literal: span html in a fence could never be unmasked.
                let content = if prop(block, "type").and_then(Json::as_str) != Some("codeBlock") {
                    match prop(block, "content") {
                        Some(Json::Array(items)) => Some(Json::Array(self.wrap_inline(items))),
                        Some(table) if is_table_content(table) => self.wrap_table(table),
                        _ => None,
                    }
                } else {
                    None
                };
                let children = match prop(block, "children").and_then(Json::as_array) {
                    Some(children) if !children.is_empty() => {
                        Some(Json::Array(self.wrap_blocks(children)))
                    }
                    _ => None,
                };
                if let Some(map) = next.as_object_mut() {
                    for (key, wrapped) in [("content", content), ("children", children)] {
                        if let Some(original) = block.get(key) {
                            map.insert(key.to_owned(), wrapped.unwrap_or_else(|| original.clone()));
                        }
                    }
                }
                next
            })
            .collect()
    }
}

/// Wraps colored and underlined runs in token runs. Returns the blocks and the
/// token to span-tag replacements in insertion order.
pub fn extract_inline_color_runs(blocks: &[Json]) -> (Vec<Json>, Vec<(String, String)>) {
    let mut wrapper = Wrapper {
        index: 0,
        replacements: Replacements::default(),
    };
    let blocks = wrapper.wrap_blocks(blocks);
    (blocks, wrapper.replacements.entries)
}

/// Replaces each token in `markdown` with its span tag, in map order.
pub fn restore_inline_color_tokens(markdown: &str, replacements: &[(String, String)]) -> String {
    let mut out = markdown.to_owned();
    for (token, html) in replacements {
        out = if token.is_empty() {
            // `split('').join(html)` goes between characters only.
            out.chars().map(String::from).collect::<Vec<_>>().join(html)
        } else {
            out.replace(token.as_str(), html)
        };
    }
    out
}
