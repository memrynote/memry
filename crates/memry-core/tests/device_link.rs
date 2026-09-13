//! The new device's half of chapter 03, behind the scripted transport.
//!
//! Every case here is the phone's side of a link with a fake desktop played by
//! the test: the "desktop" holds the initiator's ephemeral secret and seals the
//! master key exactly as §3.9 and §3.10 say it must, and the assertions are
//! about what the core did with what it received. Nothing reaches a network.
//!
//! The `complete` response cannot be scripted before the run, because it is
//! sealed under a shared secret that does not exist until the core has
//! generated its ephemeral key and posted the public half. So each test scans
//! first, reads the posted key out of the recorded request, and only then
//! pushes the answer.

mod http_fakes;

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use http_fakes::{FakeSecureStore, FakeTransport, body_json, error_response, response};
use memry_core::api::linking::{DeviceLink, LinkingPoll, POLL_BUDGET_REQUESTS};
use memry_core::crypto::sodium;
use memry_core::protocol::account::VaultSummary;
use memry_core::protocol::linking::{
    self, LinkingError, LinkingSubkeys, MasterKeyBlock, confirm_mac, linking_proof_message,
    scan_confirm_message, vault_transfer_confirm_message, verify_confirm_mac, verify_scan_mac,
};
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};

const SESSION: &str = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const SECRET: [u8; 32] = [0x11; 32];
const MASTER_KEY: [u8; 32] = [0x42; 32];

/// The desktop's half: the initiator's ephemeral pair, and the QR it printed.
struct Desktop {
    public_b64: String,
    secret: zeroize::Zeroizing<Vec<u8>>,
    expires_at: u64,
}

impl Desktop {
    fn new() -> Self {
        let (public, secret) = linking::ephemeral_keypair().expect("initiator pair");
        Self {
            public_b64: BASE64_STANDARD.encode(&public),
            secret,
            expires_at: now_s() + 300,
        }
    }

    fn qr(&self) -> String {
        self.qr_with(SESSION, &BASE64_STANDARD.encode(SECRET), self.expires_at)
    }

    fn qr_with(&self, session_id: &str, secret_b64: &str, expires_at: u64) -> String {
        format!(
            r#"{{"sessionId":"{session_id}","ephemeralPublicKey":"{}","linkingSecret":"{secret_b64}","expiresAt":{expires_at}}}"#,
            self.public_b64
        )
    }

    /// The subkeys §3.5 says both sides reach independently.
    fn subkeys(&self, device_public_b64: &str) -> LinkingSubkeys {
        let device_public = BASE64_STANDARD.decode(device_public_b64).expect("base64");
        let shared = linking::shared_secret(&self.secret, &device_public).expect("agreement");
        linking::derive_subkeys(&shared).expect("subkeys")
    }
}

fn now_s() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_secs()
}

fn link_over(transport: Arc<FakeTransport>, store: Arc<FakeSecureStore>) -> Arc<DeviceLink> {
    Arc::new(
        DeviceLink::new(
            transport,
            store,
            "https://sync.example".to_string(),
            "ios".to_string(),
            "1.0.0".to_string(),
        )
        .expect("a device link"),
    )
}

/// The `/scan` body the core posted.
fn scan_body(transport: &FakeTransport) -> serde_json::Value {
    let calls = transport.calls_to("/auth/linking/scan");
    assert_eq!(calls.len(), 1, "exactly one scan request");
    body_json(&calls[0])
}

fn text(body: &serde_json::Value, name: &str) -> String {
    body[name]
        .as_str()
        .unwrap_or_else(|| panic!("{name}"))
        .to_string()
}

/// An approved `complete` body, sealed the way §3.9 and §3.10 require.
fn approved_body(
    session_id: &str,
    subkeys: &LinkingSubkeys,
    master_key: &[u8],
    vaults: Option<&str>,
) -> String {
    let (block, key_confirm) =
        linking::send_master_key(session_id, master_key, subkeys, &[0x33u8; 24])
            .expect("sealed master key");
    let mut body = serde_json::json!({
        "success": true,
        "encryptedMasterKey": block.encrypted_master_key_b64,
        "encryptedKeyNonce": block.encrypted_key_nonce_b64,
        "keyConfirm": BASE64_STANDARD.encode(key_confirm),
    });
    if let Some(plaintext) = vaults {
        let nonce = [0x44u8; 24];
        let aad = format!("vault-transfer-v1:{session_id}");
        let ciphertext = sodium::aead_encrypt(
            plaintext.as_bytes(),
            Some(aad.as_bytes()),
            &nonce,
            &subkeys.encryption,
        )
        .expect("sealed transfer");
        let ciphertext_b64 = BASE64_STANDARD.encode(&ciphertext);
        let message =
            vault_transfer_confirm_message(session_id, &ciphertext_b64).expect("confirm message");
        body["encryptedVaultTransfer"] = ciphertext_b64.into();
        body["encryptedVaultTransferNonce"] = BASE64_STANDARD.encode(nonce).into();
        body["vaultTransferConfirm"] = BASE64_STANDARD
            .encode(confirm_mac(&message, &subkeys.mac).expect("tag"))
            .into();
    }
    body.to_string()
}

/// `409 LINKING_INVALID_TRANSITION` — §3.12's "keep polling".
fn not_yet_approved()
-> Result<memry_core::seams::transport::HttpResponse, memry_core::api::errors::TransportError> {
    error_response(409, "LINKING_INVALID_TRANSITION", "not approved yet")
}

// ---------------------------------------------------------------------------
// scan, §3.3 and §3.7
// ---------------------------------------------------------------------------

/// The one body carries both scan-channel tags and the confirm-channel tag,
/// and `scanProof` and `newDeviceConfirm` cover **identical** CBOR bytes under
/// different keys and different primitives (§3.7).
#[tokio::test]
async fn scan_posts_both_mac_families_over_the_same_proof() {
    let desktop = Desktop::new();
    let transport = FakeTransport::new(vec![response(200, r#"{"success":true}"#)]);
    let link = link_over(transport.clone(), FakeSecureStore::new());

    let scanned = link.scan(desktop.qr()).await.expect("scan");
    let body = scan_body(&transport);

    // §3.3: echoed byte-exact, string for string.
    assert_eq!(text(&body, "linkingSecret"), BASE64_STANDARD.encode(SECRET));

    let device_public_b64 = text(&body, "newDevicePublicKey");
    let proof = linking_proof_message(SESSION, &device_public_b64).expect("proof");
    let confirm =
        scan_confirm_message(SESSION, &desktop.public_b64, &device_public_b64).expect("confirm");
    let subkeys = desktop.subkeys(&device_public_b64);

    // The server verifies these two, under the decoded 32 bytes.
    verify_scan_mac(&proof, &text(&body, "scanProof"), &SECRET).expect("scanProof");
    verify_scan_mac(&confirm, &text(&body, "scanConfirm"), &SECRET).expect("scanConfirm");
    // Only the peer device verifies this one, under `memrymac`.
    verify_confirm_mac(&proof, &text(&body, "newDeviceConfirm"), &subkeys.mac)
        .expect("newDeviceConfirm");

    // §3.6: both sides reach the same six digits from the raw scalarmult.
    assert_eq!(scanned.sas_code.len(), 6);
    assert!(scanned.sas_code.chars().all(|c| c.is_ascii_digit()));
    assert_eq!(
        scanned.sas_code,
        linking::sas_code_from_key(&subkeys.sas).expect("desktop sas")
    );
    // §3.4: the server's `expiresAt`, not 300 seconds from now.
    assert_eq!(scanned.expires_at, desktop.expires_at as i64);
    assert_eq!(text(&body, "sessionId"), SESSION);
}

/// §3.3: the length check is the client's, and it happens before the request.
/// §3.8: an expired session is refused before any crypto. A malformed payload
/// is a third, distinct refusal. **None of the three sends anything.**
#[tokio::test]
async fn each_bad_qr_payload_is_its_own_refusal_and_costs_no_request() {
    let desktop = Desktop::new();
    let transport = FakeTransport::new(vec![]);
    let link = link_over(transport.clone(), FakeSecureStore::new());

    let short = desktop.qr_with(
        SESSION,
        &BASE64_STANDARD.encode([0x11u8; 31]),
        desktop.expires_at,
    );
    assert_eq!(
        link.scan(short).await,
        Err(LinkingError::InvalidLength {
            what: "linkingSecret".into(),
            expected: 32,
            actual: 31,
        })
    );

    let expired = desktop.qr_with(SESSION, &BASE64_STANDARD.encode(SECRET), now_s() - 1);
    assert_eq!(link.scan(expired).await, Err(LinkingError::SessionExpired));

    assert_eq!(
        link.scan("{".to_string()).await,
        Err(LinkingError::InvalidQrPayload {
            what: "not JSON".into()
        })
    );

    let not_a_uuid = desktop.qr_with(
        "session-1",
        &BASE64_STANDARD.encode(SECRET),
        desktop.expires_at,
    );
    assert_eq!(
        link.scan(not_a_uuid).await,
        Err(LinkingError::InvalidQrPayload {
            what: "sessionId is not a UUID".into()
        })
    );

    assert_eq!(transport.call_count(), 0, "no request leaves the device");
    assert!(!link.is_pending());
}

/// A second QR while one is pending is refused rather than silently replacing
/// the first — and refused with its own variant, not with `NotScanned`.
#[tokio::test]
async fn a_second_scan_is_refused_while_one_is_pending() {
    let desktop = Desktop::new();
    let transport = FakeTransport::new(vec![response(200, r#"{"success":true}"#)]);
    let link = link_over(transport.clone(), FakeSecureStore::new());

    link.scan(desktop.qr()).await.expect("first scan");
    assert_eq!(
        link.scan(desktop.qr()).await.unwrap_err(),
        LinkingError::AlreadyScanned
    );
    assert_eq!(transport.call_count(), 1);
}

// ---------------------------------------------------------------------------
// complete, §3.9 and §3.10
// ---------------------------------------------------------------------------

/// The happy path: the master key lands in the secure store and **never** in a
/// return value, and §3.10's transferred vault list comes back.
#[tokio::test]
async fn a_completed_link_stores_the_master_key_and_returns_the_vaults() {
    let desktop = Desktop::new();
    let transport = FakeTransport::new(vec![response(200, r#"{"success":true}"#)]);
    let store = FakeSecureStore::new();
    let link = link_over(transport.clone(), store.clone());

    link.scan(desktop.qr()).await.expect("scan");
    let subkeys = desktop.subkeys(&text(&scan_body(&transport), "newDevicePublicKey"));

    // §3.12: the poll before approval is a 409, and it is not a failure.
    transport.push(not_yet_approved());
    assert_eq!(
        link.poll_once().await.expect("a poll"),
        LinkingPoll::AwaitingApproval
    );
    assert_eq!(
        store.get(SecureStoreKey::MasterKey).expect("store"),
        None,
        "nothing is stored before approval"
    );

    transport.push(response(
        200,
        &approved_body(
            SESSION,
            &subkeys,
            &MASTER_KEY,
            Some(r#"{"version":1,"vaults":[{"vaultUuid":"vault-a"},{"vaultUuid":"vault-b"}]}"#),
        ),
    ));
    assert_eq!(
        link.poll_once().await.expect("a completed link"),
        LinkingPoll::Linked {
            vaults: vec![
                VaultSummary {
                    id: "vault-a".into(),
                    name: None
                },
                VaultSummary {
                    id: "vault-b".into(),
                    name: None
                },
            ]
        }
    );
    assert_eq!(
        store.get(SecureStoreKey::MasterKey).expect("store"),
        Some(MASTER_KEY.to_vec())
    );
    // The session is spent, so a further poll is not a second link.
    assert!(!link.is_pending());
    assert_eq!(
        link.poll_once().await.unwrap_err(),
        LinkingError::NotScanned
    );

    // Both routes are unauthenticated (§3.1).
    for call in transport.calls() {
        assert!(
            !call.headers.contains_key("authorization"),
            "{} must carry no Authorization header",
            call.url
        );
    }
}

/// §3.10: an absent block is an empty list and not a failure.
#[tokio::test]
async fn an_absent_vault_transfer_completes_with_an_empty_list() {
    let desktop = Desktop::new();
    let transport = FakeTransport::new(vec![response(200, r#"{"success":true}"#)]);
    let store = FakeSecureStore::new();
    let link = link_over(transport.clone(), store.clone());

    link.scan(desktop.qr()).await.expect("scan");
    let subkeys = desktop.subkeys(&text(&scan_body(&transport), "newDevicePublicKey"));
    transport.push(response(
        200,
        &approved_body(SESSION, &subkeys, &MASTER_KEY, None),
    ));

    assert_eq!(
        link.poll_once().await.expect("a completed link"),
        LinkingPoll::Linked { vaults: Vec::new() }
    );
    assert_eq!(
        store.get(SecureStoreKey::MasterKey).expect("store"),
        Some(MASTER_KEY.to_vec())
    );
}

/// §3.9: `keyConfirm` is verified **before** the master key is decrypted, so a
/// peer that does not hold the shared secret never gets a key stored.
#[tokio::test]
async fn a_bad_key_confirm_fails_the_link_and_stores_nothing() {
    let desktop = Desktop::new();
    let transport = FakeTransport::new(vec![response(200, r#"{"success":true}"#)]);
    let store = FakeSecureStore::new();
    let link = link_over(transport.clone(), store.clone());

    link.scan(desktop.qr()).await.expect("scan");
    let subkeys = desktop.subkeys(&text(&scan_body(&transport), "newDevicePublicKey"));
    let mut body: serde_json::Value =
        serde_json::from_str(&approved_body(SESSION, &subkeys, &MASTER_KEY, None)).expect("json");
    body["keyConfirm"] = BASE64_STANDARD.encode([0u8; 32]).into();
    transport.push(response(200, &body.to_string()));

    assert_eq!(
        link.poll_once().await.unwrap_err(),
        LinkingError::ConfirmMacInvalid
    );
    assert_eq!(store.get(SecureStoreKey::MasterKey).expect("store"), None);
    // §3.9: the session is cleared, so the subkeys are gone with it.
    assert!(!link.is_pending());
}

/// §3.10: vault transfer is **hard-fail**. A block that fails its MAC fails the
/// whole link, even though the master key block above it verified perfectly.
#[tokio::test]
async fn a_bad_vault_transfer_fails_the_link_and_stores_nothing() {
    let desktop = Desktop::new();
    let transport = FakeTransport::new(vec![response(200, r#"{"success":true}"#)]);
    let store = FakeSecureStore::new();
    let link = link_over(transport.clone(), store.clone());

    link.scan(desktop.qr()).await.expect("scan");
    let subkeys = desktop.subkeys(&text(&scan_body(&transport), "newDevicePublicKey"));
    let mut body: serde_json::Value = serde_json::from_str(&approved_body(
        SESSION,
        &subkeys,
        &MASTER_KEY,
        Some(r#"{"version":1,"vaults":[{"vaultUuid":"vault-a"}]}"#),
    ))
    .expect("json");
    body["vaultTransferConfirm"] = BASE64_STANDARD.encode([0u8; 32]).into();
    transport.push(response(200, &body.to_string()));

    assert_eq!(
        link.poll_once().await.unwrap_err(),
        LinkingError::ConfirmMacInvalid
    );
    assert_eq!(
        store.get(SecureStoreKey::MasterKey).expect("store"),
        None,
        "§3.10: a failing transfer must not leave a key behind"
    );
    assert!(!link.is_pending());
}

/// A 200 that carries no block is a malformed response, never a link that
/// quietly completed with no key.
#[tokio::test]
async fn a_success_with_no_master_key_is_reported_rather_than_ignored() {
    let desktop = Desktop::new();
    let transport = FakeTransport::new(vec![response(200, r#"{"success":true}"#)]);
    let store = FakeSecureStore::new();
    let link = link_over(transport.clone(), store.clone());

    link.scan(desktop.qr()).await.expect("scan");
    transport.push(response(200, r#"{"success":true}"#));

    assert!(matches!(
        link.poll_once().await.unwrap_err(),
        LinkingError::Api {
            source: memry_core::api::errors::ApiError::MalformedResponse { .. }
        }
    ));
    assert_eq!(store.get(SecureStoreKey::MasterKey).expect("store"), None);
}

// ---------------------------------------------------------------------------
// the budget and the window, §3.4 and §3.11.3
// ---------------------------------------------------------------------------

/// A poll with nothing scanned is `NotScanned`, and it is not a request.
#[tokio::test]
async fn polling_before_scanning_is_its_own_refusal() {
    let transport = FakeTransport::new(vec![]);
    let link = link_over(transport.clone(), FakeSecureStore::new());
    assert_eq!(
        link.poll_once().await.unwrap_err(),
        LinkingError::NotScanned
    );
    assert_eq!(transport.call_count(), 0);
}

/// §3.4: 30 requests per 60 seconds per session. The thirty-first is refused
/// **without a request**, which is the whole point — a client that exceeded the
/// budget would spend the rest of its 300 s window on 429s.
#[tokio::test]
async fn the_poll_budget_is_enforced_before_the_request() {
    let desktop = Desktop::new();
    let transport = FakeTransport::new(vec![response(200, r#"{"success":true}"#)]);
    let link = link_over(transport.clone(), FakeSecureStore::new());
    link.scan(desktop.qr()).await.expect("scan");

    for _ in 0..POLL_BUDGET_REQUESTS {
        transport.push(not_yet_approved());
        assert_eq!(
            link.poll_once().await.expect("a poll"),
            LinkingPoll::AwaitingApproval
        );
    }
    let spent = transport.call_count();
    assert!(matches!(
        link.poll_once().await.unwrap_err(),
        LinkingError::PollBudgetExhausted { .. }
    ));
    assert_eq!(
        transport.call_count(),
        spent,
        "the refusal costs no request"
    );
    // The session survives a spent budget: §3.4's window outlives it.
    assert!(link.is_pending());
}

/// §3.11.3: on `LINKING_IP_MISMATCH` a client MUST zero the linking subkeys and
/// MUST NOT retry. Dropping the session is how both are done here.
#[tokio::test]
async fn a_permanent_refusal_clears_the_session_and_a_rate_limit_does_not() {
    let desktop = Desktop::new();
    let transport = FakeTransport::new(vec![response(200, r#"{"success":true}"#)]);
    let link = link_over(transport.clone(), FakeSecureStore::new());
    link.scan(desktop.qr()).await.expect("scan");

    // A 429 is transient: the session stays and the next poll is ordinary.
    transport.push(error_response(429, "RATE_LIMITED", "slow down"));
    assert!(matches!(
        link.poll_once().await.unwrap_err(),
        LinkingError::Api {
            source: memry_core::api::errors::ApiError::RateLimited { .. }
        }
    ));
    assert!(
        link.is_pending(),
        "a rate limit is not the end of a session"
    );

    transport.push(error_response(
        403,
        "LINKING_IP_MISMATCH",
        "scanner ip changed",
    ));
    assert!(link.poll_once().await.is_err());
    assert!(!link.is_pending());
    assert_eq!(
        link.poll_once().await.unwrap_err(),
        LinkingError::NotScanned
    );
}

/// The three subkeys go when the user backs out, and `cancel` on nothing is not
/// an error.
#[tokio::test]
async fn cancel_abandons_a_pending_session() {
    let desktop = Desktop::new();
    let transport = FakeTransport::new(vec![response(200, r#"{"success":true}"#)]);
    let link = link_over(transport.clone(), FakeSecureStore::new());

    link.cancel();
    link.scan(desktop.qr()).await.expect("scan");
    assert!(link.is_pending());
    link.cancel();
    assert!(!link.is_pending());
    assert_eq!(
        link.poll_once().await.unwrap_err(),
        LinkingError::NotScanned
    );
}

/// A master key block that is not 32 bytes after decryption is refused, so a
/// peer cannot install a key of a length nothing else in the product accepts.
#[tokio::test]
async fn a_master_key_of_the_wrong_length_is_refused() {
    let desktop = Desktop::new();
    let transport = FakeTransport::new(vec![response(200, r#"{"success":true}"#)]);
    let store = FakeSecureStore::new();
    let link = link_over(transport.clone(), store.clone());

    link.scan(desktop.qr()).await.expect("scan");
    let subkeys = desktop.subkeys(&text(&scan_body(&transport), "newDevicePublicKey"));

    // Sealed and MAC'd correctly — only the plaintext length is wrong.
    let short = [0x42u8; 16];
    let ciphertext =
        sodium::aead_encrypt(&short, None, &[0x33u8; 24], &subkeys.encryption).expect("sealed");
    let block = MasterKeyBlock {
        encrypted_master_key_b64: BASE64_STANDARD.encode(&ciphertext),
        encrypted_key_nonce_b64: BASE64_STANDARD.encode([0x33u8; 24]),
    };
    let message = memry_core::protocol::linking::key_confirm_message(
        SESSION,
        &block.encrypted_master_key_b64,
    )
    .expect("message");
    transport.push(response(
        200,
        &serde_json::json!({
            "success": true,
            "encryptedMasterKey": block.encrypted_master_key_b64,
            "encryptedKeyNonce": block.encrypted_key_nonce_b64,
            "keyConfirm": BASE64_STANDARD.encode(confirm_mac(&message, &subkeys.mac).expect("tag")),
        })
        .to_string(),
    ));

    assert_eq!(
        link.poll_once().await.unwrap_err(),
        LinkingError::InvalidLength {
            what: "master key".into(),
            expected: 32,
            actual: 16,
        }
    );
    assert_eq!(store.get(SecureStoreKey::MasterKey).expect("store"), None);
}
