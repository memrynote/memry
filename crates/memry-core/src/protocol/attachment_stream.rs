//! Framing an attachment from a reader, chapter 14 §14.2 and §14.4 (#3535).
//!
//! [`super::attachment_upload::frame_chunks`] frames a file held in memory. A
//! desktop attachment can be 500 MiB, so the upload reads it one chunk at a
//! time instead: [`ChunkFramer`] pulls at most `chunk_size` bytes, frames them
//! and hands the chunk back, and keeps a running SHA-256 of the plaintext for
//! the manifest's `checksum`. Its output is byte-identical to `frame_chunks`
//! plus `build_manifest`: both frame each chunk through [`frame_one`].
//!
//! Every chunk but the last is exactly `chunk_size` bytes, because the reader
//! is read until the buffer is full or the file ends; a reader that answers
//! with short reads cannot change where the chunks split.

use std::io::{self, ErrorKind, Read};

use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::protocol::attachment_manifest::{AttachmentChunkRef, AttachmentManifest};
use crate::protocol::attachment_upload::{FramedChunk, MAX_CHUNKS_PER_SESSION};
use crate::protocol::attachments::{AttachmentError, hex_sha256};

/// Frames one plaintext chunk: `nonce ‖ ciphertext`, addressed by the hash of
/// that framed ciphertext, with the plaintext hash the reader checks (§14.3).
pub(crate) fn frame_one(
    index: u32,
    plaintext: &[u8],
    file_key: &[u8],
    nonce: Vec<u8>,
) -> Result<FramedChunk, AttachmentError> {
    let ciphertext = crate::crypto::sodium::aead_encrypt(plaintext, None, &nonce, file_key)
        .map_err(|_| AttachmentError::Undecryptable)?;
    let mut framed = nonce;
    framed.extend_from_slice(&ciphertext);
    Ok(FramedChunk {
        index,
        reference: AttachmentChunkRef {
            index,
            // The PLAINTEXT hash: the reader's integrity check after decrypt.
            hash: hex_sha256(plaintext),
            // The FRAMED CIPHERTEXT hash: how R2 addresses it. Swapping these
            // two produces a file that uploads cleanly and fails every reader.
            encrypted_hash: hex_sha256(&framed),
            size: plaintext.len() as u64,
        },
        framed,
    })
}

/// A framing step failed: the reader, or the framing itself.
#[derive(Debug, thiserror::Error)]
pub enum StreamError {
    #[error("reading the attachment failed: {0}")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Attachment(#[from] AttachmentError),
}

/// What a fully read file framed to, for its manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FramerSummary {
    /// Plaintext bytes read.
    pub size: u64,
    /// Hex SHA-256 of the whole plaintext.
    pub checksum: String,
    pub chunks: Vec<AttachmentChunkRef>,
    pub chunk_size: u64,
    /// Ciphertext bytes the chunks put on the wire, which quota is reserved
    /// against (§14.8).
    pub encrypted_size: u64,
}

/// Reads a file chunk by chunk and frames each chunk (§14.2).
///
/// `nonce_for` supplies each chunk's 24-byte nonce, as in `frame_chunks`.
pub struct ChunkFramer<R, N> {
    reader: R,
    file_key: Zeroizing<Vec<u8>>,
    nonce_for: N,
    buffer: Vec<u8>,
    whole: Sha256,
    size: u64,
    encrypted_size: u64,
    chunks: Vec<AttachmentChunkRef>,
    state: State,
}

#[derive(Debug)]
enum State {
    Reading,
    /// The last chunk went out; the next call answers `None`.
    Last,
    /// `None` was answered: the summary is whole.
    Done,
    /// A read or a frame failed: every later call answers this error again,
    /// never `None`, which a caller would read as the end of the file. No
    /// summary, ever.
    Failed(StreamError),
}

/// The framer's failure once more. `io::Error` is not `Clone`, so it is
/// rebuilt with its kind and message; the framing failures carry no more.
fn again(error: &StreamError) -> StreamError {
    match error {
        StreamError::Io(error) => io::Error::new(error.kind(), error.to_string()).into(),
        StreamError::Attachment(AttachmentError::TooManyChunks { chunks, cap }) => {
            AttachmentError::TooManyChunks {
                chunks: *chunks,
                cap: *cap,
            }
            .into()
        }
        StreamError::Attachment(AttachmentError::ZeroChunkSize) => {
            AttachmentError::ZeroChunkSize.into()
        }
        StreamError::Attachment(AttachmentError::Undecryptable) => {
            AttachmentError::Undecryptable.into()
        }
        // Download failures: framing never produces them. Listed so a new
        // variant has to choose its repeat here.
        StreamError::Attachment(
            AttachmentError::Api(_)
            | AttachmentError::Manifest(_)
            | AttachmentError::UnresolvableSigner { .. }
            | AttachmentError::ChunkTooShort { .. }
            | AttachmentError::ChunkHashMismatch { .. }
            | AttachmentError::ChunkSizeMismatch { .. }
            | AttachmentError::ChecksumMismatch
            | AttachmentError::MissingChunk { .. },
        ) => AttachmentError::Undecryptable.into(),
    }
}

impl<R: Read, N: FnMut(u32) -> Vec<u8>> ChunkFramer<R, N> {
    /// A `chunk_size` of zero frames nothing: the first call answers
    /// [`AttachmentError::ZeroChunkSize`], as `frame_chunks` does.
    pub fn new(reader: R, file_key: &[u8], chunk_size: usize, nonce_for: N) -> Self {
        let state = if chunk_size == 0 {
            State::Failed(AttachmentError::ZeroChunkSize.into())
        } else {
            State::Reading
        };
        Self {
            reader,
            file_key: Zeroizing::new(file_key.to_vec()),
            nonce_for,
            buffer: vec![0; chunk_size],
            whole: Sha256::new(),
            size: 0,
            encrypted_size: 0,
            chunks: Vec::new(),
            state,
        }
    }

    /// The next framed chunk, or `None` once the file has ended.
    ///
    /// An empty file is one empty chunk, as in `frame_chunks`: a manifest with
    /// no chunks has nothing to address.
    ///
    /// A file past [`MAX_CHUNKS_PER_SESSION`] fails only once the chunk past
    /// the cap is read, and its `chunks` count is a lower bound (always cap +
    /// 1). Callers compare the file size with cap × `chunk_size` before the
    /// first read (desktop `attachments.ts:434`).
    pub fn next_chunk(&mut self) -> Result<Option<FramedChunk>, StreamError> {
        match &self.state {
            State::Reading => {}
            State::Last => {
                self.state = State::Done;
                return Ok(None);
            }
            State::Done => return Ok(None),
            State::Failed(error) => return Err(again(error)),
        }
        match self.frame_next() {
            Ok(chunk) => Ok(chunk),
            Err(error) => {
                self.state = State::Failed(again(&error));
                Err(error)
            }
        }
    }

    fn frame_next(&mut self) -> Result<Option<FramedChunk>, StreamError> {
        let filled = self.fill()?;
        if filled == 0 && !self.chunks.is_empty() {
            self.state = State::Done;
            return Ok(None);
        }
        let index = self.chunks.len();
        if index >= MAX_CHUNKS_PER_SESSION {
            return Err(AttachmentError::TooManyChunks {
                chunks: index + 1,
                cap: MAX_CHUNKS_PER_SESSION,
            }
            .into());
        }
        let index = index as u32;
        let plaintext = &self.buffer[..filled];
        let chunk = frame_one(index, plaintext, &self.file_key, (self.nonce_for)(index))?;
        if filled < self.buffer.len() {
            self.state = State::Last;
        }
        self.whole.update(plaintext);
        self.size += filled as u64;
        self.encrypted_size += chunk.framed.len() as u64;
        self.chunks.push(chunk.reference.clone());
        Ok(Some(chunk))
    }

    /// The manifest figures, once [`Self::next_chunk`] has returned `None`.
    /// `None` while the file has not been read to its end, so a summary can
    /// never describe part of a file.
    pub fn into_summary(self) -> Option<FramerSummary> {
        if !matches!(self.state, State::Done) {
            return None;
        }
        Some(FramerSummary {
            size: self.size,
            checksum: hex::encode(self.whole.finalize()),
            chunks: self.chunks,
            chunk_size: self.buffer.len() as u64,
            encrypted_size: self.encrypted_size,
        })
    }

    /// Reads until the buffer is full or the reader ends.
    fn fill(&mut self) -> std::io::Result<usize> {
        let mut filled = 0;
        while filled < self.buffer.len() {
            match self.reader.read(&mut self.buffer[filled..]) {
                Ok(0) => break,
                Ok(read) => filled += read,
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(error) => return Err(error),
            }
        }
        Ok(filled)
    }
}

/// The manifest of a streamed file (§14.4), equal to `build_manifest` over the
/// same bytes.
pub fn build_manifest_from(
    summary: &FramerSummary,
    attachment_id: &str,
    filename: &str,
    mime_type: &str,
    created_at: i64,
) -> AttachmentManifest {
    AttachmentManifest {
        id: attachment_id.to_owned(),
        filename: filename.to_owned(),
        mime_type: mime_type.to_owned(),
        size: summary.size,
        checksum: summary.checksum.clone(),
        chunks: summary.chunks.clone(),
        chunk_size: summary.chunk_size,
        created_at,
    }
}
