//! Port of the htmlparser2 10.1.0 `Parser` (`dist/esm/Parser.js`) in HTML mode, as linkedom
//! drives it: `lowerCaseAttributeNames: false`, `decodeEntities: true`, and no CDATA or
//! self-closing recognition outside `svg` and `math`.
//!
//! The parser does not follow the HTML5 tree-construction algorithm. It keeps a stack of open
//! names, closes elements through `openImpliesClose`, and ignores end tags it cannot match. That
//! is what linkedom's DOM is built from, so Defuddle's selectors see this tree.

use super::events::{Events, QuoteType};
use super::tables::{
    is_foreign_context_element, is_html_integration_element, is_void_element, open_implies_close,
};
use super::tokenizer::Tokenizer;
use crate::web::extract::utils::js::is_js_whitespace;

/// What linkedom's `parseFromString` listens for.
pub trait TreeHandler {
    fn processing_instruction(&mut self, name: &str, data: &str);
    fn open_tag(&mut self, name: &str, attributes: Vec<(String, String)>);
    fn comment(&mut self, data: &str);
    fn text(&mut self, data: &str);
    fn close_tag(&mut self);
}

/// Parses `input`, reporting to `handler`.
pub fn parse<H: TreeHandler>(input: &str, handler: &mut H) {
    let mut parser = Parser {
        input,
        handler,
        stack: Vec::new(),
        foreign_context: vec![false],
        tag_name: String::new(),
        attrib_name: String::new(),
        attrib_value: String::new(),
        attribs: None,
        high_surrogate: None,
    };
    Tokenizer::run(input, &mut parser);
}

struct Parser<'a, H: TreeHandler> {
    input: &'a str,
    handler: &'a mut H,
    /// Open element names; the last entry is the innermost.
    stack: Vec<String>,
    foreign_context: Vec<bool>,
    tag_name: String,
    attrib_name: String,
    attrib_value: String,
    attribs: Option<Vec<(String, String)>>,
    /// First half of an astral entity such as `&Afr;`, which the decode tree stores as two
    /// surrogate code units. JS makes two text nodes holding lone surrogates; this port joins
    /// them into one node holding the character.
    high_surrogate: Option<u32>,
}

/// `value.search(/\s|\//)` and the lower-casing `getInstructionName` applies.
fn instruction_name(value: &str) -> String {
    let end = value
        .find(|c: char| is_js_whitespace(c) || c == '/')
        .unwrap_or(value.len());
    value[..end].to_lowercase()
}

/// `String.prototype.slice(start, end)` on a range: an end before the start is empty.
fn slice(input: &str, start: usize, end: usize) -> &str {
    if end <= start { "" } else { &input[start..end] }
}

/// Orders attribute names as a JS object lists its keys: array indices ascending, then the rest
/// in insertion order.
fn order_like_js_object_keys(attribs: &mut [(String, String)]) {
    fn array_index(key: &str) -> Option<u64> {
        let canonical = key == "0" || (!key.starts_with('0') && !key.is_empty());
        if !canonical || !key.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        key.parse::<u64>().ok().filter(|&n| n < 4_294_967_295)
    }
    attribs.sort_by_key(|(key, _)| match array_index(key) {
        Some(n) => (0u8, n),
        None => (1u8, 0),
    });
}

impl<H: TreeHandler> Parser<'_, H> {
    fn current_is_foreign(&self) -> bool {
        self.foreign_context.last().copied().unwrap_or(false)
    }

    fn emit_open_tag(&mut self, name: &str) {
        self.tag_name = name.to_string();
        if let Some(implied) = open_implies_close(name) {
            while self
                .stack
                .last()
                .is_some_and(|top| implied.contains(&top.as_str()))
            {
                self.stack.pop();
                self.handler.close_tag();
            }
        }
        if !is_void_element(name) {
            self.stack.push(name.to_string());
            if is_foreign_context_element(name) {
                self.foreign_context.push(true);
            } else if is_html_integration_element(name) {
                self.foreign_context.push(false);
            }
        }
        self.attribs = Some(Vec::new());
    }

    fn end_open_tag(&mut self) {
        if let Some(mut attribs) = self.attribs.take() {
            order_like_js_object_keys(&mut attribs);
            self.handler.open_tag(&self.tag_name, attribs);
        }
        if is_void_element(&self.tag_name) {
            self.handler.close_tag();
        }
        self.tag_name.clear();
    }

    fn close_current_tag(&mut self) {
        let name = self.tag_name.clone();
        self.end_open_tag();
        if self.stack.last() == Some(&name) {
            self.handler.close_tag();
            self.stack.pop();
        }
    }

    fn push_entity_char(&mut self, code_point: u32, into_attribute: bool) {
        let ch = if let Some(high) = self.high_surrogate.take() {
            if (0xdc00..=0xdfff).contains(&code_point) {
                char::from_u32(0x1_0000 + ((high - 0xd800) << 10) + (code_point - 0xdc00))
            } else {
                None
            }
        } else if (0xd800..=0xdbff).contains(&code_point) {
            self.high_surrogate = Some(code_point);
            return;
        } else {
            char::from_u32(code_point)
        }
        .unwrap_or('\u{fffd}');
        if into_attribute {
            self.attrib_value.push(ch);
        } else {
            let mut buf = [0u8; 4];
            self.handler.text(ch.encode_utf8(&mut buf));
        }
    }
}

impl<H: TreeHandler> Events for Parser<'_, H> {
    fn text(&mut self, start: usize, end: usize) {
        self.handler.text(slice(self.input, start, end));
    }

    fn text_entity(&mut self, code_point: u32) {
        self.push_entity_char(code_point, false);
    }

    fn open_tag_name(&mut self, start: usize, end: usize) {
        let name = slice(self.input, start, end).to_lowercase();
        self.emit_open_tag(&name);
    }

    fn open_tag_end(&mut self) {
        self.end_open_tag();
    }

    fn close_tag(&mut self, start: usize, end: usize) {
        let name = slice(self.input, start, end).to_lowercase();
        if is_foreign_context_element(&name) || is_html_integration_element(&name) {
            self.foreign_context.pop();
        }
        if !is_void_element(&name) {
            if let Some(pos) = self.stack.iter().rposition(|open| *open == name) {
                while self.stack.len() > pos {
                    self.stack.pop();
                    self.handler.close_tag();
                }
            } else if name == "p" {
                // `</p>` with no open `<p>` makes an empty paragraph.
                self.emit_open_tag("p");
                self.close_current_tag();
            }
        } else if name == "br" {
            // An implied open, which cannot go through `emit_open_tag`, or `br` would close itself.
            self.handler.open_tag("br", Vec::new());
            self.handler.close_tag();
        }
    }

    fn self_closing_tag(&mut self) {
        if self.current_is_foreign() {
            self.close_current_tag();
        } else {
            self.end_open_tag();
        }
    }

    fn attrib_name(&mut self, start: usize, end: usize) {
        self.attrib_name = slice(self.input, start, end).to_string();
    }

    fn attrib_data(&mut self, start: usize, end: usize) {
        self.attrib_value.push_str(slice(self.input, start, end));
    }

    fn attrib_entity(&mut self, code_point: u32) {
        self.push_entity_char(code_point, true);
    }

    fn attrib_end(&mut self, _quote: QuoteType) {
        let name = std::mem::take(&mut self.attrib_name);
        let value = std::mem::take(&mut self.attrib_value);
        // `attribs[name] = value` on a plain object: the first of a duplicated name wins, and
        // `__proto__` assigns a string to the prototype slot, which is ignored.
        if let Some(attribs) = self.attribs.as_mut()
            && name != "__proto__"
            && !attribs.iter().any(|(existing, _)| *existing == name)
        {
            attribs.push((name, value));
        }
    }

    fn declaration(&mut self, start: usize, end: usize) {
        let value = slice(self.input, start, end);
        let name = instruction_name(value);
        self.handler
            .processing_instruction(&format!("!{name}"), &format!("!{value}"));
    }

    fn processing_instruction(&mut self, start: usize, end: usize) {
        let value = slice(self.input, start, end);
        let name = instruction_name(value);
        self.handler
            .processing_instruction(&format!("?{name}"), &format!("?{value}"));
    }

    fn comment(&mut self, start: usize, end: usize, offset: usize) {
        self.handler
            .comment(slice(self.input, start, end.saturating_sub(offset)));
    }

    fn cdata(&mut self, start: usize, end: usize, offset: usize) {
        // Without `recognizeCDATA`, HTML turns a CDATA section into a comment.
        let mut data = String::from("[CDATA[");
        data.push_str(slice(self.input, start, end.saturating_sub(offset)));
        data.push_str("]]");
        self.handler.comment(&data);
    }

    fn end(&mut self) {
        for _ in 0..self.stack.len() {
            self.handler.close_tag();
        }
    }
}
