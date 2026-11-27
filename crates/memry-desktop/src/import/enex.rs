//! `.enex` parsing: `packages/importers/src/evernote/{parse-enex,dates}.ts`.
//!
//! Electron parsed with fast-xml-parser 5.9.0 and read the object it built. This scans the XML
//! once, front to back, and keeps only the elements that object was read for (`en-export`,
//! `note`, `resource`, `resource-attributes` and their fields), so nesting costs neither stack
//! nor memory. The quirks of that object are kept, since an export reads the same either way:
//! - an end tag closes the open element whatever its name, and the end of the file closes all;
//! - a field is a string only when it has no attributes, no CDATA and no child elements;
//!   otherwise it is an object, and a title then reads as `Untitled`;
//! - text is trimmed and decodes only `&lt; &gt; &quot; &apos;` (and their `&#..;` forms), then
//!   `&amp;`; other references stay as written.
//!
//! Entities a DOCTYPE declares are not expanded (fast-xml-parser expanded them): an export
//! declares none, and expansion is how a few bytes become gigabytes.

use std::cell::Cell;

use memry_core::markdown::frontmatter::js_trim;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnexResource {
    pub base64: String,
    pub mime: String,
    pub file_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnexNote {
    pub title: String,
    /// The ENML, `<en-note>` wrapper included.
    pub content_html: String,
    pub created: Option<String>,
    pub updated: Option<String>,
    pub tags: Vec<String>,
    pub resources: Vec<EnexResource>,
}

/// A parse that failed the whole file, as a throw inside `parseEnex` did.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct EnexError(String);

/// `en-export` > `note` > `resource` > `resource-attributes` > `file-name`.
const KEPT_DEPTH: usize = 5;

thread_local! {
    static BYTES_SCANNED: Cell<usize> = const { Cell::new(0) };
}

/// Bytes this thread's ENEX scans have stepped over: each byte once.
#[doc(hidden)]
pub fn bytes_scanned() -> usize {
    BYTES_SCANNED.with(Cell::get)
}

#[derive(Default)]
struct Element {
    name: String,
    has_attrs: bool,
    has_children: bool,
    text: String,
    cdata: Vec<String>,
    children: Vec<usize>,
}

enum Field {
    Missing,
    One(usize),
    Many,
}

struct Tree {
    nodes: Vec<Element>,
}

impl Tree {
    /// The field as a string, when fast-xml-parser made it one.
    fn string(&self, at: usize) -> Option<&str> {
        let e = &self.nodes[at];
        (!e.has_attrs && e.cdata.is_empty() && !e.has_children).then_some(e.text.as_str())
    }

    fn all(&self, at: usize, name: &str) -> Vec<usize> {
        self.nodes[at]
            .children
            .iter()
            .copied()
            .filter(|&c| self.nodes[c].name == name)
            .collect()
    }

    fn field(&self, at: usize, name: &str) -> Field {
        match self.all(at, name).as_slice() {
            [] => Field::Missing,
            [one] => Field::One(*one),
            _ => Field::Many,
        }
    }

    fn string_field(&self, at: usize, name: &str) -> Option<&str> {
        match self.field(at, name) {
            Field::One(field) => self.string(field),
            _ => None,
        }
    }
}

fn scanned(bytes: usize) {
    BYTES_SCANNED.with(|count| count.set(count.get() + bytes));
}

/// `processEntities` as fast-xml-parser applies it to text.
fn decode_entities(text: &str) -> String {
    const ENTITIES: [(&[&str], char); 5] = [
        (&["&apos;", "&#39;", "&#x27;"], '\''),
        (&["&gt;", "&#62;", "&#x3E;"], '>'),
        (&["&lt;", "&#60;", "&#x3C;"], '<'),
        (&["&quot;", "&#34;", "&#x22;"], '"'),
        (&["&amp;", "&#38;", "&#x26;"], '&'),
    ];
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let hit = ENTITIES.iter().find_map(|(forms, ch)| {
            forms
                .iter()
                .find(|f| rest.starts_with(**f))
                .map(|f| (f.len(), *ch))
        });
        match hit {
            Some((len, ch)) => {
                out.push(ch);
                rest = &rest[len..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Where the tag that opens at `from` ends (`>` outside a quoted value), or the end.
fn tag_end(xml: &str, from: usize) -> usize {
    let mut quote = None;
    for (at, b) in xml.as_bytes()[from..].iter().enumerate() {
        match (quote, b) {
            (None, b'"' | b'\'') => quote = Some(*b),
            (Some(q), _) if q == *b => quote = None,
            (None, b'>') => return from + at,
            _ => {}
        }
    }
    xml.len()
}

/// Where a declaration (`<!DOCTYPE ... [ ... ]>`) that opens at `from` ends.
fn declaration_end(xml: &str, from: usize) -> usize {
    let mut subset = false;
    for (at, b) in xml.as_bytes()[from..].iter().enumerate() {
        match b {
            b'[' => subset = true,
            b']' => subset = false,
            b'>' if !subset => return from + at,
            _ => {}
        }
    }
    xml.len()
}

fn find_from(xml: &str, from: usize, needle: &str) -> Option<usize> {
    xml[from..].find(needle).map(|at| from + at)
}

/// The kept elements of `xml`, index 0 being a virtual root.
fn scan(xml: &str) -> Tree {
    let mut tree = Tree {
        nodes: vec![Element::default()],
    };
    // Open elements: the kept index, or `None` past the kept depth.
    let mut open: Vec<Option<usize>> = Vec::new();
    let mut pos = 0;
    while pos < xml.len() {
        let lt = find_from(xml, pos, "<").unwrap_or(xml.len());
        scanned(lt - pos);
        if let Some(Some(current)) = open.last() {
            let text = js_trim(&xml[pos..lt]);
            if !text.is_empty() {
                let decoded = decode_entities(text);
                tree.nodes[*current].text.push_str(&decoded);
            }
        }
        if lt == xml.len() {
            break;
        }
        let rest = &xml[lt..];
        let (end, skip) = if rest.starts_with("<!--") {
            find_from(xml, lt, "-->").map_or((xml.len(), 0), |at| (at, 3))
        } else if rest.starts_with("<![CDATA[") {
            let close = find_from(xml, lt, "]]>").unwrap_or(xml.len());
            if let Some(Some(current)) = open.last() {
                tree.nodes[*current]
                    .cdata
                    .push(xml[lt + 9..close.max(lt + 9)].to_owned());
            }
            (close, 3)
        } else if rest.starts_with("<?") {
            find_from(xml, lt, "?>").map_or((xml.len(), 0), |at| (at, 2))
        } else if rest.starts_with("<!") {
            (declaration_end(xml, lt), 1)
        } else if rest.starts_with("</") {
            open.pop();
            (tag_end(xml, lt), 1)
        } else {
            let gt = tag_end(xml, lt);
            let inner = &xml[lt + 1..gt];
            let self_closing = inner.ends_with('/');
            let inner = inner.strip_suffix('/').unwrap_or(inner);
            let name_len = inner
                .find(|c: char| c.is_ascii_whitespace())
                .unwrap_or(inner.len());
            let parent = match open.last() {
                None => Some(0),
                Some(parent) => *parent,
            };
            let kept = match parent {
                Some(parent) => {
                    tree.nodes[parent].has_children = true;
                    (open.len() < KEPT_DEPTH).then(|| {
                        tree.nodes.push(Element {
                            name: inner[..name_len].to_owned(),
                            has_attrs: inner[name_len..].contains('='),
                            ..Element::default()
                        });
                        let at = tree.nodes.len() - 1;
                        tree.nodes[parent].children.push(at);
                        at
                    })
                }
                None => None,
            };
            if !self_closing {
                open.push(kept);
            }
            (gt, 1)
        };
        scanned(end.min(xml.len()) - lt);
        pos = (end + skip).min(xml.len());
    }
    tree
}

/// `parseEnexDate`: `YYYYMMDDTHHMMSSZ` as ISO 8601.
pub fn parse_enex_date(raw: &str) -> Option<String> {
    let s = js_trim(raw).as_bytes();
    let digits = |range: std::ops::Range<usize>| s[range].iter().all(u8::is_ascii_digit);
    if s.len() != 16 || !digits(0..8) || s[8] != b'T' || !digits(9..15) || s[15] != b'Z' {
        return None;
    }
    let t = std::str::from_utf8(s).ok()?;
    Some(format!(
        "{}-{}-{}T{}:{}:{}Z",
        &t[0..4],
        &t[4..6],
        &t[6..8],
        &t[9..11],
        &t[11..13],
        &t[13..15]
    ))
}

/// A date field: absent, a string, or the `raw.trim is not a function` throw of an object.
fn date(tree: &Tree, note: usize, name: &str) -> Result<Option<String>, EnexError> {
    match tree.field(note, name) {
        Field::Missing => Ok(None),
        Field::One(at) if tree.string(at).is_some() => {
            Ok(tree.string(at).and_then(parse_enex_date))
        }
        _ => Err(EnexError("raw.trim is not a function".to_owned())),
    }
}

fn resource(tree: &Tree, at: usize) -> EnexResource {
    if tree.string(at).is_some() {
        return EnexResource {
            base64: String::new(),
            mime: String::new(),
            file_name: None,
        };
    }
    let raw = match tree.field(at, "data") {
        Field::One(data) => {
            let node = &tree.nodes[data];
            match tree.string(data) {
                Some(text) => text.to_owned(),
                None if !node.text.is_empty() => node.text.clone(),
                None => node.cdata.join(","),
            }
        }
        _ => String::new(),
    };
    let file_name = match tree.field(at, "resource-attributes") {
        Field::One(attrs) if tree.string(attrs).is_none() => {
            tree.string_field(attrs, "file-name").map(str::to_owned)
        }
        _ => None,
    };
    EnexResource {
        base64: raw.chars().filter(|c| !c.is_whitespace()).collect(),
        mime: tree.string_field(at, "mime").unwrap_or("").to_owned(),
        file_name,
    }
}

/// `parseEnex`: one [`EnexNote`] per `<note>` of the `<en-export>` root.
pub fn parse_enex(xml: &str) -> Result<Vec<EnexNote>, EnexError> {
    let tree = scan(xml);
    let root = match tree.field(0, "en-export") {
        Field::One(at) if tree.string(at).is_none() => at,
        _ => return Ok(Vec::new()),
    };
    let mut notes = Vec::new();
    for note in tree.all(root, "note") {
        if tree.string(note).is_some() {
            notes.push(EnexNote {
                title: "Untitled".to_owned(),
                content_html: String::new(),
                created: None,
                updated: None,
                tags: Vec::new(),
                resources: Vec::new(),
            });
            continue;
        }
        let content_html = match tree.field(note, "content") {
            Field::One(at) => match (tree.string(at), tree.nodes[at].cdata.as_slice()) {
                (Some(text), _) => text.to_owned(),
                (None, [cdata]) => cdata.clone(),
                _ => String::new(),
            },
            _ => String::new(),
        };
        notes.push(EnexNote {
            title: tree
                .string_field(note, "title")
                .map_or_else(|| "Untitled".to_owned(), |t| js_trim(t).to_owned()),
            content_html,
            created: date(&tree, note, "created")?,
            updated: date(&tree, note, "updated")?,
            tags: tree
                .all(note, "tag")
                .into_iter()
                .filter_map(|t| tree.string(t).map(str::to_owned))
                .collect(),
            resources: tree
                .all(note, "resource")
                .into_iter()
                .map(|r| resource(&tree, r))
                .collect(),
        });
    }
    Ok(notes)
}
