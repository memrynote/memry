//! js-yaml 3.15.1 `safeLoad`, ported function for function from `loader.js`.
//!
//! The reader works on a `Vec<char>` with a NUL sentinel exactly as the
//! original works on a string with `'\0'` appended, so every position and
//! indent comparison carries over unchanged. Two deliberate differences, both
//! on input a vault cannot hold: warnings are dropped (nothing reads them), and
//! a `\ud83d`-style escape that does not form a surrogate pair becomes U+FFFD
//! where JavaScript keeps a lone surrogate that no UTF-8 file can store.

mod collections;
mod compose;
mod scalars;

use std::collections::HashMap;
use std::fmt;

use super::scalar::Kind;
use super::value::YamlValue;

pub(super) const NAN: u32 = u32::MAX;
const MAX_TOTAL_MERGE_KEYS: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YamlError {
    pub message: String,
    pub line: usize,
    pub column: usize,
}

impl fmt::Display for YamlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} at line {}, column {}",
            self.message,
            self.line + 1,
            self.column + 1
        )
    }
}

impl std::error::Error for YamlError {}

pub(super) type Res<T> = Result<T, YamlError>;

pub(super) const CONTEXT_FLOW_IN: u8 = 1;
pub(super) const CONTEXT_FLOW_OUT: u8 = 2;
pub(super) const CONTEXT_BLOCK_IN: u8 = 3;
pub(super) const CONTEXT_BLOCK_OUT: u8 = 4;

pub(super) fn is_eol(c: u32) -> bool {
    c == 0x0A || c == 0x0D
}

pub(super) fn is_white_space(c: u32) -> bool {
    c == 0x09 || c == 0x20
}

pub(super) fn is_ws_or_eol(c: u32) -> bool {
    is_white_space(c) || is_eol(c)
}

pub(super) fn is_flow_indicator(c: u32) -> bool {
    matches!(c, 0x2C | 0x5B | 0x5D | 0x7B | 0x7D)
}

pub(super) struct State {
    pub input: Vec<char>,
    /// Length of the input before the NUL sentinel.
    pub length: usize,
    pub position: usize,
    pub line: usize,
    pub line_start: usize,
    pub line_indent: i64,
    pub total_merge_keys: usize,
    pub documents: Vec<YamlValue>,
    pub version: Option<String>,
    pub tag_map: HashMap<String, String>,
    pub anchor_map: HashMap<String, YamlValue>,
    pub tag: Option<String>,
    pub anchor: Option<String>,
    pub kind: Option<Kind>,
    pub result: YamlValue,
}

impl State {
    pub fn at(&self, position: usize) -> u32 {
        self.input.get(position).map_or(NAN, |c| *c as u32)
    }

    pub fn cur(&self) -> u32 {
        self.at(self.position)
    }

    /// `charCodeAt(position - 1)`; `NaN` before the start.
    pub fn preceding(&self) -> u32 {
        self.position.checked_sub(1).map_or(NAN, |p| self.at(p))
    }

    /// `charCodeAt(++position)`.
    pub fn advance(&mut self) -> u32 {
        self.position += 1;
        self.cur()
    }

    pub fn slice(&self, from: usize, to: usize) -> String {
        self.input[from..to].iter().collect()
    }

    pub fn error<T>(&self, message: &str) -> Res<T> {
        Err(YamlError {
            message: message.to_owned(),
            line: self.line,
            column: self.position.saturating_sub(self.line_start),
        })
    }

    pub fn result_push(&mut self, text: &str) {
        match &mut self.result {
            YamlValue::String(existing) => existing.push_str(text),
            other => *other = YamlValue::String(text.to_owned()),
        }
    }

    pub fn result_is_nonempty_string(&self) -> bool {
        matches!(&self.result, YamlValue::String(text) if !text.is_empty())
    }

    fn capture_segment(&mut self, start: usize, end: usize, check_json: bool) -> Res<()> {
        if start >= end {
            return Ok(());
        }
        let segment = self.slice(start, end);
        if check_json {
            if segment
                .chars()
                .any(|c| !(c == '\t' || ('\u{20}'..='\u{10FFFF}').contains(&c)))
            {
                return self.error("expected valid JSON character");
            }
        } else if segment.chars().any(is_non_printable) {
            return self.error("the stream contains non-printable characters");
        }
        self.result_push(&segment);
        Ok(())
    }

    fn read_line_break(&mut self) -> Res<()> {
        match self.cur() {
            0x0A => self.position += 1,
            0x0D => {
                self.position += 1;
                if self.cur() == 0x0A {
                    self.position += 1;
                }
            }
            _ => return self.error("a line break is expected"),
        }
        self.line += 1;
        self.line_start = self.position;
        Ok(())
    }

    /// Returns the number of line breaks skipped.
    fn skip_separation_space(&mut self, allow_comments: bool) -> Res<usize> {
        let mut line_breaks = 0;
        let mut ch = self.cur();
        while ch != 0 {
            while is_white_space(ch) {
                ch = self.advance();
            }
            if allow_comments && ch == 0x23 {
                loop {
                    ch = self.advance();
                    if ch == 0x0A || ch == 0x0D || ch == 0 {
                        break;
                    }
                }
            }
            if is_eol(ch) {
                self.read_line_break()?;
                ch = self.cur();
                line_breaks += 1;
                self.line_indent = 0;
                while ch == 0x20 {
                    self.line_indent += 1;
                    ch = self.advance();
                }
            } else {
                break;
            }
        }
        Ok(line_breaks)
    }

    fn test_document_separator(&self) -> bool {
        let at = self.position;
        let ch = self.at(at);
        if (ch == 0x2D || ch == 0x2E) && ch == self.at(at + 1) && ch == self.at(at + 2) {
            let next = self.at(at + 3);
            return next == 0 || is_ws_or_eol(next);
        }
        false
    }

    fn write_folded_lines(&mut self, count: usize) {
        if count == 1 {
            self.result_push(" ");
        } else if count > 1 {
            self.result_push(&"\n".repeat(count - 1));
        }
    }
}

/// `PATTERN_NON_PRINTABLE`, minus the surrogate alternatives a `str` cannot hold.
fn is_non_printable(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{8}' | '\u{B}' | '\u{C}' | '\u{E}'..='\u{1F}' | '\u{7F}'..='\u{84}' | '\u{86}'..='\u{9F}' | '\u{FFFE}' | '\u{FFFF}')
}

/// `safeLoad`. `Ok(None)` is JavaScript's `undefined` (no document).
pub fn safe_load(text: &str) -> Result<Option<YamlValue>, YamlError> {
    let mut chars: Vec<char> = text.chars().collect();
    if !chars.is_empty() {
        if !matches!(chars.last(), Some('\n' | '\r')) {
            chars.push('\n');
        }
        if chars[0] == '\u{FEFF}' {
            chars.remove(0);
        }
    }
    let length = chars.len();
    let mut state = State {
        input: chars,
        length,
        position: 0,
        line: 0,
        line_start: 0,
        line_indent: 0,
        total_merge_keys: 0,
        documents: Vec::new(),
        version: None,
        tag_map: HashMap::new(),
        anchor_map: HashMap::new(),
        tag: None,
        anchor: None,
        kind: None,
        result: YamlValue::Null,
    };
    if let Some(nul) = state.input.iter().position(|c| *c == '\0') {
        state.position = nul;
        return state.error("null byte is not allowed in input");
    }
    state.input.push('\0');
    while state.cur() == 0x20 {
        state.line_indent += 1;
        state.position += 1;
    }
    while (state.position as i64) < (state.length as i64 - 1) {
        state.read_document()?;
    }
    match state.documents.len() {
        0 => Ok(None),
        1 => Ok(state.documents.pop()),
        _ => Err(YamlError {
            message: "expected a single document in the stream, but found more".to_owned(),
            line: 0,
            column: 0,
        }),
    }
}
