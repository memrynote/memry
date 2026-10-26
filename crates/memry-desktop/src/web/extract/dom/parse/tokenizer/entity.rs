//! Entity handling of the tokenizer: the `EntityDecoder` hand-off of htmlparser2's
//! `startEntity`, `stateInEntity` and `emitCodePoint`.

use super::{DecodingMode, Events, State, Tokenizer};

impl<E: Events> Tokenizer<'_, E> {
    pub(super) fn start_entity(&mut self) {
        self.base_state = self.state;
        self.state = State::InEntity;
        self.entity_start = self.index;
        self.entity_decoder.start_entity(
            if matches!(self.base_state, State::Text | State::InSpecialTag) {
                DecodingMode::Legacy
            } else {
                DecodingMode::Attribute
            },
        );
    }

    pub(super) fn state_in_entity(&mut self) {
        let length = self.entity_decoder.write(self.buffer, self.index);
        self.drain_entity_output();
        if length >= 0 {
            self.state = self.base_state;
            if length == 0 {
                self.index -= 1;
            }
        } else {
            if self.index < self.buffer.len() && self.buffer[self.index] == b'&' {
                self.state = self.base_state;
                self.index -= 1;
                return;
            }
            self.index = self.buffer.len() - 1;
        }
    }

    pub(super) fn drain_entity_output(&mut self) {
        for (code_point, consumed) in self.entity_decoder.take_output() {
            self.emit_code_point(code_point, consumed);
        }
    }

    fn emit_code_point(&mut self, code_point: u32, consumed: usize) {
        if !matches!(self.base_state, State::Text | State::InSpecialTag) {
            if self.section_start < self.entity_start as i64 {
                self.events.attrib_data(self.section(), self.entity_start);
            }
            self.section_start = (self.entity_start + consumed) as i64;
            self.index = self.entity_start + consumed - 1;
            self.events.attrib_entity(code_point);
        } else {
            if self.section_start < self.entity_start as i64 {
                self.events.text(self.section(), self.entity_start);
            }
            self.section_start = (self.entity_start + consumed) as i64;
            self.index = self.entity_start + consumed - 1;
            self.events.text_entity(code_point);
        }
    }
}
