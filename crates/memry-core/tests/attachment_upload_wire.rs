//! The attachment **upload** path over a scripted transport (R06).
//!
//! The unit tests beside `protocol::attachment_upload` cover the byte work —
//! the framing, the two hashes, the quota arithmetic. These are the rules that
//! are about **how the client behaves against a server**, which a pure
//! function cannot express:
//!
//! - what `initiate` declares, since the server reserves quota against it;
//! - that a chunk goes up as raw `nonce ‖ ciphertext` rather than base64, so
//!   the bytes the server stores are the bytes a reader will hash;
//! - that deleting an attachment **dereferences its chunks** (§14.8), which is
//!   the half of R06 that is not about the file arriving;
//! - that a dereference longer than the cap is split rather than truncated.

mod http_fakes;

use std::sync::Arc;

use http_fakes::{FakeTransport, response};
use memry_core::protocol::attachment_upload::{
    DEREFERENCE_CAP, complete, dereference, frame_chunks, initiate, put_chunk,
};
use memry_core::protocol::http::{ClientIdentity, HttpClient};

const FILE_KEY: [u8; 32] = [7u8; 32];

fn nonces(index: u32) -> Vec<u8> {
    vec![index as u8; 24]
}

fn client(transport: Arc<FakeTransport>) -> HttpClient {
    HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    )
}

/// **What `initiate` declares is what the server reserves quota against**, so
/// the chunk count and the encrypted size have to describe the bytes that are
/// actually about to be sent.
#[tokio::test]
async fn initiate_declares_the_chunks_that_are_about_to_be_sent() {
    let plaintext: Vec<u8> = (0..10u8).collect();
    let chunks = frame_chunks(&plaintext, &FILE_KEY, 4, nonces).expect("frame");
    assert_eq!(chunks.len(), 3, "10 bytes in 4-byte chunks is three chunks");

    let transport = Arc::new(FakeTransport::new(vec![response(
        200,
        r#"{"sessionId":"s1","expiresAt":9999}"#,
    )]));
    let session = initiate(
        &client(Arc::clone(&transport)),
        "att-1",
        "picture.png",
        plaintext.len() as u64,
        &chunks,
    )
    .await
    .expect("initiate");
    assert_eq!(session.session_id, "s1");

    let calls = transport.calls();
    let body = String::from_utf8(calls[0].body.clone().unwrap_or_default()).expect("utf8");
    assert!(body.contains("\"attachmentId\":\"att-1\""), "{body}");
    assert!(body.contains("\"chunkCount\":3"), "{body}");
    // The plaintext total, which is what the file really is.
    assert!(body.contains("\"totalSize\":10"), "{body}");
    // **The declared hashes are the ciphertext hashes, not the plaintext
    // ones.** A chunk is addressed in R2 by the hash of `nonce ‖ ciphertext`;
    // the plaintext hash is the reader's own check after decrypting. Sending
    // the wrong one of the two produces a file that uploads cleanly, passes
    // every server check, and fails for every reader — so both halves are
    // asserted here rather than just the presence of something hash-shaped.
    for chunk in &chunks {
        assert!(
            body.contains(&chunk.reference.encrypted_hash),
            "the server addresses a chunk by its ciphertext hash: {body}"
        );
        assert!(
            !body.contains(&chunk.reference.hash),
            "the plaintext hash must not be what the chunk is stored under: {body}"
        );
    }
}

/// **A chunk goes up as raw bytes, not base64.**
///
/// The server stores what it receives and a reader hashes what it downloads,
/// so an encoded body would make every chunk hash disagree — and the failure
/// would look like corruption rather than like a transport choice.
#[tokio::test]
async fn a_chunk_goes_up_as_the_bytes_a_reader_will_hash() {
    let plaintext: Vec<u8> = (0..10u8).collect();
    let chunks = frame_chunks(&plaintext, &FILE_KEY, 4, nonces).expect("frame");

    let transport = Arc::new(FakeTransport::new(vec![response(200, "{}")]));
    put_chunk(&client(Arc::clone(&transport)), "s1", &chunks[0])
        .await
        .expect("put");

    let calls = transport.calls();
    assert_eq!(
        calls[0].body.as_deref(),
        Some(chunks[0].framed.as_slice()),
        "the body must be nonce ‖ ciphertext verbatim"
    );
}

/// Completing an upload is what makes it visible; nothing before it is.
#[tokio::test]
async fn completing_an_upload_names_its_session() {
    let transport = Arc::new(FakeTransport::new(vec![response(
        200,
        r#"{"success":true}"#,
    )]));
    complete(&client(Arc::clone(&transport)), "s1")
        .await
        .expect("complete");
    assert!(
        transport.calls()[0]
            .url
            .ends_with("/sync/attachments/upload/s1/complete"),
        "{:?}",
        transport.calls()[0].url
    );
}

/// **§14.8's dereference is not optional**, and this is the half of R06 that
/// is not about the file arriving: deleting an attachment has to release its
/// chunks, or the user's quota never comes back.
#[tokio::test]
async fn deleting_an_attachment_releases_its_chunks() {
    let transport = Arc::new(FakeTransport::new(vec![response(200, "{}")]));
    let hashes = vec!["a".repeat(64), "b".repeat(64)];

    dereference(&client(Arc::clone(&transport)), &hashes)
        .await
        .expect("dereference");

    let calls = transport.calls();
    assert_eq!(calls.len(), 1);
    assert!(calls[0].url.ends_with("/sync/attachments/dereference"));
    let body = String::from_utf8(calls[0].body.clone().unwrap_or_default()).expect("utf8");
    for hash in &hashes {
        assert!(body.contains(hash), "every chunk must be released: {body}");
    }
}

/// A list longer than the cap is **split**, never truncated: a truncated
/// release would leak exactly the chunks it dropped, silently.
#[tokio::test]
async fn a_long_release_is_split_rather_than_truncated() {
    let count = DEREFERENCE_CAP + 5;
    let hashes: Vec<String> = (0..count).map(|index| format!("{index:064x}")).collect();

    let transport = Arc::new(FakeTransport::new(vec![
        response(200, "{}"),
        response(200, "{}"),
    ]));
    dereference(&client(Arc::clone(&transport)), &hashes)
        .await
        .expect("dereference");

    let calls = transport.calls();
    assert_eq!(calls.len(), 2, "one window over the cap is two requests");

    // Together the two requests name every hash exactly once.
    let sent: String = calls
        .iter()
        .map(|call| String::from_utf8(call.body.clone().unwrap_or_default()).expect("utf8"))
        .collect();
    for hash in &hashes {
        assert!(sent.contains(hash), "a hash was dropped: {hash}");
    }
}

/// Nothing to release is no request at all, rather than an empty one the
/// server would reject (`chunkHashes` is `min(1)`).
#[tokio::test]
async fn releasing_nothing_asks_for_nothing() {
    let transport = Arc::new(FakeTransport::new(vec![]));
    dereference(&client(Arc::clone(&transport)), &[])
        .await
        .expect("dereference");
    assert_eq!(transport.call_count(), 0);
}
