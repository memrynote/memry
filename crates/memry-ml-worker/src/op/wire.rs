//! The payload codec of [`super`]: big-endian `u32`s, length-prefixed UTF-8 strings, and a reader
//! that refuses a short payload or a field over its cap before it copies a byte.

use super::OpError;

pub(super) fn put_u32s(out: &mut Vec<u8>, values: &[u32]) {
    for value in values {
        out.extend_from_slice(&value.to_be_bytes());
    }
}

/// The longest prefix of `text` of at most `max` bytes that ends on a character boundary.
pub(super) fn cut(text: &str, max: usize) -> &str {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

pub(super) fn put_str(out: &mut Vec<u8>, value: &str) {
    // A frame body is capped far below `u32::MAX`; `write_frame` refuses a longer one.
    put_u32s(out, &[u32::try_from(value.len()).unwrap_or(u32::MAX)]);
    out.extend_from_slice(value.as_bytes());
}

pub(super) struct Reader<'a> {
    rest: &'a [u8],
    op: u8,
}

impl<'a> Reader<'a> {
    pub(super) fn new(payload: &'a [u8], op: u8) -> Self {
        Self { rest: payload, op }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], OpError> {
        if self.rest.len() < n {
            return Err(OpError::Malformed(self.op));
        }
        let (head, tail) = self.rest.split_at(n);
        self.rest = tail;
        Ok(head)
    }

    pub(super) fn u32(&mut self) -> Result<u32, OpError> {
        let bytes = self.take(4)?;
        Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    pub(super) fn u64(&mut self) -> Result<u64, OpError> {
        Ok((u64::from(self.u32()?) << 32) | u64::from(self.u32()?))
    }

    pub(super) fn string(&mut self) -> Result<String, OpError> {
        self.string_within(usize::MAX)
    }

    /// A string of at most `cap` bytes; a longer one is refused before it is copied.
    pub(super) fn string_within(&mut self, cap: usize) -> Result<String, OpError> {
        let len = self.u32()? as usize;
        if len > cap {
            return Err(OpError::TooLarge(self.op));
        }
        let bytes = self.take(len)?;
        String::from_utf8(bytes.to_vec()).map_err(|_| OpError::Malformed(self.op))
    }

    pub(super) fn rest(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.rest).to_vec()
    }

    /// The rest of the payload, refused before it is copied when it is over `cap` bytes.
    pub(super) fn rest_within(&mut self, cap: usize) -> Result<Vec<u8>, OpError> {
        if self.rest.len() > cap {
            return Err(OpError::TooLarge(self.op));
        }
        Ok(self.rest())
    }

    pub(super) fn end(&self) -> Result<(), OpError> {
        if self.rest.is_empty() {
            Ok(())
        } else {
            Err(OpError::Malformed(self.op))
        }
    }
}
