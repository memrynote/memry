//! Tokenizer events and the byte classes the tokenizer branches on.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum QuoteType {
    NoValue,
    Unquoted,
    Single,
    Double,
}

/// Closing sequences the tokenizer looks for while inside a comment, CDATA section or special tag.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Sequence {
    Cdata,
    Comment,
    Script,
    Style,
    Title,
    Textarea,
    Xmp,
}

impl Sequence {
    pub fn bytes(self) -> &'static [u8] {
        match self {
            Sequence::Cdata => b"]]>",
            Sequence::Comment => b"-->",
            Sequence::Script => b"</script",
            Sequence::Style => b"</style",
            Sequence::Title => b"</title",
            Sequence::Textarea => b"</textarea",
            Sequence::Xmp => b"</xmp",
        }
    }
}

pub const CDATA: &[u8] = b"CDATA[";

/// The tokenizer's output. Every range indexes the input that was passed to [`Tokenizer::run`].
pub trait Events {
    fn text(&mut self, start: usize, end: usize);
    fn text_entity(&mut self, code_point: u32);
    fn open_tag_name(&mut self, start: usize, end: usize);
    fn open_tag_end(&mut self);
    fn close_tag(&mut self, start: usize, end: usize);
    fn self_closing_tag(&mut self);
    fn attrib_name(&mut self, start: usize, end: usize);
    fn attrib_data(&mut self, start: usize, end: usize);
    fn attrib_entity(&mut self, code_point: u32);
    fn attrib_end(&mut self, quote: QuoteType);
    fn declaration(&mut self, start: usize, end: usize);
    fn processing_instruction(&mut self, start: usize, end: usize);
    fn comment(&mut self, start: usize, end: usize, offset: usize);
    fn cdata(&mut self, start: usize, end: usize, offset: usize);
    fn end(&mut self);
}

pub fn is_whitespace(c: u8) -> bool {
    matches!(c, b' ' | b'\n' | b'\t' | 0x0c | b'\r')
}

pub fn is_end_of_tag_section(c: u8) -> bool {
    c == b'/' || c == b'>' || is_whitespace(c)
}
