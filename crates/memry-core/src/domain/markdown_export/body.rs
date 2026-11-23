//! Body blocks to markdown, in the on-disk forms of chapter 12 §12.6, from the
//! block walk the note screen draws (`crate::crdt::blocks`).
//!
//! Readable and openable by desktop, not desktop's bytes: desktop's
//! serialiser is the only one held to those (§12.1.4). A block type this
//! build does not know is written as its text, so nothing is dropped.

use serde_json::{Map, Value};

use super::inline;
use crate::crdt::blocks::{Block, TableCell, TableContent};

/// A block and the blocks nested under it.
struct Node<'a> {
    block: &'a Block,
    children: Vec<Node<'a>>,
}

/// The body as markdown. `table` answers a table block's rows by its id.
pub(super) fn render(blocks: &[Block], table: &dyn Fn(&str) -> Option<TableContent>) -> String {
    let mut at = 0;
    Writer { table }.sequence(&tree(blocks, &mut at, 0))
}

/// Rebuilds nesting from the walk's depths. A block deeper than the one
/// before it is that block's child, whatever the gap.
fn tree<'a>(blocks: &'a [Block], at: &mut usize, depth: u32) -> Vec<Node<'a>> {
    let mut nodes = Vec::new();
    while let Some(block) = blocks.get(*at) {
        if block.depth < depth {
            break;
        }
        *at += 1;
        let children = tree(blocks, at, block.depth + 1);
        nodes.push(Node { block, children });
    }
    nodes
}

struct Writer<'t> {
    table: &'t dyn Fn(&str) -> Option<TableContent>,
}

impl Writer<'_> {
    /// Sibling blocks, a blank line apart; list items of one list a line apart.
    fn sequence(&self, nodes: &[Node<'_>]) -> String {
        let mut out = String::new();
        let mut previous: Option<&str> = None;
        let mut number = 0;
        for node in nodes {
            let kind = node.block.kind.as_str();
            number = match (kind, previous) {
                ("numberedListItem", Some("numberedListItem")) => number + 1,
                ("numberedListItem", _) => prop(node.block, "start")
                    .and_then(|start| start.parse().ok())
                    .unwrap_or(1),
                _ => 0,
            };
            let Some(chunk) = self.node(node, number) else {
                continue;
            };
            if !out.is_empty() {
                let tight = is_list(kind) && previous.is_some_and(is_list);
                out.push_str(if tight { "\n" } else { "\n\n" });
            }
            out.push_str(&chunk);
            previous = Some(kind);
        }
        out
    }

    fn node(&self, node: &Node<'_>, number: u64) -> Option<String> {
        let block = node.block;
        let text = || inline::render(&block.inline, false);
        let attr = |name| prop(block, name).unwrap_or_default();
        match block.kind.as_str() {
            "heading" => {
                let level = attr("level").parse::<usize>().unwrap_or(1).clamp(1, 6);
                self.with_children(format!("{} {}", "#".repeat(level), text()), node)
            }
            "bulletListItem" => Some(self.item(format!("- {}", text()), 2, node)),
            "numberedListItem" => {
                let marker = format!("{number}. ");
                Some(self.item(format!("{marker}{}", text()), marker.len(), node))
            }
            "checkListItem" => {
                let mark = if attr("checked") == "true" { "x" } else { " " };
                let plain = if attr("plain") == "true" { " {check}" } else { "" };
                Some(self.item(format!("- [{mark}] {}{plain}", text()), 2, node))
            }
            // `serializeTaskBlock`, `packages/shared/src/task-block.ts:54`.
            "taskBlock" => {
                let mark = if attr("checked") == "true" { "x" } else { " " };
                let id = attr("taskId");
                let task = if id.is_empty() {
                    String::new()
                } else {
                    format!(" {{task:{id}}}")
                };
                let line = format!("- [{mark}] {}{task}", attr("title").replace('\n', " "));
                Some(self.item(line, 2, node))
            }
            "quote" => {
                let inner = join(&text(), &self.sequence(&node.children));
                Some(quoted(&inner))
            }
            "callout" => {
                let kind: String = attr("type")
                    .to_lowercase()
                    .chars()
                    .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
                    .collect();
                let fold = match attr("fold") {
                    "closed" => "-",
                    "open" => "+",
                    _ => "",
                };
                let kind = if kind.is_empty() { "info" } else { &kind };
                let inner = join(&text(), &self.sequence(&node.children));
                let marker = format!("> [!{kind}]{fold}");
                Some(if inner.is_empty() {
                    marker
                } else {
                    format!("{marker}\n{}", quoted(&inner))
                })
            }
            "codeBlock" => Some(fence(attr("language"), &inline::literal(&block.inline))),
            "diagram" => Some(fence("mermaid", &inline::literal(&block.inline))),
            "divider" => Some("---".to_owned()),
            "mathBlock" => Some(math(attr("latex"))),
            "image" => {
                let alt = [attr("caption"), attr("name")]
                    .into_iter()
                    .find(|alt| !alt.is_empty())
                    .unwrap_or_default();
                media("!", alt, attr("url"))
            }
            "video" | "audio" => media("", attr("name"), attr("url")),
            "file" => Some(file_marker(block)),
            "bookmark" => media("!", "bookmark", attr("url")),
            "youtubeEmbed" => {
                let alt = Some(attr("alt"))
                    .filter(|alt| !alt.is_empty())
                    .unwrap_or("embed");
                media("!", alt, attr("videoUrl"))
            }
            // An empty `canvasId` writes nothing (§12.6).
            "whiteboard" => {
                let id = attr("canvasId");
                (!id.is_empty()).then(|| format!("![whiteboard](memry://canvas/{id})"))
            }
            "toggleListItem" => {
                let open = if attr("open") == "true" { " open" } else { "" };
                let summary = text().replace("\\\n", " ");
                let body = self.sequence(&node.children);
                let mut lines = format!("<details data-memry-toggle{open}>\n<summary>{summary}</summary>");
                if !body.is_empty() {
                    lines.push_str(&format!("\n\n{body}\n"));
                }
                lines.push_str("\n</details>");
                Some(lines)
            }
            "table" => self.table(node),
            "columnList" => self.columns(node),
            _ => self.with_children(text(), node),
        }
    }

    /// A list item: its line, then its children indented to its content.
    fn item(&self, line: String, indent: usize, node: &Node<'_>) -> String {
        let mut out = indented(&line, indent, false);
        let children = self.sequence(&node.children);
        if !children.is_empty() {
            let tight = node
                .children
                .first()
                .is_some_and(|child| is_list(&child.block.kind));
            out.push_str(if tight { "\n" } else { "\n\n" });
            out.push_str(&indented(&children, indent, true));
        }
        out
    }

    /// A block with no nesting form of its own; its children follow it.
    fn with_children(&self, own: String, node: &Node<'_>) -> Option<String> {
        let all = join(&own, &self.sequence(&node.children));
        (!all.is_empty()).then_some(all)
    }

    /// A GFM table. The first row is the header row, which GFM requires.
    fn table(&self, node: &Node<'_>) -> Option<String> {
        let Some(content) = node.block.id.as_deref().and_then(|id| (self.table)(id)) else {
            return self.with_children(String::new(), node);
        };
        let rows: Vec<Vec<String>> = content
            .rows
            .iter()
            .map(|row| row.cells.iter().map(cell).collect())
            .collect();
        let width = rows.iter().map(Vec::len).max().unwrap_or(0);
        if width == 0 {
            return None;
        }
        let line = |cells: &[String]| {
            let padded: Vec<&str> = (0..width)
                .map(|at| cells.get(at).map_or("", String::as_str))
                .collect();
            format!("| {} |", padded.join(" | "))
        };
        let mut lines = vec![line(&rows[0]), line(&vec!["---".to_owned(); width])];
        lines.extend(rows[1..].iter().map(|row| line(row.as_slice())));
        Some(lines.join("\n"))
    }

    /// A Multi-Column Markdown region (§12.9).
    fn columns(&self, node: &Node<'_>) -> Option<String> {
        let columns: Vec<String> = node
            .children
            .iter()
            .filter(|child| child.block.kind == "column")
            .map(|column| self.sequence(&column.children))
            .collect();
        if columns.len() < 2 {
            return self.with_children(String::new(), node);
        }
        let region = prop(node.block, "regionId")
            .or(node.block.id.as_deref())
            .filter(|id| !id.is_empty() && !id.contains(char::is_whitespace))
            .unwrap_or("columns");
        Some(format!(
            "--- start-multi-column: {region}\n```column-settings\nNumber of Columns: {}\n```\n\n{}\n\n--- end-multi-column",
            columns.len(),
            columns.join("\n\n--- end-column ---\n\n")
        ))
    }
}

fn prop<'a>(block: &'a Block, name: &str) -> Option<&'a str> {
    block
        .props
        .iter()
        .find(|prop| prop.name == name)
        .map(|prop| prop.value.as_str())
}

fn is_list(kind: &str) -> bool {
    matches!(
        kind,
        "bulletListItem" | "numberedListItem" | "checkListItem" | "taskBlock"
    )
}

fn join(first: &str, second: &str) -> String {
    match (first.is_empty(), second.is_empty()) {
        (true, _) => second.to_owned(),
        (_, true) => first.to_owned(),
        _ => format!("{first}\n\n{second}"),
    }
}

/// `text` with every line after the first (or every line) moved right.
fn indented(text: &str, by: usize, first: bool) -> String {
    let pad = " ".repeat(by);
    text.split('\n')
        .enumerate()
        .map(|(at, line)| {
            if line.is_empty() || (at == 0 && !first) {
                line.to_owned()
            } else {
                format!("{pad}{line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn quoted(text: &str) -> String {
    text.split('\n')
        .map(|line| {
            if line.is_empty() {
                ">".to_owned()
            } else {
                format!("> {line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A fence longer than any backtick run in the code.
fn fence(language: &str, code: &str) -> String {
    let longest = code
        .split(|c| c != '`')
        .map(str::len)
        .max()
        .unwrap_or(0);
    let fence = "`".repeat(longest.max(2) + 1);
    let language: String = language
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '`')
        .collect();
    if code.is_empty() {
        format!("{fence}{language}\n{fence}")
    } else {
        format!("{fence}{language}\n{code}\n{fence}")
    }
}

/// `serializeMathBlock`: the source between `$$` lines, blank lines dropped.
fn math(latex: &str) -> String {
    let body: Vec<&str> = latex
        .split('\n')
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .collect();
    if body.is_empty() {
        "$$\n$$".to_owned()
    } else {
        format!("$$\n{}\n$$", body.join("\n"))
    }
}

/// `![alt](url)` or `[name](url)`; nothing for a block with no address.
fn media(bang: &str, label: &str, url: &str) -> Option<String> {
    if url.is_empty() {
        return None;
    }
    let label = label.replace(['[', ']', '\n'], " ");
    let url = if url.contains(|c: char| c.is_whitespace() || c == '(' || c == ')') {
        format!("<{url}>")
    } else {
        url.to_owned()
    };
    Some(format!("{bang}[{label}]({url})"))
}

/// The file block's comment marker, keys in the fixed order of §12.6.
fn file_marker(block: &Block) -> String {
    let text = |name| prop(block, name).unwrap_or_default();
    let number = |name| -> Value {
        let raw = text(name);
        raw.parse::<i64>()
            .map(Value::from)
            .or_else(|_| raw.parse::<f64>().map(Value::from))
            .unwrap_or(Value::from(0))
    };
    let positive = |value: &Value| value.as_f64().is_some_and(|n| n > 0.0);
    let mut payload = Map::new();
    payload.insert("url".to_owned(), Value::from(text("url")));
    payload.insert("name".to_owned(), Value::from(text("name")));
    payload.insert("size".to_owned(), number("size"));
    payload.insert("mimeType".to_owned(), Value::from(text("mimeType")));
    for name in ["width", "height"] {
        let value = number(name);
        if positive(&value) {
            payload.insert(name.to_owned(), value);
        }
    }
    if !matches!(text("align"), "" | "left") {
        payload.insert("align".to_owned(), Value::from(text("align")));
    }
    if text("display") == "link" {
        payload.insert("display".to_owned(), Value::from("link"));
    }
    let json = Value::Object(payload)
        .to_string()
        .replace("-->", "--\\u003e")
        .replace("--!>", "--!\\u003e");
    format!("<!-- file:{json} -->")
}

/// One table cell on one line: its blocks joined, breaks as `<br>`.
fn cell(cell: &TableCell) -> String {
    cell.content
        .iter()
        .map(|block| inline::render(&block.inline, true))
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("<br>")
}
