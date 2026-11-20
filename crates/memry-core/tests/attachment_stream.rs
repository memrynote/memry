//! The streamed framing (#3535) equals the in-memory one byte for byte: the
//! chunks, their addresses and the manifest, at the chunk boundaries.

use std::io::{self, Read};

use memry_core::protocol::attachment_stream::{ChunkFramer, StreamError, build_manifest_from};
use memry_core::protocol::attachment_upload::{
    DEFAULT_CHUNK_SIZE, FramedChunk, MAX_CHUNKS_PER_SESSION, build_manifest, encrypted_size,
    frame_chunks,
};
use memry_core::protocol::attachments::AttachmentError;

const FILE_KEY: [u8; 32] = [7; 32];
const MIB: usize = 1024 * 1024;

fn nonce(index: u32) -> Vec<u8> {
    let mut nonce = vec![0x5a; 24];
    nonce[..4].copy_from_slice(&index.to_le_bytes());
    nonce
}

fn plaintext(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i * 31 % 251) as u8).collect()
}

/// Answers with short reads and one interruption, which must not move a chunk
/// boundary.
struct ShortReads<'a> {
    bytes: &'a [u8],
    interrupted: bool,
}

impl Read for ShortReads<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if !self.interrupted {
            self.interrupted = true;
            return Err(io::ErrorKind::Interrupted.into());
        }
        let len = buf.len().min(self.bytes.len()).min(4093);
        buf[..len].copy_from_slice(&self.bytes[..len]);
        self.bytes = &self.bytes[len..];
        Ok(len)
    }
}

fn stream(
    bytes: &[u8],
    chunk_size: usize,
) -> (
    Vec<FramedChunk>,
    memry_core::protocol::attachment_stream::FramerSummary,
) {
    let reader = ShortReads {
        bytes,
        interrupted: false,
    };
    let mut framer = ChunkFramer::new(reader, &FILE_KEY, chunk_size, nonce);
    let mut chunks = Vec::new();
    while let Some(chunk) = framer.next_chunk().expect("frame") {
        chunks.push(chunk);
    }
    let summary = framer.into_summary().expect("read to the end");
    (chunks, summary)
}

#[test]
fn streamed_framing_equals_in_memory_at_every_boundary() {
    for len in [
        0,
        1,
        DEFAULT_CHUNK_SIZE - 1,
        DEFAULT_CHUNK_SIZE,
        DEFAULT_CHUNK_SIZE + 1,
        20 * MIB,
    ] {
        let bytes = plaintext(len);
        let expected = frame_chunks(&bytes, &FILE_KEY, DEFAULT_CHUNK_SIZE, nonce).expect("frame");
        let (chunks, summary) = stream(&bytes, DEFAULT_CHUNK_SIZE);

        assert_eq!(chunks, expected, "chunks of a {len}-byte file");
        assert_eq!(summary.encrypted_size, encrypted_size(&expected));
        assert_eq!(
            build_manifest_from(&summary, "att", "f.bin", "application/octet-stream", 42),
            build_manifest(
                "att",
                "f.bin",
                "application/octet-stream",
                &bytes,
                &expected,
                DEFAULT_CHUNK_SIZE,
                42,
            ),
            "manifest of a {len}-byte file",
        );
    }
}

#[test]
fn the_session_cap_is_reached_on_the_chunk_past_it() {
    let at_cap = plaintext(MAX_CHUNKS_PER_SESSION);
    let (chunks, _) = stream(&at_cap, 1);
    assert_eq!(chunks.len(), MAX_CHUNKS_PER_SESSION);

    let past_cap = plaintext(MAX_CHUNKS_PER_SESSION + 1);
    let mut framer = ChunkFramer::new(past_cap.as_slice(), &FILE_KEY, 1, nonce);
    for _ in 0..MAX_CHUNKS_PER_SESSION {
        framer
            .next_chunk()
            .expect("under the cap")
            .expect("a chunk");
    }
    assert!(matches!(
        framer.next_chunk(),
        Err(StreamError::Attachment(AttachmentError::TooManyChunks { cap, .. }))
            if cap == MAX_CHUNKS_PER_SESSION
    ));
    assert!(
        framer.into_summary().is_none(),
        "a refused file has no manifest"
    );
}

#[test]
fn a_summary_never_describes_part_of_a_file() {
    let bytes = plaintext(10);
    let mut framer = ChunkFramer::new(bytes.as_slice(), &FILE_KEY, 4, nonce);
    framer.next_chunk().expect("frame").expect("a chunk");
    assert!(framer.into_summary().is_none());
}

#[test]
fn a_read_error_reaches_the_caller() {
    struct Broken;
    impl Read for Broken {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::ErrorKind::PermissionDenied.into())
        }
    }
    let mut framer = ChunkFramer::new(Broken, &FILE_KEY, 4, nonce);
    assert!(
        matches!(framer.next_chunk(), Err(StreamError::Io(error)) if error.kind() == io::ErrorKind::PermissionDenied)
    );
}

#[test]
fn a_zero_chunk_size_is_refused_by_both_framers() {
    let bytes = plaintext(10);
    assert!(matches!(
        frame_chunks(&bytes, &FILE_KEY, 0, nonce),
        Err(AttachmentError::ZeroChunkSize)
    ));
    let mut framer = ChunkFramer::new(bytes.as_slice(), &FILE_KEY, 0, nonce);
    assert!(matches!(
        framer.next_chunk(),
        Err(StreamError::Attachment(AttachmentError::ZeroChunkSize))
    ));
    assert!(framer.into_summary().is_none());
}

/// A failed framer never answers `None`, which a caller reads as the end of
/// the file.
#[test]
fn a_failed_framer_keeps_returning_its_error() {
    struct Broken;
    impl Read for Broken {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::ErrorKind::PermissionDenied.into())
        }
    }
    let mut framer = ChunkFramer::new(Broken, &FILE_KEY, 4, nonce);
    for _ in 0..2 {
        assert!(
            matches!(framer.next_chunk(), Err(StreamError::Io(error)) if error.kind() == io::ErrorKind::PermissionDenied)
        );
    }

    let bytes = plaintext(10);
    let mut framer = ChunkFramer::new(bytes.as_slice(), &[0; 3], 4, nonce);
    for _ in 0..2 {
        assert!(matches!(
            framer.next_chunk(),
            Err(StreamError::Attachment(AttachmentError::Undecryptable))
        ));
    }
    assert!(framer.into_summary().is_none());

    let past_cap = plaintext(MAX_CHUNKS_PER_SESSION + 1);
    let mut framer = ChunkFramer::new(past_cap.as_slice(), &FILE_KEY, 1, nonce);
    while let Ok(Some(_)) = framer.next_chunk() {}
    assert!(matches!(
        framer.next_chunk(),
        Err(StreamError::Attachment(AttachmentError::TooManyChunks { cap, .. }))
            if cap == MAX_CHUNKS_PER_SESSION
    ));
}
