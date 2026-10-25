//! Port of the `EntityDecoder` of `entities` 7.0.1 (`dist/esm/decode.js`), the entity decoding
//! htmlparser2 10.1.0 uses, with its HTML decode tree as committed data.
//!
//! The tree (`html_decode_tree.bin`, little-endian u16 words) is written by
//! `packages/article-extract/scripts/generate-entities.mjs`; never edit it by hand. The decoder
//! works on bytes. Every character the entity grammar looks at is ASCII, and all other bytes end
//! a match, so byte offsets and the UTF-16 offsets of the JS code agree wherever they are used.

use std::sync::OnceLock;

const VALUE_LENGTH: u16 = 0xc000;
const FLAG13: u16 = 0x2000;
const BRANCH_LENGTH: u16 = 0x1f80;
const JUMP_TABLE: u16 = 0x007f;

fn tree() -> &'static [u16] {
    static TREE: OnceLock<Vec<u16>> = OnceLock::new();
    TREE.get_or_init(|| {
        include_bytes!("html_decode_tree.bin")
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect()
    })
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DecodingMode {
    /// Entities in text nodes that can end with any character.
    Legacy,
    /// Entities in attributes have limitations on ending characters.
    Attribute,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    EntityStart,
    NumericStart,
    NumericDecimal,
    NumericHex,
    NamedEntity,
}

/// `replaceCodePoint` of `decode-codepoint.js`.
fn replace_code_point(code_point: u64) -> u32 {
    if (0xd800..=0xdfff).contains(&code_point) || code_point > 0x10_ffff {
        return 0xfffd;
    }
    match code_point as u32 {
        0 => 0xfffd,
        128 => 8364,
        130 => 8218,
        131 => 402,
        132 => 8222,
        133 => 8230,
        134 => 8224,
        135 => 8225,
        136 => 710,
        137 => 8240,
        138 => 352,
        139 => 8249,
        140 => 338,
        142 => 381,
        145 => 8216,
        146 => 8217,
        147 => 8220,
        148 => 8221,
        149 => 8226,
        150 => 8211,
        151 => 8212,
        152 => 732,
        153 => 8482,
        154 => 353,
        155 => 8250,
        156 => 339,
        158 => 382,
        159 => 376,
        other => other,
    }
}

fn is_hex(c: u8) -> bool {
    c.is_ascii_hexdigit()
}

fn is_entity_in_attribute_invalid_end(c: u8) -> bool {
    c == b'=' || c.is_ascii_alphanumeric()
}

/// `determineBranch`; `-1` when no branch is taken.
fn determine_branch(tree: &[u16], current: u16, node_index: usize, ch: u8) -> i64 {
    let branch_count = usize::from((current & BRANCH_LENGTH) >> 7);
    let jump_offset = i64::from(current & JUMP_TABLE);
    let ch = i64::from(ch);
    if branch_count == 0 {
        return if jump_offset != 0 && ch == jump_offset {
            node_index as i64
        } else {
            -1
        };
    }
    if jump_offset != 0 {
        let value = ch - jump_offset;
        return if value < 0 || value >= branch_count as i64 {
            -1
        } else {
            i64::from(tree[node_index + value as usize]) - 1
        };
    }
    let packed_key_slots = (branch_count + 1) >> 1;
    let mut lo = 0i64;
    let mut hi = branch_count as i64 - 1;
    while lo <= hi {
        let mid = (lo + hi) >> 1;
        let slot = (mid >> 1) as usize;
        let packed = tree[node_index + slot];
        let mid_key = i64::from((packed >> ((mid & 1) * 8)) & 0xff);
        if mid_key < ch {
            lo = mid + 1;
        } else if mid_key > ch {
            hi = mid - 1;
        } else {
            return i64::from(tree[node_index + packed_key_slots + mid as usize]);
        }
    }
    -1
}

/// Decodes one entity at a time. Code points come out through [`EntityDecoder::take_output`],
/// each with the number of bytes consumed, `&` included.
pub struct EntityDecoder {
    tree: &'static [u16],
    state: State,
    consumed: usize,
    numeric: u64,
    /// Index of the best entity found so far in the tree; 0 means none.
    result: usize,
    tree_index: usize,
    excess: usize,
    mode: DecodingMode,
    run_consumed: usize,
    out: Vec<(u32, usize)>,
}

impl Default for EntityDecoder {
    fn default() -> Self {
        Self::new()
    }
}

impl EntityDecoder {
    pub fn new() -> Self {
        EntityDecoder {
            tree: tree(),
            state: State::EntityStart,
            consumed: 1,
            numeric: 0,
            result: 0,
            tree_index: 0,
            excess: 1,
            mode: DecodingMode::Legacy,
            run_consumed: 0,
            out: Vec::new(),
        }
    }

    pub fn start_entity(&mut self, mode: DecodingMode) {
        self.mode = mode;
        self.state = State::EntityStart;
        self.numeric = 0;
        self.result = 0;
        self.tree_index = 0;
        self.excess = 1;
        self.consumed = 1;
        self.run_consumed = 0;
    }

    pub fn take_output(&mut self) -> Vec<(u32, usize)> {
        std::mem::take(&mut self.out)
    }

    /// `write(input, offset)`: the bytes consumed, or -1 when the entity is incomplete.
    pub fn write(&mut self, input: &[u8], offset: usize) -> i64 {
        match self.state {
            State::EntityStart => {
                if input.get(offset) == Some(&b'#') {
                    self.state = State::NumericStart;
                    self.consumed += 1;
                    return self.state_numeric_start(input, offset + 1);
                }
                self.state = State::NamedEntity;
                self.state_named_entity(input, offset)
            }
            State::NumericStart => self.state_numeric_start(input, offset),
            State::NumericDecimal => self.state_numeric_decimal(input, offset),
            State::NumericHex => self.state_numeric_hex(input, offset),
            State::NamedEntity => self.state_named_entity(input, offset),
        }
    }

    fn state_numeric_start(&mut self, input: &[u8], offset: usize) -> i64 {
        let Some(&c) = input.get(offset) else {
            return -1;
        };
        if c | 0x20 == b'x' {
            self.state = State::NumericHex;
            self.consumed += 1;
            return self.state_numeric_hex(input, offset + 1);
        }
        self.state = State::NumericDecimal;
        self.state_numeric_decimal(input, offset)
    }

    fn state_numeric_hex(&mut self, input: &[u8], mut offset: usize) -> i64 {
        while let Some(&c) = input.get(offset) {
            if is_hex(c) {
                let digit = if c <= b'9' {
                    c - b'0'
                } else {
                    (c | 0x20) - b'a' + 10
                };
                self.numeric = self
                    .numeric
                    .saturating_mul(16)
                    .saturating_add(u64::from(digit));
                self.consumed += 1;
                offset += 1;
            } else {
                return self.emit_numeric_entity(Some(c), 3);
            }
        }
        -1
    }

    fn state_numeric_decimal(&mut self, input: &[u8], mut offset: usize) -> i64 {
        while let Some(&c) = input.get(offset) {
            if c.is_ascii_digit() {
                self.numeric = self
                    .numeric
                    .saturating_mul(10)
                    .saturating_add(u64::from(c - b'0'));
                self.consumed += 1;
                offset += 1;
            } else {
                return self.emit_numeric_entity(Some(c), 2);
            }
        }
        -1
    }

    fn emit_numeric_entity(&mut self, last: Option<u8>, expected_length: usize) -> i64 {
        if self.consumed <= expected_length {
            return 0;
        }
        if last == Some(b';') {
            self.consumed += 1;
        }
        // htmlparser2 never decodes strictly, so a missing semicolon is accepted.
        self.out
            .push((replace_code_point(self.numeric), self.consumed));
        self.consumed as i64
    }

    fn state_named_entity(&mut self, input: &[u8], mut offset: usize) -> i64 {
        let tree = self.tree;
        let mut current = tree[self.tree_index];
        let mut value_length = (current & VALUE_LENGTH) >> 14;
        while offset < input.len() {
            if value_length == 0 && (current & FLAG13) != 0 {
                let run_length = usize::from((current & BRANCH_LENGTH) >> 7);
                if self.run_consumed == 0 {
                    let first_char = (current & JUMP_TABLE) as u8;
                    if input[offset] != first_char {
                        return if self.result == 0 {
                            0
                        } else {
                            self.emit_not_terminated()
                        };
                    }
                    offset += 1;
                    self.excess += 1;
                    self.run_consumed += 1;
                }
                while self.run_consumed < run_length {
                    if offset >= input.len() {
                        return -1;
                    }
                    let char_index = self.run_consumed - 1;
                    let packed = tree[self.tree_index + 1 + (char_index >> 1)];
                    let expected = if char_index.is_multiple_of(2) {
                        packed & 0xff
                    } else {
                        (packed >> 8) & 0xff
                    };
                    if u16::from(input[offset]) != expected {
                        self.run_consumed = 0;
                        return if self.result == 0 {
                            0
                        } else {
                            self.emit_not_terminated()
                        };
                    }
                    offset += 1;
                    self.excess += 1;
                    self.run_consumed += 1;
                }
                self.run_consumed = 0;
                self.tree_index += 1 + (run_length >> 1);
                current = tree[self.tree_index];
                value_length = (current & VALUE_LENGTH) >> 14;
            }
            if offset >= input.len() {
                break;
            }
            let ch = input[offset];
            if ch == b';' && value_length != 0 && (current & FLAG13) != 0 {
                return self.emit_named_entity_data(
                    self.tree_index,
                    value_length,
                    self.consumed + self.excess,
                );
            }
            let branch = determine_branch(
                tree,
                current,
                self.tree_index + usize::from(value_length).max(1),
                ch,
            );
            if branch < 0 {
                let skip = self.result == 0
                    || (self.mode == DecodingMode::Attribute
                        && (value_length == 0 || is_entity_in_attribute_invalid_end(ch)));
                return if skip { 0 } else { self.emit_not_terminated() };
            }
            self.tree_index = branch as usize;
            current = tree[self.tree_index];
            value_length = (current & VALUE_LENGTH) >> 14;
            if value_length != 0 {
                if ch == b';' {
                    return self.emit_named_entity_data(
                        self.tree_index,
                        value_length,
                        self.consumed + self.excess,
                    );
                }
                if (current & FLAG13) == 0 {
                    self.result = self.tree_index;
                    self.consumed += self.excess;
                    self.excess = 0;
                }
            }
            offset += 1;
            self.excess += 1;
        }
        -1
    }

    fn emit_not_terminated(&mut self) -> i64 {
        let result = self.result;
        let value_length = (self.tree[result] & VALUE_LENGTH) >> 14;
        self.emit_named_entity_data(result, value_length, self.consumed)
    }

    fn emit_named_entity_data(&mut self, result: usize, value_length: u16, consumed: usize) -> i64 {
        let tree = self.tree;
        let first = if value_length == 1 {
            u32::from(tree[result] & !(VALUE_LENGTH | FLAG13))
        } else {
            u32::from(tree[result + 1])
        };
        self.out.push((first, consumed));
        if value_length == 3 {
            self.out.push((u32::from(tree[result + 2]), consumed));
        }
        consumed as i64
    }

    /// `end()`: flushes what an unfinished entity at the end of input still yields.
    pub fn end(&mut self) -> i64 {
        match self.state {
            State::NamedEntity => {
                if self.result != 0
                    && (self.mode != DecodingMode::Attribute || self.result == self.tree_index)
                {
                    self.emit_not_terminated()
                } else {
                    0
                }
            }
            State::NumericDecimal => self.emit_numeric_entity(None, 2),
            State::NumericHex => self.emit_numeric_entity(None, 3),
            State::NumericStart | State::EntityStart => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `decodeHTML` of entities 7.0.1: every `&` run through the decoder as htmlparser2 does.
    fn decode(input: &str, mode: DecodingMode) -> String {
        let bytes = input.as_bytes();
        let mut decoder = EntityDecoder::new();
        let mut out = String::new();
        let mut last = 0usize;
        let mut offset = 0usize;
        while let Some(rel) = bytes[offset..].iter().position(|&b| b == b'&') {
            let amp = offset + rel;
            out.push_str(&input[last..amp]);
            decoder.start_entity(mode);
            let length = decoder.write(bytes, amp + 1);
            let length = if length < 0 { decoder.end() } else { length };
            for (cp, _) in decoder.take_output() {
                out.push(char::from_u32(cp).unwrap_or('\u{fffd}'));
            }
            last = amp + usize::try_from(length).unwrap_or(0);
            offset = if length == 0 { last + 1 } else { last };
            if length < 0 {
                break;
            }
        }
        out.push_str(&input[last.min(input.len())..]);
        out
    }

    // Expected values: `decodeHTML(input)` and `decodeHTMLAttribute(input)` in entities 7.0.1.
    #[test]
    fn named_entities_with_semicolon() {
        assert_eq!(
            decode("a &amp; b &lt;c&gt; &copy; &hellip;", DecodingMode::Legacy),
            "a & b <c> \u{a9} \u{2026}"
        );
    }

    #[test]
    fn legacy_entities_decode_without_a_semicolon_in_text_only() {
        assert_eq!(
            decode("&copy 2024 &ampx", DecodingMode::Legacy),
            "\u{a9} 2024 &x"
        );
        assert_eq!(
            decode("&copy 2024 &ampx", DecodingMode::Attribute),
            "\u{a9} 2024 &ampx"
        );
        assert_eq!(decode("&amp=1", DecodingMode::Attribute), "&amp=1");
    }

    #[test]
    fn numeric_entities() {
        assert_eq!(
            decode(
                "&#65;&#x41;&#X42 &#0; &#128; &#xD800; &#1114112;",
                DecodingMode::Legacy
            ),
            "AAB \u{fffd} \u{20ac} \u{fffd} \u{fffd}"
        );
        assert_eq!(decode("&#;&#x;&# ", DecodingMode::Legacy), "&#;&#x;&# ");
    }

    #[test]
    fn unknown_names_stay_literal() {
        assert_eq!(
            decode("&nosuchentity; &", DecodingMode::Legacy),
            "&nosuchentity; &"
        );
    }

    #[test]
    fn two_code_point_entities() {
        assert_eq!(
            decode("&NotEqualTilde;", DecodingMode::Legacy),
            "\u{2242}\u{338}"
        );
    }
}
