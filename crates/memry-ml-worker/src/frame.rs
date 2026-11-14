//! One frame on the worker's stdin or stdout: a 4-byte big-endian length, then that many bytes,
//! which are a one-byte op code, a big-endian `u32` request id and the op's payload.
//!
//! Both ends read the other's frames as untrusted: the app reads a worker that may be running a
//! hostile PDF, and the worker reads whatever reaches its stdin. A header past [`MAX_FRAME_LEN`]
//! is refused before a byte of its body is read or allocated. The protocol is internal to one
//! build (the app and its bundled worker ship together), so it has no version byte.

use std::io::{self, Read, Write};

/// The largest body a frame may declare. A page rendered at the largest edge the worker accepts
/// (`op::MAX_RENDER_EDGE`) is at most 64 MiB of RGBA, and its PNG stays under this.
pub const MAX_FRAME_LEN: u32 = 80 << 20;
/// The op code and the request id.
pub const HEADER_LEN: u32 = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub op: u8,
    pub id: u32,
    pub payload: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("frame of {0} bytes is over the {MAX_FRAME_LEN}-byte cap")]
    TooLarge(u64),
    #[error("frame of {0} bytes is shorter than its header")]
    TooShort(u32),
    #[error("the stream ended inside a frame")]
    Truncated,
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// The next frame, or `None` when the stream ends cleanly between frames.
pub fn read_frame(reader: &mut impl Read) -> Result<Option<Frame>, FrameError> {
    let mut len = [0u8; 4];
    match read_full(reader, &mut len)? {
        0 => return Ok(None),
        4 => {}
        _ => return Err(FrameError::Truncated),
    }
    let len = u32::from_be_bytes(len);
    if len > MAX_FRAME_LEN {
        return Err(FrameError::TooLarge(u64::from(len)));
    }
    if len < HEADER_LEN {
        return Err(FrameError::TooShort(len));
    }
    let mut head = [0u8; HEADER_LEN as usize];
    if read_full(reader, &mut head)? != head.len() {
        return Err(FrameError::Truncated);
    }
    // `take` grows the buffer as bytes arrive, so a header that lies about its length costs
    // what the peer actually sent, never what it declared.
    let body = u64::from(len - HEADER_LEN);
    let mut payload = Vec::new();
    reader.take(body).read_to_end(&mut payload)?;
    if payload.len() as u64 != body {
        return Err(FrameError::Truncated);
    }
    Ok(Some(Frame {
        op: head[0],
        id: u32::from_be_bytes([head[1], head[2], head[3], head[4]]),
        payload,
    }))
}

/// Writes `frame` and flushes. A frame past the cap is refused, so the peer never sees one.
pub fn write_frame(writer: &mut impl Write, frame: &Frame) -> Result<(), FrameError> {
    let len = u64::from(HEADER_LEN) + frame.payload.len() as u64;
    if len > u64::from(MAX_FRAME_LEN) {
        return Err(FrameError::TooLarge(len));
    }
    let mut head = Vec::with_capacity(9);
    head.extend_from_slice(&(len as u32).to_be_bytes());
    head.push(frame.op);
    head.extend_from_slice(&frame.id.to_be_bytes());
    writer.write_all(&head)?;
    writer.write_all(&frame.payload)?;
    writer.flush()?;
    Ok(())
}

/// Reads until `buf` is full or the stream ends; the count read.
fn read_full(reader: &mut impl Read, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(filled)
}
