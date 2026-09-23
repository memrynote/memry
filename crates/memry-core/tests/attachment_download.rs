//! The attachment download path over a scripted transport (N200, N201).
//!
//! The unit tests beside `protocol::attachments` cover the byte work — the
//! frame, the hash checks, the assembly order. These are the rules that are
//! about **how the client behaves against a server**, which a pure function
//! cannot express:
//!
//! - `STORAGE_PRESIGN_UNAVAILABLE` is permanent for a deployment and MUST NOT
//!   be retried on a timer (§14.6);
//! - `presign-batch` is capped at 1024 hashes, so a longer list is split
//!   rather than truncated or refused (§14.6);
//! - an unresolvable signer device is a hard failure, not a fallback
//!   (§14.4.1);
//! - the signature is checked before the file key is unwrapped (§14.4.1).

mod http_fakes;
mod support;

use std::sync::Arc;

use http_fakes::{FakeTransport, RecordingSleeper, error_response, response};
use memry_core::api::errors::ApiError;
use memry_core::protocol::attachments::{
    AttachmentError, PRESIGN_BATCH_CAP, SignerResolver, fetch_manifest, presign_all, presign_batch,
};
use memry_core::protocol::http::{ClientIdentity, HttpClient};
use support::{hex_field, str_field, vector_file};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;

fn client(transport: Arc<FakeTransport>) -> HttpClient {
    HttpClient::new(
        transport,
        "https://sync.example",
        ClientIdentity::new("ios", "1.2.3").expect("a valid identity"),
    )
    // Records what the ladder asked to wait instead of waiting, so the
    // retryable-500 case does not spend fourteen real seconds proving it
    // retried.
    .with_sleeper(RecordingSleeper::new())
}

/// Answers with one device's key, or nothing.
struct Known {
    device_id: String,
    public_key: Vec<u8>,
}

impl SignerResolver for Known {
    fn public_key(&self, device_id: &str) -> Option<Vec<u8>> {
        (device_id == self.device_id).then(|| self.public_key.clone())
    }
}

/// A resolver that knows nobody, which is the §14.4.1 case.
struct KnowsNobody;

impl SignerResolver for KnowsNobody {
    fn public_key(&self, _device_id: &str) -> Option<Vec<u8>> {
        None
    }
}

/// The committed manifest envelope, as the route returns it.
fn manifest_body() -> String {
    let file = vector_file("attachment-manifest");
    let envelope = &file["cases"][0]["envelope"];
    serde_json::to_string(envelope).expect("json")
}

#[tokio::test]
async fn presign_unavailable_is_permanent_and_is_not_retried() {
    // One typed refusal. §14.6 makes this permanent for the deployment, so the
    // client must not ask again on a timer — and it must not treat it as a
    // transport failure worth the retry ladder either, which is what the call
    // count proves.
    let transport = FakeTransport::new(vec![error_response(
        503,
        "STORAGE_PRESIGN_UNAVAILABLE",
        "no presign secrets on this deployment",
    )]);
    let http = client(transport.clone());

    let answer = presign_batch(&http, &["aa".repeat(32)])
        .await
        .expect("a typed refusal is not an error");

    assert!(
        answer.is_none(),
        "the refusal must be reported as 'this deployment has none', not as a failure"
    );
    assert_eq!(
        transport.call_count(),
        1,
        "a permanent refusal must not be retried"
    );
}

#[tokio::test]
async fn any_other_presign_failure_is_still_an_error() {
    // The distinction that matters: "the presign route is broken right now"
    // and "this deployment does not presign" are different facts, and only the
    // second is forever. Collapsing them would strand a client on the proxied
    // path after one bad minute.
    //
    // An untyped 500 IS retryable (chapter 00 §0.5), so the ladder runs and
    // the script has to feed it. That contrast is the point of the test: the
    // typed refusal above took one call, this one takes the whole ladder and
    // still ends as an error rather than as "no presigning here".
    let transport = FakeTransport::new(vec![
        error_response(500, "INTERNAL", "something came loose"),
        error_response(500, "INTERNAL", "something came loose"),
        error_response(500, "INTERNAL", "something came loose"),
        error_response(500, "INTERNAL", "something came loose"),
        error_response(500, "INTERNAL", "something came loose"),
    ]);
    let http = client(transport.clone());

    let error = presign_batch(&http, &["aa".repeat(32)])
        .await
        .expect_err("a generic failure is an error");
    assert!(matches!(error, AttachmentError::Api(_)), "got {error:?}");
    assert!(
        transport.call_count() > 1,
        "an untyped 500 is retryable, unlike the typed refusal"
    );
}

#[tokio::test]
async fn a_long_hash_list_is_split_at_the_contract_cap() {
    // 1024 is the cap (§14.6). 1025 hashes must become two calls rather than
    // one over-long request the server rejects, or a silently truncated set
    // that leaves the last chunk undownloadable.
    let hashes: Vec<String> = (0..PRESIGN_BATCH_CAP + 1)
        .map(|index| format!("{index:064x}"))
        .collect();

    let transport = FakeTransport::new(vec![
        response(200, r#"{"urls":{},"expiresAt":2000}"#),
        response(200, r#"{"urls":{},"expiresAt":1500}"#),
    ]);
    let http = client(transport.clone());

    let batch = presign_all(&http, &hashes)
        .await
        .expect("presign")
        .expect("this deployment presigns");

    assert_eq!(transport.call_count(), 2, "1025 hashes is two calls");
    assert_eq!(
        batch.expires_at, 1500,
        "the soonest expiry wins: a holder must refresh before the FIRST url dies"
    );
}

#[tokio::test]
async fn an_unresolvable_signer_is_a_hard_failure() {
    // §14.4.1. The manifest is the only thing naming the file, so "I cannot
    // check who signed this" must never share a branch with "this is fine".
    let transport = FakeTransport::new(vec![response(200, &manifest_body())]);
    let http = client(transport);
    let file = vector_file("attachment-manifest");
    let vault_key = hex_field(&file["meta"], "vaultKeyHex");

    let error = fetch_manifest(&http, "att-single", &vault_key, &KnowsNobody)
        .await
        .expect_err("an unknown signer must fail");

    match error {
        AttachmentError::UnresolvableSigner { device_id } => {
            assert_eq!(device_id, str_field(&file["meta"], "signerDeviceId"));
        }
        other => panic!("expected an unresolvable-signer refusal, got {other:?}"),
    }
}

#[tokio::test]
async fn a_resolvable_signer_opens_the_manifest() {
    let file = vector_file("attachment-manifest");
    let vault_key = hex_field(&file["meta"], "vaultKeyHex");
    let signers = Known {
        device_id: str_field(&file["meta"], "signerDeviceId").to_owned(),
        public_key: BASE64_STANDARD
            .decode(str_field(&file["meta"], "signerPublicKeyB64"))
            .expect("base64"),
    };

    let transport = FakeTransport::new(vec![response(200, &manifest_body())]);
    let http = client(transport);

    let (manifest, file_key) = fetch_manifest(&http, "att-single", &vault_key, &signers)
        .await
        .expect("the manifest opens");

    assert_eq!(manifest.filename, "picture.png");
    assert_eq!(
        file_key,
        hex_field(&file["meta"], "fileKeyHex"),
        "the unwrapped file key"
    );
}

#[tokio::test]
async fn a_manifest_signed_by_a_device_whose_key_does_not_match_is_refused() {
    // The resolver answers, and answers wrong — a swapped device record. The
    // signature is what catches it, and it must be reported as a signature
    // refusal rather than as a decrypt failure.
    let file = vector_file("attachment-manifest");
    let vault_key = hex_field(&file["meta"], "vaultKeyHex");
    let (other_public, _) =
        memry_core::crypto::sodium::sign_seed_keypair(&[0x5c; 32]).expect("keypair");
    let signers = Known {
        device_id: str_field(&file["meta"], "signerDeviceId").to_owned(),
        public_key: other_public,
    };

    let transport = FakeTransport::new(vec![response(200, &manifest_body())]);
    let http = client(transport);

    let error = fetch_manifest(&http, "att-single", &vault_key, &signers)
        .await
        .expect_err("a wrong key must fail");
    assert!(
        matches!(error, AttachmentError::Manifest(_)),
        "got {error:?}"
    );
}

#[tokio::test]
async fn a_missing_attachment_is_an_ordinary_api_error() {
    let transport = FakeTransport::new(vec![error_response(
        404,
        "ATTACHMENT_NOT_FOUND",
        "Attachment manifest not found",
    )]);
    let http = client(transport);
    let file = vector_file("attachment-manifest");
    let vault_key = hex_field(&file["meta"], "vaultKeyHex");

    let error = fetch_manifest(&http, "nope", &vault_key, &KnowsNobody)
        .await
        .expect_err("a missing manifest fails");
    assert!(matches!(
        error,
        AttachmentError::Api(ApiError::Status { status: 404, .. })
    ));
}
