//! Line framing of a streamed chat reply: server-sent events (`data:` lines, the
//! OpenAI-compatible `/chat/completions` stream the AI SDK's `createEventSourceResponseHandler`
//! reads) and NDJSON (one JSON object per line, Ollama's `/api/chat`).

/// The longest line or event a provider may send. A longer one fails the step instead of growing
/// the buffer without end.
pub const LINE_CAP: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    /// The payload of one event or line.
    Data(String),
    /// The SSE `data: [DONE]` sentinel.
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("the provider sent a streamed line over {LINE_CAP} bytes")]
pub struct LineTooLong;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Framing {
    Sse,
    Ndjson,
}

/// Turns the body's byte chunks into frames, whatever the chunk boundaries. A line is decoded
/// only once it is whole, so a character split across chunks survives.
pub struct LineDecoder {
    framing: Framing,
    line: Vec<u8>,
    /// The `data:` lines of the SSE event being read, joined with `\n`.
    event: Option<String>,
}

impl LineDecoder {
    pub fn sse() -> Self {
        Self::new(Framing::Sse)
    }

    pub fn ndjson() -> Self {
        Self::new(Framing::Ndjson)
    }

    fn new(framing: Framing) -> Self {
        Self {
            framing,
            line: Vec::new(),
            event: None,
        }
    }

    pub fn push(&mut self, mut bytes: &[u8]) -> Result<Vec<Frame>, LineTooLong> {
        let mut frames = Vec::new();
        while let Some(end) = memchr::memchr(b'\n', bytes) {
            self.extend(&bytes[..end])?;
            let line = std::mem::take(&mut self.line);
            self.line_done(&line, &mut frames)?;
            bytes = &bytes[end + 1..];
        }
        self.extend(bytes)?;
        Ok(frames)
    }

    /// The body ended: a last line without its newline and an event without its blank line
    /// still count.
    pub fn finish(&mut self) -> Result<Vec<Frame>, LineTooLong> {
        let mut frames = Vec::new();
        let line = std::mem::take(&mut self.line);
        if !line.is_empty() {
            self.line_done(&line, &mut frames)?;
        }
        self.dispatch(&mut frames);
        Ok(frames)
    }

    fn extend(&mut self, bytes: &[u8]) -> Result<(), LineTooLong> {
        if self.line.len() + bytes.len() > LINE_CAP {
            return Err(LineTooLong);
        }
        self.line.extend_from_slice(bytes);
        Ok(())
    }

    fn line_done(&mut self, line: &[u8], frames: &mut Vec<Frame>) -> Result<(), LineTooLong> {
        let line = String::from_utf8_lossy(line.strip_suffix(b"\r").unwrap_or(line));
        match self.framing {
            Framing::Ndjson => {
                let line = line.trim();
                if !line.is_empty() {
                    frames.push(Frame::Data(line.to_owned()));
                }
            }
            Framing::Sse => {
                if line.is_empty() {
                    self.dispatch(frames);
                } else if let Some(value) = line.strip_prefix("data:") {
                    let value = value.strip_prefix(' ').unwrap_or(value);
                    let event = self.event.get_or_insert_with(String::new);
                    if event.len() + value.len() + 1 > LINE_CAP {
                        return Err(LineTooLong);
                    }
                    if !event.is_empty() {
                        event.push('\n');
                    }
                    event.push_str(value);
                }
                // Comments (`:`) and the `event`, `id` and `retry` fields carry nothing a chat
                // reply needs.
            }
        }
        Ok(())
    }

    fn dispatch(&mut self, frames: &mut Vec<Frame>) {
        if let Some(data) = self.event.take() {
            frames.push(if data == "[DONE]" {
                Frame::Done
            } else {
                Frame::Data(data)
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    fn decode(mut decoder: LineDecoder, chunks: &[&[u8]]) -> Vec<Frame> {
        let mut frames = Vec::new();
        for chunk in chunks {
            frames.extend(decoder.push(chunk).unwrap());
        }
        frames.extend(decoder.finish().unwrap());
        frames
    }

    #[test]
    fn sse_events_comments_crlf_and_a_done_without_its_newline() {
        let body = b": keep-alive\r\ndata: {\"a\":1}\r\n\r\nevent: x\ndata: [DONE]";
        assert_eq!(
            decode(LineDecoder::sse(), &[body]),
            vec![Frame::Data("{\"a\":1}".into()), Frame::Done]
        );
    }

    #[test]
    fn ndjson_lines_skip_blank_ones() {
        let body = b"{\"a\":1}\n\n{\"b\":2}";
        assert_eq!(
            decode(LineDecoder::ndjson(), &[body]),
            vec![
                Frame::Data("{\"a\":1}".into()),
                Frame::Data("{\"b\":2}".into())
            ]
        );
    }

    #[test]
    fn a_line_over_the_cap_fails_instead_of_growing() {
        let mut decoder = LineDecoder::sse();
        let half = vec![b'x'; LINE_CAP / 2 + 1];
        assert!(decoder.push(&half).is_ok());
        assert_eq!(decoder.push(&half), Err(LineTooLong));
    }

    proptest! {
        #![proptest_config(memry_test_kit::proptest_config(256))]

        /// Where the body is cut into chunks never changes the frames, multi-byte text included.
        #[test]
        fn chunk_boundaries_do_not_change_the_frames(cuts in proptest::collection::vec(0usize..200, 0..12)) {
            let body = "data: {\"t\":\"héllo ✓\"}\n\ndata: {\"t\":\"two\"}\r\n\r\ndata: [DONE]\n\n".as_bytes();
            let whole = decode(LineDecoder::sse(), &[body]);
            let mut cuts: Vec<usize> = cuts.into_iter().map(|cut| cut % (body.len() + 1)).collect();
            cuts.sort_unstable();
            let mut chunks = Vec::new();
            let mut start = 0;
            for cut in cuts {
                chunks.push(&body[start..cut]);
                start = cut;
            }
            chunks.push(&body[start..]);
            prop_assert_eq!(decode(LineDecoder::sse(), &chunks), whole);
        }
    }
}
