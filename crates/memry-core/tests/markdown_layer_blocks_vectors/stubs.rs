//! The deterministic parse/serialize pair the oracle hands to the callout,
//! quote and column functions: `apps/desktop/scripts/markdown-oracle/fns/
//! blocks-stubs.ts`, line for line. See that file for the `mini` grammar.

use serde_json::{Value, json};

pub enum Stub {
    Mini,
    Table {
        parse: serde_json::Map<String, Value>,
        serialize: Vec<(Value, String)>,
    },
    ParseError,
    SerializeError,
}

impl Stub {
    pub fn from_spec(spec: &Value) -> Stub {
        match spec["kind"].as_str().expect("stub kind") {
            "mini" => Stub::Mini,
            "table" => Stub::Table {
                parse: spec["parse"].as_object().expect("parse").clone(),
                serialize: spec["serialize"]
                    .as_array()
                    .expect("serialize")
                    .iter()
                    .map(|pair| {
                        (
                            pair[0].clone(),
                            pair[1].as_str().expect("markdown").to_owned(),
                        )
                    })
                    .collect(),
            },
            "parse-error" => Stub::ParseError,
            "serialize-error" => Stub::SerializeError,
            other => panic!("unknown stub {other}"),
        }
    }

    pub fn parse(&self, markdown: &str) -> Result<Vec<Value>, String> {
        match self {
            Stub::Mini | Stub::SerializeError => Ok(mini_parse(markdown)),
            Stub::Table { parse, .. } => match parse.get(markdown) {
                Some(Value::Array(blocks)) => Ok(blocks.clone()),
                _ => Err(format!("table stub: no parse entry for {markdown:?}")),
            },
            Stub::ParseError => Err("parse-error stub".to_owned()),
        }
    }

    pub fn serialize(&self, blocks: &[Value]) -> Result<String, String> {
        match self {
            Stub::Mini | Stub::ParseError => Ok(mini_serialize(blocks)),
            Stub::Table { serialize, .. } => {
                let key = serde_json::to_string(blocks).expect("blocks");
                let hit = serialize.iter().find(|(candidate, _)| {
                    serde_json::to_string(candidate).is_ok_and(|text| text == key)
                });
                Ok(hit.map_or_else(|| mini_serialize(blocks), |(_, markdown)| markdown.clone()))
            }
            Stub::SerializeError => Err("serialize-error stub".to_owned()),
        }
    }
}

fn inline(text: &str) -> Value {
    if text.is_empty() {
        json!([])
    } else {
        json!([{"type": "text", "text": text, "styles": {}}])
    }
}

fn block(kind: &str, props: Value, text: &str) -> Value {
    json!({"type": kind, "props": props, "content": inline(text), "children": []})
}

struct ListLine<'a> {
    depth: usize,
    ordered: bool,
    text: &'a str,
}

fn list_line(line: &str) -> Option<ListLine<'_>> {
    let spaces = line.bytes().take_while(|b| *b == b' ').count();
    let rest = &line[spaces..];
    let bytes = rest.as_bytes();
    if let [b'-' | b'*' | b'+', b' ', ..] = bytes {
        return Some(ListLine {
            depth: spaces / 2,
            ordered: false,
            text: &rest[2..],
        });
    }
    let digits = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
    if digits > 0 && bytes.get(digits) == Some(&b'.') && bytes.get(digits + 1) == Some(&b' ') {
        return Some(ListLine {
            depth: spaces / 2,
            ordered: true,
            text: &rest[digits + 2..],
        });
    }
    None
}

struct Node {
    block: Value,
    children: Vec<usize>,
}

fn assemble(nodes: &mut [Node], index: usize) -> Value {
    let children: Vec<usize> = std::mem::take(&mut nodes[index].children);
    let built: Vec<Value> = children.into_iter().map(|c| assemble(nodes, c)).collect();
    let mut value = nodes[index].block.take();
    value["children"] = Value::Array(built);
    value
}

fn parse_chunk(chunk: &str) -> Vec<Value> {
    let lines: Vec<&str> = chunk.split('\n').collect();
    let items: Vec<Option<ListLine>> = lines.iter().map(|line| list_line(line)).collect();
    if items.iter().all(Option::is_some) {
        let mut nodes: Vec<Node> = Vec::new();
        let mut roots: Vec<usize> = Vec::new();
        let mut stack: Vec<(usize, usize)> = Vec::new();
        for item in items.into_iter().flatten() {
            let value = if item.ordered {
                block("numberedListItem", json!({}), item.text)
            } else if item.text.starts_with("[ ] ") || item.text.starts_with("[x] ") {
                let checked = item.text.as_bytes()[1] == b'x';
                block(
                    "checkListItem",
                    json!({"checked": checked}),
                    &item.text[4..],
                )
            } else {
                block("bulletListItem", json!({}), item.text)
            };
            let index = nodes.len();
            nodes.push(Node {
                block: value,
                children: Vec::new(),
            });
            while stack.last().is_some_and(|(depth, _)| *depth >= item.depth) {
                stack.pop();
            }
            match stack.last() {
                Some((_, parent)) => nodes[*parent].children.push(index),
                None => roots.push(index),
            }
            stack.push((item.depth, index));
        }
        return roots
            .into_iter()
            .map(|root| assemble(&mut nodes, root))
            .collect();
    }
    if let Some(text) = chunk.strip_prefix("# ") {
        return vec![block("heading", json!({"level": 1}), text)];
    }
    if chunk.starts_with("> ") {
        let text = lines
            .iter()
            .map(|line| line.strip_prefix("> ").unwrap_or(line))
            .collect::<Vec<_>>()
            .join("\n");
        return vec![block("quote", json!({}), &text)];
    }
    vec![block("paragraph", json!({}), chunk)]
}

pub fn mini_parse(markdown: &str) -> Vec<Value> {
    markdown
        .split("\n\n")
        .filter(|chunk| !js_trim(chunk).is_empty())
        .flat_map(parse_chunk)
        .collect()
}

fn inline_text(content: &Value) -> String {
    content.as_array().map_or_else(String::new, |items| {
        items
            .iter()
            .map(|item| item.get("text").and_then(Value::as_str).unwrap_or(""))
            .collect()
    })
}

fn child_blocks(block: &Value) -> &[Value] {
    block
        .get("children")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn serialize_block(block: &Value, depth: usize) -> String {
    let pad = "  ".repeat(depth);
    let text = inline_text(&block["content"]);
    let children = child_blocks(block);
    let kind = block.get("type").and_then(Value::as_str);
    if matches!(
        kind,
        Some("bulletListItem" | "numberedListItem" | "checkListItem")
    ) {
        let marker = match kind {
            Some("numberedListItem") => "1.".to_owned(),
            Some("checkListItem") => {
                let checked = block["props"]["checked"] == json!(true);
                format!("- [{}]", if checked { 'x' } else { ' ' })
            }
            _ => "-".to_owned(),
        };
        let mut parts = vec![format!("{pad}{marker} {text}")];
        parts.extend(children.iter().map(|c| serialize_block(c, depth + 1)));
        return parts.join("\n");
    }
    let own = match kind {
        Some("heading") => format!("# {text}"),
        Some("quote") => text
            .split('\n')
            .map(|line| format!("> {line}"))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => text,
    };
    let mut parts = vec![own];
    parts.extend(children.iter().map(|c| serialize_block(c, 0)));
    parts.join("\n\n")
}

pub fn mini_serialize(blocks: &[Value]) -> String {
    blocks
        .iter()
        .map(|b| serialize_block(b, 0))
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// `String#trim`: ECMAScript `WhiteSpace` and `LineTerminator`.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| {
        matches!(
            c,
            '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200A}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202F}'
                    | '\u{205F}'
                    | '\u{3000}'
                    | '\u{FEFF}'
        )
    })
}
