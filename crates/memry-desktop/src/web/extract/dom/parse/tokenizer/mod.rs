//! Port of the htmlparser2 10.1.0 `Tokenizer` (`dist/esm/Tokenizer.js`) in HTML mode with
//! `decodeEntities: true`, fed the whole document in one `write`.
//!
//! The tokenizer reads bytes. Every character it branches on is ASCII, and the case-insensitive
//! `c | 0x20` tests cannot turn a UTF-8 lead or continuation byte (all at least 0x80) into an
//! ASCII letter, so it reaches the same events as the UTF-16 original. Event ranges are byte
//! offsets into the input.

mod entity;

use super::entities::{DecodingMode, EntityDecoder};
use super::events::{CDATA, Events, QuoteType, Sequence, is_end_of_tag_section, is_whitespace};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    Text,
    BeforeTagName,
    InTagName,
    InSelfClosingTag,
    BeforeClosingTagName,
    InClosingTagName,
    AfterClosingTagName,
    BeforeAttributeName,
    InAttributeName,
    AfterAttributeName,
    BeforeAttributeValue,
    InAttributeValueDq,
    InAttributeValueSq,
    InAttributeValueNq,
    BeforeDeclaration,
    InDeclaration,
    InProcessingInstruction,
    BeforeComment,
    CdataSequence,
    InSpecialComment,
    InCommentLike,
    BeforeSpecialS,
    BeforeSpecialT,
    SpecialStartSequence,
    InSpecialTag,
    InEntity,
}

pub struct Tokenizer<'a, E: Events> {
    buffer: &'a [u8],
    events: &'a mut E,
    state: State,
    section_start: i64,
    index: usize,
    entity_start: usize,
    base_state: State,
    is_special: bool,
    current_sequence: Option<Sequence>,
    sequence_index: usize,
    entity_decoder: EntityDecoder,
}

impl<'a, E: Events> Tokenizer<'a, E> {
    /// Tokenizes `input` completely, as `write(input)` followed by `end()`.
    pub fn run(input: &'a str, events: &'a mut E) {
        let mut tokenizer = Tokenizer {
            buffer: input.as_bytes(),
            events,
            state: State::Text,
            section_start: 0,
            index: 0,
            entity_start: 0,
            base_state: State::Text,
            is_special: false,
            current_sequence: None,
            sequence_index: 0,
            entity_decoder: EntityDecoder::new(),
        };
        tokenizer.parse();
        tokenizer.finish();
    }

    fn section(&self) -> usize {
        usize::try_from(self.section_start).unwrap_or(0)
    }

    fn state_text(&mut self, c: u8) {
        if c == b'<' {
            if self.index as i64 > self.section_start {
                self.events.text(self.section(), self.index);
            }
            self.state = State::BeforeTagName;
            self.section_start = self.index as i64;
        } else if c == b'&' {
            self.start_entity();
        }
    }

    fn state_special_start_sequence(&mut self, c: u8) {
        let sequence = self
            .current_sequence
            .expect("a special tag sets its sequence")
            .bytes();
        let is_end = self.sequence_index == sequence.len();
        let is_match = if is_end {
            is_end_of_tag_section(c)
        } else {
            c | 0x20 == sequence[self.sequence_index]
        };
        if !is_match {
            self.is_special = false;
        } else if !is_end {
            self.sequence_index += 1;
            return;
        }
        self.sequence_index = 0;
        self.state = State::InTagName;
        self.state_in_tag_name(c);
    }

    fn state_in_special_tag(&mut self, c: u8) {
        let sequence_kind = self
            .current_sequence
            .expect("a special tag sets its sequence");
        let sequence = sequence_kind.bytes();
        if self.sequence_index == sequence.len() {
            if c == b'>' || is_whitespace(c) {
                let end_of_text = self.index - sequence.len();
                if self.section_start < end_of_text as i64 {
                    // htmlparser2 spoofs the index while reporting the text; nothing here reads it.
                    self.events.text(self.section(), end_of_text);
                }
                self.is_special = false;
                self.section_start = end_of_text as i64 + 2;
                self.state_in_closing_tag_name(c);
                return;
            }
            self.sequence_index = 0;
        }
        if c | 0x20 == sequence[self.sequence_index] {
            self.sequence_index += 1;
        } else if self.sequence_index == 0 {
            if sequence_kind == Sequence::Title {
                if c == b'&' {
                    self.start_entity();
                }
            } else if self.fast_forward_to(b'<') {
                self.sequence_index = 1;
            }
        } else {
            self.sequence_index = usize::from(c == b'<');
        }
    }

    fn state_cdata_sequence(&mut self, c: u8) {
        if c == CDATA[self.sequence_index] {
            self.sequence_index += 1;
            if self.sequence_index == CDATA.len() {
                self.state = State::InCommentLike;
                self.current_sequence = Some(Sequence::Cdata);
                self.sequence_index = 0;
                self.section_start = self.index as i64 + 1;
            }
        } else {
            self.sequence_index = 0;
            self.state = State::InDeclaration;
            self.state_in_declaration(c);
        }
    }

    /// Skips ahead to the next `c`; leaves the index on the last byte when there is none.
    fn fast_forward_to(&mut self, c: u8) -> bool {
        loop {
            self.index += 1;
            if self.index >= self.buffer.len() {
                break;
            }
            if self.buffer[self.index] == c {
                return true;
            }
        }
        self.index = self.buffer.len() - 1;
        false
    }

    fn state_in_comment_like(&mut self, c: u8) {
        let sequence_kind = self
            .current_sequence
            .expect("comment-like sets its sequence");
        let sequence = sequence_kind.bytes();
        if c == sequence[self.sequence_index] {
            self.sequence_index += 1;
            if self.sequence_index == sequence.len() {
                if sequence_kind == Sequence::Cdata {
                    self.events.cdata(self.section(), self.index, 2);
                } else {
                    self.events.comment(self.section(), self.index, 2);
                }
                self.sequence_index = 0;
                self.section_start = self.index as i64 + 1;
                self.state = State::Text;
            }
        } else if self.sequence_index == 0 {
            if self.fast_forward_to(sequence[0]) {
                self.sequence_index = 1;
            }
        } else if c != sequence[self.sequence_index - 1] {
            self.sequence_index = 0;
        }
    }

    /// HTML only starts a tag name with an ASCII letter.
    fn is_tag_start_char(c: u8) -> bool {
        c.is_ascii_alphabetic()
    }

    fn start_special(&mut self, sequence: Sequence, offset: usize) {
        self.is_special = true;
        self.current_sequence = Some(sequence);
        self.sequence_index = offset;
        self.state = State::SpecialStartSequence;
    }

    fn state_before_tag_name(&mut self, c: u8) {
        if c == b'!' {
            self.state = State::BeforeDeclaration;
            self.section_start = self.index as i64 + 1;
        } else if c == b'?' {
            self.state = State::InProcessingInstruction;
            self.section_start = self.index as i64 + 1;
        } else if Self::is_tag_start_char(c) {
            let lower = c | 0x20;
            self.section_start = self.index as i64;
            self.state = if lower == b's' {
                State::BeforeSpecialS
            } else if lower == b't' || lower == b'x' {
                State::BeforeSpecialT
            } else {
                State::InTagName
            };
        } else if c == b'/' {
            self.state = State::BeforeClosingTagName;
        } else {
            self.state = State::Text;
            self.state_text(c);
        }
    }

    fn state_in_tag_name(&mut self, c: u8) {
        if is_end_of_tag_section(c) {
            self.events.open_tag_name(self.section(), self.index);
            self.section_start = -1;
            self.state = State::BeforeAttributeName;
            self.state_before_attribute_name(c);
        }
    }

    fn state_before_closing_tag_name(&mut self, c: u8) {
        if is_whitespace(c) {
            // Ignored.
        } else if c == b'>' {
            self.state = State::Text;
        } else {
            self.state = if Self::is_tag_start_char(c) {
                State::InClosingTagName
            } else {
                State::InSpecialComment
            };
            self.section_start = self.index as i64;
        }
    }

    fn state_in_closing_tag_name(&mut self, c: u8) {
        if c == b'>' || is_whitespace(c) {
            self.events.close_tag(self.section(), self.index);
            self.section_start = -1;
            self.state = State::AfterClosingTagName;
            self.state_after_closing_tag_name(c);
        }
    }

    fn state_after_closing_tag_name(&mut self, c: u8) {
        if c == b'>' || self.fast_forward_to(b'>') {
            self.state = State::Text;
            self.section_start = self.index as i64 + 1;
        }
    }

    fn state_before_attribute_name(&mut self, c: u8) {
        if c == b'>' {
            self.events.open_tag_end();
            if self.is_special {
                self.state = State::InSpecialTag;
                self.sequence_index = 0;
            } else {
                self.state = State::Text;
            }
            self.section_start = self.index as i64 + 1;
        } else if c == b'/' {
            self.state = State::InSelfClosingTag;
        } else if !is_whitespace(c) {
            self.state = State::InAttributeName;
            self.section_start = self.index as i64;
        }
    }

    fn state_in_self_closing_tag(&mut self, c: u8) {
        if c == b'>' {
            self.events.self_closing_tag();
            self.state = State::Text;
            self.section_start = self.index as i64 + 1;
            self.is_special = false;
        } else if !is_whitespace(c) {
            self.state = State::BeforeAttributeName;
            self.state_before_attribute_name(c);
        }
    }

    fn state_in_attribute_name(&mut self, c: u8) {
        if c == b'=' || is_end_of_tag_section(c) {
            self.events.attrib_name(self.section(), self.index);
            self.section_start = self.index as i64;
            self.state = State::AfterAttributeName;
            self.state_after_attribute_name(c);
        }
    }

    fn state_after_attribute_name(&mut self, c: u8) {
        if c == b'=' {
            self.state = State::BeforeAttributeValue;
        } else if c == b'/' || c == b'>' {
            self.events.attrib_end(QuoteType::NoValue);
            self.section_start = -1;
            self.state = State::BeforeAttributeName;
            self.state_before_attribute_name(c);
        } else if !is_whitespace(c) {
            self.events.attrib_end(QuoteType::NoValue);
            self.state = State::InAttributeName;
            self.section_start = self.index as i64;
        }
    }

    fn state_before_attribute_value(&mut self, c: u8) {
        if c == b'"' {
            self.state = State::InAttributeValueDq;
            self.section_start = self.index as i64 + 1;
        } else if c == b'\'' {
            self.state = State::InAttributeValueSq;
            self.section_start = self.index as i64 + 1;
        } else if !is_whitespace(c) {
            self.section_start = self.index as i64;
            self.state = State::InAttributeValueNq;
            self.state_in_attribute_value_no_quotes(c);
        }
    }

    fn handle_in_attribute_value(&mut self, c: u8, quote: u8) {
        if c == quote {
            self.events.attrib_data(self.section(), self.index);
            self.section_start = -1;
            self.events.attrib_end(if quote == b'"' {
                QuoteType::Double
            } else {
                QuoteType::Single
            });
            self.state = State::BeforeAttributeName;
        } else if c == b'&' {
            self.start_entity();
        }
    }

    fn state_in_attribute_value_no_quotes(&mut self, c: u8) {
        if is_whitespace(c) || c == b'>' {
            self.events.attrib_data(self.section(), self.index);
            self.section_start = -1;
            self.events.attrib_end(QuoteType::Unquoted);
            self.state = State::BeforeAttributeName;
            self.state_before_attribute_name(c);
        } else if c == b'&' {
            self.start_entity();
        }
    }

    fn state_before_declaration(&mut self, c: u8) {
        if c == b'[' {
            self.state = State::CdataSequence;
            self.sequence_index = 0;
        } else {
            self.state = if c == b'-' {
                State::BeforeComment
            } else {
                State::InDeclaration
            };
        }
    }

    fn state_in_declaration(&mut self, c: u8) {
        if c == b'>' || self.fast_forward_to(b'>') {
            self.events.declaration(self.section(), self.index);
            self.state = State::Text;
            self.section_start = self.index as i64 + 1;
        }
    }

    fn state_in_processing_instruction(&mut self, c: u8) {
        if c == b'>' || self.fast_forward_to(b'>') {
            self.events
                .processing_instruction(self.section(), self.index);
            self.state = State::Text;
            self.section_start = self.index as i64 + 1;
        }
    }

    fn state_before_comment(&mut self, c: u8) {
        if c == b'-' {
            self.state = State::InCommentLike;
            self.current_sequence = Some(Sequence::Comment);
            // Allows short comments such as `<!-->`.
            self.sequence_index = 2;
            self.section_start = self.index as i64 + 1;
        } else {
            self.state = State::InDeclaration;
        }
    }

    fn state_in_special_comment(&mut self, c: u8) {
        if c == b'>' || self.fast_forward_to(b'>') {
            self.events.comment(self.section(), self.index, 0);
            self.state = State::Text;
            self.section_start = self.index as i64 + 1;
        }
    }

    fn state_before_special_s(&mut self, c: u8) {
        let lower = c | 0x20;
        if lower == Sequence::Script.bytes()[3] {
            self.start_special(Sequence::Script, 4);
        } else if lower == Sequence::Style.bytes()[3] {
            self.start_special(Sequence::Style, 4);
        } else {
            self.state = State::InTagName;
            self.state_in_tag_name(c);
        }
    }

    fn state_before_special_t(&mut self, c: u8) {
        let lower = c | 0x20;
        if lower == Sequence::Title.bytes()[3] {
            self.start_special(Sequence::Title, 4);
        } else if lower == Sequence::Textarea.bytes()[3] {
            self.start_special(Sequence::Textarea, 4);
        } else if lower == Sequence::Xmp.bytes()[3] {
            self.start_special(Sequence::Xmp, 4);
        } else {
            self.state = State::InTagName;
            self.state_in_tag_name(c);
        }
    }

    fn cleanup(&mut self) {
        if self.section_start != self.index as i64 {
            if self.state == State::Text
                || (self.state == State::InSpecialTag && self.sequence_index == 0)
            {
                self.events.text(self.section(), self.index);
                self.section_start = self.index as i64;
            } else if matches!(
                self.state,
                State::InAttributeValueDq | State::InAttributeValueSq | State::InAttributeValueNq
            ) {
                self.events.attrib_data(self.section(), self.index);
                self.section_start = self.index as i64;
            }
        }
    }

    fn parse(&mut self) {
        while self.index < self.buffer.len() {
            let c = self.buffer[self.index];
            match self.state {
                State::Text => self.state_text(c),
                State::SpecialStartSequence => self.state_special_start_sequence(c),
                State::InSpecialTag => self.state_in_special_tag(c),
                State::CdataSequence => self.state_cdata_sequence(c),
                State::InAttributeValueDq => self.handle_in_attribute_value(c, b'"'),
                State::InAttributeName => self.state_in_attribute_name(c),
                State::InCommentLike => self.state_in_comment_like(c),
                State::InSpecialComment => self.state_in_special_comment(c),
                State::BeforeAttributeName => self.state_before_attribute_name(c),
                State::InTagName => self.state_in_tag_name(c),
                State::InClosingTagName => self.state_in_closing_tag_name(c),
                State::BeforeTagName => self.state_before_tag_name(c),
                State::AfterAttributeName => self.state_after_attribute_name(c),
                State::InAttributeValueSq => self.handle_in_attribute_value(c, b'\''),
                State::BeforeAttributeValue => self.state_before_attribute_value(c),
                State::BeforeClosingTagName => self.state_before_closing_tag_name(c),
                State::AfterClosingTagName => self.state_after_closing_tag_name(c),
                State::BeforeSpecialS => self.state_before_special_s(c),
                State::BeforeSpecialT => self.state_before_special_t(c),
                State::InAttributeValueNq => self.state_in_attribute_value_no_quotes(c),
                State::InSelfClosingTag => self.state_in_self_closing_tag(c),
                State::InDeclaration => self.state_in_declaration(c),
                State::BeforeDeclaration => self.state_before_declaration(c),
                State::BeforeComment => self.state_before_comment(c),
                State::InProcessingInstruction => self.state_in_processing_instruction(c),
                State::InEntity => self.state_in_entity(),
            }
            self.index += 1;
        }
        self.cleanup();
    }

    fn finish(&mut self) {
        if self.state == State::InEntity {
            self.entity_decoder.end();
            self.drain_entity_output();
            self.state = self.base_state;
        }
        self.handle_trailing_data();
        self.events.end();
    }

    fn handle_trailing_data(&mut self) {
        let end_index = self.buffer.len();
        if self.section_start >= end_index as i64 {
            return;
        }
        if self.state == State::InCommentLike {
            if self.current_sequence == Some(Sequence::Cdata) {
                self.events.cdata(self.section(), end_index, 0);
            } else {
                self.events.comment(self.section(), end_index, 0);
            }
        } else if matches!(
            self.state,
            State::InTagName
                | State::BeforeAttributeName
                | State::BeforeAttributeValue
                | State::AfterAttributeName
                | State::InAttributeName
                | State::InAttributeValueSq
                | State::InAttributeValueDq
                | State::InAttributeValueNq
                | State::InClosingTagName
        ) {
            // An unfinished tag is dropped.
        } else {
            // `sectionStart` is -1 after a tag name or a closing tag name. htmlparser2 then calls
            // `getSlice(-1, end)`, and `String.prototype.slice(-1)` counts from the end: the
            // trailing text is the last UTF-16 unit, not the whole document.
            if self.section_start < 0 {
                let mut start = end_index - 1;
                while self.buffer[start] & 0xc0 == 0x80 {
                    start -= 1;
                }
                if end_index - start == 4 {
                    // Half of a surrogate pair, which a Rust string cannot hold.
                    self.events.text_entity(0xfffd);
                } else {
                    self.events.text(start, end_index);
                }
            } else {
                self.events.text(self.section(), end_index);
            }
        }
    }
}
