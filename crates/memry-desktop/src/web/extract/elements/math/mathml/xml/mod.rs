//! `@xmldom/xmldom` 0.8.15 `DOMParser.parseFromString(xml, 'text/xml')`, as mathml-to-latex uses
//! it.
//!
//! The repo pins xmldom to 0.8.15 (root `pnpm.overrides`) while mathml-to-latex asks for 0.9, so
//! the `onError` option the library passes is ignored: warnings and errors only log, a `fatalError`
//! throws and the library then sees no document. This is `sax.js` plus the `DOMHandler` of
//! `dom-parser.js`, reduced to what the result is read for: element names, attributes in source
//! order, and whether an element has children that are not text nodes. Positions are char indices
//! (JS uses UTF-16 units, which only differ for astral chars no rule here depends on).

mod markup;
mod text;

use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::LazyLock;
use text::*;

use regex::Regex;

use crate::web::extract::utils::js::{WS_BODY, is_js_whitespace, parse_int, to_lower};

/// A node as `getElementsByTagName('math')` consumers read it.
#[derive(Debug)]
pub enum XNode {
    Element {
        name: String,
        attrs: Vec<(String, String)>,
        children: Vec<XNode>,
    },
    Text(String),
    /// A processing instruction: unlike the other non-text nodes it has a `tagName` (its target)
    /// and no attribute list, which mathml-to-latex trips over.
    ProcessingInstruction,
    /// Comment, CDATA section or doctype: a node whose `nodeName` is not `#text`.
    Other,
}

const XML_NS: &str = "http://www.w3.org/XML/1998/namespace";
const HTML_NS: &str = "http://www.w3.org/1999/xhtml";

/// `Object.prototype` members: a `{}` lookup by one of these names finds a value, not `undefined`.
pub const OBJECT_PROTOTYPE_NAMES: &[&str] = &[
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

/// Parse failure the library cannot recover from: a `ParseError` thrown by `fatalError`.
pub struct Fatal;

/// What stops a parser step early.
enum Stop {
    /// A JS exception the main loop catches (`errorHandler.error`); the step ends with `-1`.
    Soft,
    /// `fatalError`: a `ParseError` nothing catches.
    Fatal,
}

/// How a step ended.
enum Flow {
    /// `return` out of `parse`: no `<` is left.
    Done,
    /// The end index the loop continues from.
    End(i64),
}

type NsMap = Rc<HashMap<String, String>>;

fn is_name_start(c: char) -> bool {
    matches!(c,
        'A'..='Z' | '_' | 'a'..='z' | '\u{C0}'..='\u{D6}' | '\u{D8}'..='\u{F6}'
        | '\u{F8}'..='\u{2FF}' | '\u{370}'..='\u{37D}' | '\u{37F}'..='\u{1FFF}'
        | '\u{200C}'..='\u{200D}' | '\u{2070}'..='\u{218F}' | '\u{2C00}'..='\u{2FEF}'
        | '\u{3001}'..='\u{D7FF}' | '\u{F900}'..='\u{FDCF}' | '\u{FDF0}'..='\u{FFFD}')
}

fn is_name_char(c: char) -> bool {
    is_name_start(c)
        || matches!(c, '-' | '.' | '0'..='9' | '\u{B7}' | '\u{300}'..='\u{36F}' | '\u{203F}'..='\u{2040}')
}

/// `tagNamePattern`: a name, optionally one `:` and a second name.
fn tag_name_ok(name: &str) -> bool {
    let mut parts = name.splitn(2, ':');
    let valid = |s: &str| {
        let mut chars = s.chars();
        chars.next().is_some_and(is_name_start) && chars.all(is_name_char)
    };
    let first = parts.next().unwrap_or("");
    match parts.next() {
        None => valid(first),
        Some(second) => valid(first) && valid(second),
    }
}

#[derive(Clone, Copy, PartialEq)]
enum S {
    Tag,
    Attr,
    AttrSpace,
    Eq,
    AttrNoquotValue,
    AttrEnd,
    TagSpace,
    TagClose,
}

#[derive(Default)]
struct ElementAttributes {
    tag_name: Option<String>,
    attrs: Vec<(String, String)>,
    closed: bool,
}

struct ParseEntry {
    tag_name: Option<String>,
    ns: NsMap,
}

struct OpenNode {
    name: String,
    attrs: Vec<(String, String)>,
    children: Vec<XNode>,
}

struct Parser {
    s: Vec<char>,
    start: usize,
    /// `tagStart` of the current step, for the loop's recovery.
    tag_start: usize,
    /// The `DOMHandler`'s open elements; the top is `currentElement`, none is the document.
    open: Vec<OpenNode>,
    /// Elements appended to the document, in order (other document-level nodes are never read).
    root: Vec<XNode>,
    /// The document already has an element child: `Document.appendChild` rejects a second one.
    root_started: bool,
    has_doctype: bool,
    /// `DOMHandler.cdata`: set by `startCDATA`, cleared by `endCDATA`, which an exception in
    /// between skips.
    cdata: bool,
}

impl Parser {
    fn ch(&self, i: usize) -> Option<char> {
        self.s.get(i).copied()
    }

    // ---- DOMHandler ----

    fn append(&mut self, node: XNode) {
        if let Some(top) = self.open.last_mut() {
            top.children.push(node);
        }
    }

    /// `DOMHandler.characters`: `Err` is the `DOMException` of `Document.appendChild` refusing a
    /// CDATA section.
    fn characters(&mut self, text: String) -> Result<(), Stop> {
        if text.is_empty() {
            return Ok(());
        }
        match self.open.last_mut() {
            Some(top) => top.children.push(if self.cdata {
                XNode::Other
            } else {
                XNode::Text(text)
            }),
            // `currentElement` is the document once the root element has closed; before that it
            // is unset and only whitespace goes to the document.
            None => {
                let at_document = self.root_started || text.chars().all(is_js_whitespace);
                if at_document && self.cdata {
                    return Err(Stop::Soft);
                }
            }
        }
        Ok(())
    }

    fn end_element(&mut self) -> Result<(), Stop> {
        let top = self.open.pop().ok_or(Stop::Soft)?;
        let node = XNode::Element {
            name: top.name,
            attrs: top.attrs,
            children: top.children,
        };
        match self.open.last_mut() {
            Some(parent) => parent.children.push(node),
            None => self.root.push(node),
        }
        Ok(())
    }

    fn append_text(&mut self, end: usize) -> Result<(), Stop> {
        if end > self.start {
            let text = replace_entities(&collect(&self.s[self.start..end.min(self.s.len())]));
            self.characters(text)?;
            self.start = end;
        }
        Ok(())
    }

    // ---- sax.js ----

    fn run(&mut self) -> Result<(), Fatal> {
        let default_ns: NsMap = Rc::new(HashMap::from([("xml".to_string(), XML_NS.to_string())]));
        let mut stack = vec![ParseEntry {
            tag_name: None,
            ns: default_ns,
        }];
        let mut close_map = HashMap::new();
        loop {
            let end = match self.step(&mut stack, &mut close_map) {
                Ok(Flow::Done) => return Ok(()),
                Ok(Flow::End(end)) => end,
                Err(Stop::Soft) => -1,
                Err(Stop::Fatal) => return Err(Fatal),
            };
            if end > self.start as i64 {
                self.start = end as usize;
            } else {
                // Outside the `try`: an exception here is not caught.
                if self
                    .append_text(self.tag_start.max(self.start) + 1)
                    .is_err()
                {
                    return Err(Fatal);
                }
            }
        }
    }

    fn step(
        &mut self,
        stack: &mut Vec<ParseEntry>,
        close_map: &mut HashMap<String, i64>,
    ) -> Result<Flow, Stop> {
        let tag_start = index_of(&self.s, &['<'], self.start);
        if tag_start < 0 {
            // Trailing text is appended to the document, which nothing reads.
            return Ok(Flow::Done);
        }
        let tag_start = tag_start as usize;
        self.tag_start = tag_start;
        if tag_start > self.start {
            self.append_text(tag_start)?;
        }
        let end = match self.ch(tag_start + 1) {
            Some('/') => self.end_tag(stack, tag_start)?,
            Some('?') => self.parse_instruction(tag_start),
            Some('!') => self.parse_dcc(tag_start)?,
            _ => self.start_tag(stack, close_map, tag_start)?,
        };
        Ok(Flow::End(end))
    }
}

struct Token {
    text: String,
    index: usize,
}

/// `new DOMParser().parseFromString(source, 'text/xml')`: the elements at the top of the
/// document. `Err` is a thrown `ParseError`, after which the library has no document.
pub fn parse(source: &str) -> Result<Vec<XNode>, Fatal> {
    // `normalizeLineEndings`
    let normalized = source
        .replace("\r\n", "\n")
        .replace("\r\u{85}", "\n")
        .replace(['\r', '\u{85}', '\u{2028}'], "\n");
    let mut parser = Parser {
        s: chars(&normalized),
        start: 0,
        tag_start: 0,
        open: Vec::new(),
        root: Vec::new(),
        root_started: false,
        has_doctype: false,
        cdata: false,
    };
    if !normalized.is_empty() {
        parser.run()?;
    }
    // JS attaches an element to its parent when it starts, so elements never closed stay in the
    // tree.
    while !parser.open.is_empty() {
        let _ = parser.end_element();
    }
    Ok(parser.root)
}
