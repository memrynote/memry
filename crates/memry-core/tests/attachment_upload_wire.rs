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
use memry_core::api::errors::ApiError;
use memry_core::protocol::attachment_manifest::EncryptedAttachmentManifest;
use memry_core::protocol::attachment_upload::{
    DEREFERENCE_CAP, DirectChunk, cancel, complete, dereference, frame_chunks, initiate, put_chunk,
    put_chunk_presigned, put_manifest, status,
};
use memry_core::protocol::attachments::{
    SignerResolver, fetch_chunk_proxied, fetch_manifest, presign_batch,
};
use memry_core::protocol::http::{
    AUTHORIZATION_HEADER, ClientIdentity, HttpClient, TokenProvider, VAULT_ID_HEADER,
};

const FILE_KEY: [u8; 32] = [7u8; 32];

fn nonces(index: u32) -> Vec<u8> {
    vec![index as u8; 24]
}

const VAULT: &str = "vault-a";

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
        VAULT,
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
    put_chunk(&client(Arc::clone(&transport)), VAULT, "s1", &chunks[0])
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
    complete(&client(Arc::clone(&transport)), VAULT, "s1", &[])
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

    dereference(&client(Arc::clone(&transport)), VAULT, &hashes)
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
    dereference(&client(Arc::clone(&transport)), VAULT, &hashes)
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
    dereference(&client(Arc::clone(&transport)), VAULT, &[])
        .await
        .expect("dereference");
    assert_eq!(transport.call_count(), 0);
}

struct SignedIn;

#[async_trait::async_trait]
impl TokenProvider for SignedIn {
    async fn access_token(&self) -> Option<String> {
        Some("access-1".to_string())
    }

    async fn refresh(&self, _stale: &str) -> Result<String, ApiError> {
        Ok("access-1".to_string())
    }
}

/// **Every Worker attachment route carries the session**, or the server answers
/// 401 and, since the request was not a session request, nothing refreshes and
/// replays it: every upload and every proxied download fails for a signed-in
/// user. A presigned R2 url is its own authorisation and carries nothing.
#[tokio::test]
async fn worker_routes_carry_the_session_and_presigned_urls_do_not() {
    let plaintext: Vec<u8> = (0..4u8).collect();
    let chunks = frame_chunks(&plaintext, &FILE_KEY, 4, nonces).expect("frame");
    let transport = Arc::new(FakeTransport::new(vec![
        response(200, r#"{"sessionId":"s1","expiresAt":9999}"#),
        response(200, "{}"),
        response(200, r#"{"success":true}"#),
        response(200, "{}"),
        response(200, "bytes"),
        response(200, "{}"),
    ]));
    let signed_in = client(Arc::clone(&transport)).with_tokens(Arc::new(SignedIn));

    initiate(&signed_in, VAULT, "att-1", "p.png", 4, &chunks)
        .await
        .expect("initiate");
    put_chunk(&signed_in, VAULT, "s1", &chunks[0])
        .await
        .expect("put");
    complete(&signed_in, VAULT, "s1", &[])
        .await
        .expect("complete");
    dereference(&signed_in, VAULT, &["a".repeat(64)])
        .await
        .expect("dereference");
    fetch_chunk_proxied(&signed_in, VAULT, &"b".repeat(64))
        .await
        .expect("fetch");
    put_chunk_presigned(&signed_in, "https://r2.example/put", &chunks[0])
        .await
        .expect("presigned put");

    let calls = transport.calls();
    let (presigned, worker) = calls.split_last().expect("six calls");
    for call in worker {
        assert_eq!(
            call.headers.get(AUTHORIZATION_HEADER).map(String::as_str),
            Some("Bearer access-1"),
            "{} must carry the session",
            call.url
        );
    }
    assert!(
        !presigned.headers.contains_key(AUTHORIZATION_HEADER),
        "a presigned url carries no token"
    );
    assert_eq!(
        presigned.url, "https://r2.example/put",
        "a presigned url is sent as given"
    );
    assert!(
        worker[0].url.starts_with("https://sync.example/sync/"),
        "{}",
        worker[0].url
    );
}

/// **Every Worker attachment route names the vault** (chapter 05 §5.2), because
/// the server keys manifests and chunks under the vault it resolves. A request
/// without the header lands in the device's registration vault (`default` for
/// iOS), where desktop, which always sends it, never looks: #2634, where every
/// iOS upload read as "Attachment file missing" on desktop. A presigned R2 url
/// is not our server and carries no vault.
#[tokio::test]
async fn worker_routes_name_the_vault_and_presigned_urls_do_not() {
    let plaintext: Vec<u8> = (0..4u8).collect();
    let chunks = frame_chunks(&plaintext, &FILE_KEY, 4, nonces).expect("frame");
    let transport = Arc::new(FakeTransport::new(vec![
        response(200, r#"{"sessionId":"s1","expiresAt":9999}"#),
        response(200, "{}"),
        response(200, r#"{"success":true}"#),
        response(200, "{}"),
        response(
            200,
            r#"{"sessionId":"s1","attachmentId":"att-1","chunkCount":1,"uploadedChunks":[0],"expiresAt":9999}"#,
        ),
        response(200, "{}"),
        response(200, "{}"),
        response(200, r#"{"urls":{},"expiresAt":9999}"#),
        response(200, "bytes"),
        response(
            404,
            r#"{"error":{"code":"ATTACHMENT_NOT_FOUND","message":"x"}}"#,
        ),
        response(200, "{}"),
    ]));
    let http = client(Arc::clone(&transport));
    let envelope = EncryptedAttachmentManifest {
        encrypted_manifest: String::new(),
        manifest_nonce: String::new(),
        encrypted_file_key: String::new(),
        key_nonce: String::new(),
        manifest_signature: String::new(),
        signer_device_id: String::new(),
    };

    initiate(&http, VAULT, "att-1", "p.png", 4, &chunks)
        .await
        .expect("initiate");
    put_chunk(&http, VAULT, "s1", &chunks[0])
        .await
        .expect("put");
    complete(&http, VAULT, "s1", &[]).await.expect("complete");
    put_manifest(&http, VAULT, "att-1", &envelope)
        .await
        .expect("manifest");
    status(&http, VAULT, "s1").await.expect("status");
    cancel(&http, VAULT, "s1").await.expect("cancel");
    dereference(&http, VAULT, &["a".repeat(64)])
        .await
        .expect("dereference");
    presign_batch(&http, VAULT, &["b".repeat(64)])
        .await
        .expect("presign");
    fetch_chunk_proxied(&http, VAULT, &"b".repeat(64))
        .await
        .expect("fetch");
    // Only the request matters here; the 404 is the manifest route answering.
    let _ = fetch_manifest(&http, VAULT, "att-1", &[0u8; 32], &NoSigners).await;
    put_chunk_presigned(&http, "https://r2.example/put", &chunks[0])
        .await
        .expect("presigned put");

    let calls = transport.calls();
    assert_eq!(calls.len(), 11);
    let (presigned, worker) = calls.split_last().expect("calls");
    for call in worker {
        assert_eq!(
            call.headers.get(VAULT_ID_HEADER).map(String::as_str),
            Some(VAULT),
            "{} must name the vault",
            call.url
        );
    }
    assert!(
        !presigned.headers.contains_key(VAULT_ID_HEADER),
        "a presigned url carries no vault"
    );
}

struct NoSigners;

impl SignerResolver for NoSigners {
    fn public_key(&self, _device_id: &str) -> Option<Vec<u8>> {
        None
    }
}

/// **A chunk PUT straight to R2 is reported on `complete`**, or the server,
/// which never saw it pass, answers "Missing chunks". None direct leaves the
/// key out: the body an older server already accepts.
#[tokio::test]
async fn complete_reports_the_chunks_that_went_straight_to_r2() {
    let plaintext: Vec<u8> = (0..4u8).collect();
    let chunks = frame_chunks(&plaintext, &FILE_KEY, 4, nonces).expect("frame");
    let transport = Arc::new(FakeTransport::new(vec![
        response(200, "{}"),
        response(200, "{}"),
    ]));
    let http = client(Arc::clone(&transport));

    complete(&http, VAULT, "s1", &[DirectChunk::of(&chunks[0])])
        .await
        .expect("complete");
    complete(&http, VAULT, "s2", &[]).await.expect("complete");

    let calls = transport.calls();
    let direct: serde_json::Value =
        serde_json::from_slice(calls[0].body.as_deref().unwrap_or_default()).expect("json");
    assert_eq!(direct["directChunks"][0]["i"], 0);
    assert_eq!(
        direct["directChunks"][0]["h"],
        chunks[0].reference.encrypted_hash.as_str()
    );
    assert_eq!(
        direct["directChunks"][0]["b"],
        chunks[0].framed.len() as u64
    );
    let proxied: serde_json::Value =
        serde_json::from_slice(calls[1].body.as_deref().unwrap_or_default()).expect("json");
    assert!(proxied.get("directChunks").is_none(), "{proxied}");
}
