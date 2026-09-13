//! The compression frame, chapter 04 §4.1.
//!
//! One leading flag byte, then the payload. The frame sits **inside** the
//! ciphertext in both envelopes (§4.2): compress then encrypt on write, decrypt
//! then decompress on read. There is no envelope-level compression field.

use std::io::{Read as _, Write as _};

use flate2::Compression;
use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;

use crate::api::errors::CompressError;

/// Flag `0x00`: the plaintext follows verbatim.
pub const FLAG_STORED: u8 = 0x00;
/// Flag `0x01`: a zlib-wrapped DEFLATE stream, RFC 1950, follows.
pub const FLAG_ZLIB: u8 = 0x01;

/// A payload of strictly fewer than 64 bytes is always stored (§4.1).
pub const STORED_THRESHOLD_BYTES: usize = 64;

/// Frames a payload for the wire, chapter 04 §4.1.
///
/// Two writer rules, both load-bearing for byte identity with the reference:
///
/// - **strictly fewer than 64 bytes is always stored**, so a writer that
///   compresses a 60-byte payload produces a different envelope for the same
///   input;
/// - a compressed result whose length is **greater than or equal to** the input
///   is discarded in favour of stored. The comparison is `>=`, not `>`.
///
/// The output is a zlib wrapper (`78 9c` at the default level), never gzip and
/// never headerless raw DEFLATE.
pub fn compress(payload: &[u8]) -> Vec<u8> {
    if payload.len() < STORED_THRESHOLD_BYTES {
        return store(payload);
    }

    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    // A `Vec` writer cannot fail, so neither call can error in practice; a
    // failure is still answered by storing rather than by losing the payload.
    if encoder.write_all(payload).is_err() {
        return store(payload);
    }
    let Ok(deflated) = encoder.finish() else {
        return store(payload);
    };

    if deflated.len() >= payload.len() {
        return store(payload);
    }

    let mut framed = Vec::with_capacity(deflated.len() + 1);
    framed.push(FLAG_ZLIB);
    framed.extend_from_slice(&deflated);
    framed
}

fn store(payload: &[u8]) -> Vec<u8> {
    let mut framed = Vec::with_capacity(payload.len() + 1);
    framed.push(FLAG_STORED);
    framed.extend_from_slice(payload);
    framed
}

/// Unframes a payload, chapter 04 §4.1.
///
/// Three reader rules:
///
/// - **any** flag other than `0x01` is stored; there is no unknown-flag
///   rejection;
/// - an empty input is returned as-is, with no flag consumed;
/// - a `0x01` frame whose stream is truncated is a **hard error**, never an
///   empty decode. The reference's `pako.inflate` returns `undefined` rather
///   than throwing for a stream that never reaches `Z_STREAM_END`, and handing
///   that back under a byte-array return type turns a truncated body into a
///   successful decrypt of an empty item, which the applier writes as a content
///   wipe.
pub fn decompress(frame: &[u8]) -> Result<Vec<u8>, CompressError> {
    if frame.is_empty() {
        return Ok(Vec::new());
    }
    if frame[0] != FLAG_ZLIB {
        return Ok(frame[1..].to_vec());
    }

    let mut decoder = ZlibDecoder::new(&frame[1..]);
    let mut out = Vec::new();
    match decoder.read_to_end(&mut out) {
        Ok(_) => Ok(out),
        // `flate2` reports a stream that ends before `Z_STREAM_END` as an
        // unexpected EOF. That is the truncation case the reference names, and
        // it is the one that must never degrade to an empty buffer.
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
            Err(CompressError::IncompleteDeflateStream)
        }
        Err(error) => Err(CompressError::Corrupt {
            what: error.to_string(),
        }),
    }
}
