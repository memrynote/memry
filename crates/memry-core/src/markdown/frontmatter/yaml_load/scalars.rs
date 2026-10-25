//! The scalar readers of `loader.js`: plain, single and double quoted, and
//! block (literal and folded) scalars.

use super::{Res, State, is_eol, is_flow_indicator, is_white_space, is_ws_or_eol};
use crate::markdown::frontmatter::scalar::Kind;
use crate::markdown::frontmatter::value::YamlValue;

fn simple_escape(c: u32) -> Option<char> {
    Some(match char::from_u32(c)? {
        '0' => '\0',
        'a' => '\u{7}',
        'b' => '\u{8}',
        't' | '\t' => '\t',
        'n' => '\n',
        'v' => '\u{B}',
        'f' => '\u{C}',
        'r' => '\r',
        'e' => '\u{1B}',
        ' ' => ' ',
        '"' => '"',
        '/' => '/',
        '\\' => '\\',
        'N' => '\u{85}',
        '_' => '\u{A0}',
        'L' => '\u{2028}',
        'P' => '\u{2029}',
        _ => return None,
    })
}

fn hex_value(c: u32) -> Option<u32> {
    char::from_u32(c).and_then(|c| c.to_digit(16))
}

impl State {
    pub(super) fn read_plain_scalar(&mut self, node_indent: i64, within_flow: bool) -> Res<bool> {
        let saved_kind = self.kind;
        let saved_result = self.result.clone();
        let mut ch = self.cur();
        if is_ws_or_eol(ch)
            || is_flow_indicator(ch)
            || matches!(
                ch,
                0x23 | 0x26 | 0x2A | 0x21 | 0x7C | 0x3E | 0x27 | 0x22 | 0x25 | 0x40 | 0x60
            )
        {
            return Ok(false);
        }
        if ch == 0x3F || ch == 0x2D {
            let following = self.at(self.position + 1);
            if is_ws_or_eol(following) || (within_flow && is_flow_indicator(following)) {
                return Ok(false);
            }
        }
        self.kind = Some(Kind::Scalar);
        self.result = YamlValue::String(String::new());
        let mut capture_start = self.position;
        let mut capture_end = self.position;
        let mut has_pending = false;
        let mut saved_line = 0;

        while ch != 0 {
            if ch == 0x3A {
                let following = self.at(self.position + 1);
                if is_ws_or_eol(following) || (within_flow && is_flow_indicator(following)) {
                    break;
                }
            } else if ch == 0x23 {
                if is_ws_or_eol(self.preceding()) {
                    break;
                }
            } else if (self.position == self.line_start && self.test_document_separator())
                || (within_flow && is_flow_indicator(ch))
            {
                break;
            } else if is_eol(ch) {
                saved_line = self.line;
                let saved_line_start = self.line_start;
                let saved_line_indent = self.line_indent;
                self.skip_separation_space(false)?;
                if self.line_indent >= node_indent {
                    has_pending = true;
                    ch = self.cur();
                    continue;
                }
                self.position = capture_end;
                self.line = saved_line;
                self.line_start = saved_line_start;
                self.line_indent = saved_line_indent;
                break;
            }
            if has_pending {
                self.capture_segment(capture_start, capture_end, false)?;
                self.write_folded_lines(self.line - saved_line);
                capture_start = self.position;
                capture_end = self.position;
                has_pending = false;
            }
            if !is_white_space(ch) {
                capture_end = self.position + 1;
            }
            ch = self.advance();
        }
        self.capture_segment(capture_start, capture_end, false)?;
        if self.result_is_nonempty_string() {
            return Ok(true);
        }
        self.kind = saved_kind;
        self.result = saved_result;
        Ok(false)
    }

    pub(super) fn read_single_quoted_scalar(&mut self, node_indent: i64) -> Res<bool> {
        let _ = node_indent;
        if self.cur() != 0x27 {
            return Ok(false);
        }
        self.kind = Some(Kind::Scalar);
        self.result = YamlValue::String(String::new());
        self.position += 1;
        let mut capture_start = self.position;
        let mut capture_end = self.position;
        loop {
            let ch = self.cur();
            if ch == 0 {
                break;
            }
            if ch == 0x27 {
                self.capture_segment(capture_start, self.position, true)?;
                let next = self.advance();
                if next == 0x27 {
                    capture_start = self.position;
                    self.position += 1;
                    capture_end = self.position;
                } else {
                    return Ok(true);
                }
            } else if is_eol(ch) {
                self.capture_segment(capture_start, capture_end, true)?;
                let breaks = self.skip_separation_space(false)?;
                self.write_folded_lines(breaks);
                capture_start = self.position;
                capture_end = self.position;
            } else if self.position == self.line_start && self.test_document_separator() {
                return self.error("unexpected end of the document within a single quoted scalar");
            } else {
                self.position += 1;
                capture_end = self.position;
            }
        }
        self.error("unexpected end of the stream within a single quoted scalar")
    }

    pub(super) fn read_double_quoted_scalar(&mut self, node_indent: i64) -> Res<bool> {
        let _ = node_indent;
        if self.cur() != 0x22 {
            return Ok(false);
        }
        self.kind = Some(Kind::Scalar);
        self.result = YamlValue::String(String::new());
        self.position += 1;
        let mut capture_start = self.position;
        let mut capture_end = self.position;
        // A `\uD83D` escape waits here for its low half.
        let mut pending_high: Option<u32> = None;
        loop {
            let ch = self.cur();
            if ch == 0 {
                break;
            }
            if ch == 0x22 {
                self.flush_surrogate(&mut pending_high);
                self.capture_segment(capture_start, self.position, true)?;
                self.position += 1;
                return Ok(true);
            } else if ch == 0x5C {
                if self.position > capture_start {
                    self.flush_surrogate(&mut pending_high);
                }
                self.capture_segment(capture_start, self.position, true)?;
                let ch = self.advance();
                if is_eol(ch) {
                    self.flush_surrogate(&mut pending_high);
                    self.skip_separation_space(false)?;
                } else if let Some(c) = simple_escape(ch).filter(|_| ch < 256) {
                    self.flush_surrogate(&mut pending_high);
                    self.result_push(c.encode_utf8(&mut [0; 4]));
                    self.position += 1;
                } else if let Some(len) = match ch {
                    0x78 => Some(2),
                    0x75 => Some(4),
                    0x55 => Some(8),
                    _ => None,
                } {
                    let mut value: u32 = 0;
                    for _ in 0..len {
                        let digit = self.advance();
                        match hex_value(digit) {
                            Some(d) => value = value.wrapping_shl(4).wrapping_add(d),
                            None => return self.error("expected hexadecimal character"),
                        }
                    }
                    self.push_code_point(value, &mut pending_high);
                    self.position += 1;
                } else {
                    return self.error("unknown escape sequence");
                }
                capture_start = self.position;
                capture_end = self.position;
            } else if is_eol(ch) {
                self.flush_surrogate(&mut pending_high);
                self.capture_segment(capture_start, capture_end, true)?;
                let breaks = self.skip_separation_space(false)?;
                self.write_folded_lines(breaks);
                capture_start = self.position;
                capture_end = self.position;
            } else if self.position == self.line_start && self.test_document_separator() {
                return self.error("unexpected end of the document within a double quoted scalar");
            } else {
                self.position += 1;
                capture_end = self.position;
            }
        }
        self.error("unexpected end of the stream within a double quoted scalar")
    }

    fn push_code_point(&mut self, value: u32, pending_high: &mut Option<u32>) {
        if (0xDC00..=0xDFFF).contains(&value)
            && let Some(high) = pending_high.take()
        {
            let combined = 0x10000 + ((high - 0xD800) << 10) + (value - 0xDC00);
            self.result_push(&char::from_u32(combined).unwrap_or('\u{FFFD}').to_string());
            return;
        }
        self.flush_surrogate(pending_high);
        if (0xD800..=0xDBFF).contains(&value) {
            *pending_high = Some(value);
        } else {
            self.result_push(&char::from_u32(value).unwrap_or('\u{FFFD}').to_string());
        }
    }

    /// A high surrogate that never found its low half: no UTF-8 spelling exists.
    fn flush_surrogate(&mut self, pending_high: &mut Option<u32>) {
        if pending_high.take().is_some() {
            self.result_push("\u{FFFD}");
        }
    }

    pub(super) fn read_block_scalar(&mut self, node_indent: i64) -> Res<bool> {
        const CLIP: u8 = 1;
        const STRIP: u8 = 2;
        const KEEP: u8 = 3;
        let mut ch = self.cur();
        let folding = match ch {
            0x7C => false,
            0x3E => true,
            _ => return Ok(false),
        };
        let mut chomping = CLIP;
        let mut did_read_content = false;
        let mut detected_indent = false;
        let mut text_indent = node_indent;
        let mut empty_lines = 0usize;
        let mut at_more_indented = false;
        self.kind = Some(Kind::Scalar);
        self.result = YamlValue::String(String::new());

        while ch != 0 {
            ch = self.advance();
            if ch == 0x2B || ch == 0x2D {
                if chomping == CLIP {
                    chomping = if ch == 0x2B { KEEP } else { STRIP };
                } else {
                    return self.error("repeat of a chomping mode identifier");
                }
            } else if let Some(digit) = char::from_u32(ch).and_then(|c| c.to_digit(10)) {
                if digit == 0 {
                    return self.error(
                        "bad explicit indentation width of a block scalar; it cannot be less than one",
                    );
                } else if !detected_indent {
                    text_indent = node_indent + i64::from(digit) - 1;
                    detected_indent = true;
                } else {
                    return self.error("repeat of an indentation width identifier");
                }
            } else {
                break;
            }
        }
        if is_white_space(ch) {
            loop {
                ch = self.advance();
                if !is_white_space(ch) {
                    break;
                }
            }
            if ch == 0x23 {
                loop {
                    ch = self.advance();
                    if is_eol(ch) || ch == 0 {
                        break;
                    }
                }
            }
        }
        while ch != 0 {
            self.read_line_break()?;
            self.line_indent = 0;
            ch = self.cur();
            while (!detected_indent || self.line_indent < text_indent) && ch == 0x20 {
                self.line_indent += 1;
                ch = self.advance();
            }
            if !detected_indent && self.line_indent > text_indent {
                text_indent = self.line_indent;
            }
            if is_eol(ch) {
                empty_lines += 1;
                continue;
            }
            if self.line_indent < text_indent {
                if chomping == KEEP {
                    let count = if did_read_content {
                        1 + empty_lines
                    } else {
                        empty_lines
                    };
                    self.result_push(&"\n".repeat(count));
                } else if chomping == CLIP && did_read_content {
                    self.result_push("\n");
                }
                break;
            }
            if folding {
                if is_white_space(ch) {
                    at_more_indented = true;
                    let count = if did_read_content {
                        1 + empty_lines
                    } else {
                        empty_lines
                    };
                    self.result_push(&"\n".repeat(count));
                } else if at_more_indented {
                    at_more_indented = false;
                    self.result_push(&"\n".repeat(empty_lines + 1));
                } else if empty_lines == 0 {
                    if did_read_content {
                        self.result_push(" ");
                    }
                } else {
                    self.result_push(&"\n".repeat(empty_lines));
                }
            } else {
                let count = if did_read_content {
                    1 + empty_lines
                } else {
                    empty_lines
                };
                self.result_push(&"\n".repeat(count));
            }
            did_read_content = true;
            detected_indent = true;
            empty_lines = 0;
            let capture_start = self.position;
            while !is_eol(ch) && ch != 0 {
                ch = self.advance();
            }
            self.capture_segment(capture_start, self.position, false)?;
        }
        Ok(true)
    }
}
