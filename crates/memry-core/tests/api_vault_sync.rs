//! The exported read-only sync: `Vault::sync`, `VaultSync::first_sync` and
//! `VaultSync::fetch_note_body` (T236, spec-defect 136).
//!
//! Real `HttpClient`, real `AuthSession`, real SQLite, real chapter 04 §4.2–§4.12
//! crypto, real `yrs`. The only fakes are the two foreign seams — `Transport`
//! and `SecureStore` — which are foreign by construction (Constitution I).
//! **Nothing here reaches a network.**
//!
//! **Why this file exists at all, and what it must never do.** Every other test
//! of the read surface writes into the database it then reads, which is exactly
//! why nobody noticed that on a real phone *nothing* wrote into it: the read
//! tier had no call site pointing the other way. So the first test below starts
//! from a vault that has never been written to by anything, asserts it is empty,
//! and proves the pull is the only thing that makes it non-empty. A test that
//! seeds a row first proves nothing about the bug this task fixes.
//!
//! | Test                                            | Rule                                  |
//! | ----------------------------------------------- | ------------------------------------- |
//! | an empty vault is filled by the pull, not a fixture | spec-defect 136                    |
//! | a failed bodies pass still leaves the notes visible | never "partly failed" as empty     |
//! | a windowed-out body arrives only on demand      | FR-028, chapter 10 §10.6.1            |
//! | a body fetch for an unknown note is refused     | chapter 07 §7.15                      |
//! | a locked device refuses before the first request | no key, no network                   |

mod http_fakes;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeSecureStore, FakeTransport, error_response, response};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::crypto::derive_vault_key;
use memry_core::api::errors::SyncError;
use memry_core::api::vault::Vault;
use memry_core::crypto::sodium;
use memry_core::protocol::account::{AccountSealer, DeviceSigner};
use memry_core::protocol::auth::DevicePlatform;
use memry_core::protocol::crdt_envelope::{CrdtMaterial, CrdtRequest, pack};
use memry_core::protocol::envelope::SyncOperation;
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use memry_core::seams::transport::HttpResponse;
use memry_core::storage::repositories::instants;
use memry_core::storage::repositories::sync_items::SyncItemRow;
use memry_core::sync::push::{PendingRecord, PushSealer as _};
use serde_json::{Value as Json, json};
use yrs::{
    Doc, ReadTxn as _, StateVector, Transact as _, XmlElementPrelim, XmlFragment as _,
    XmlTextPrelim,
};

// ---------------------------------------------------------------- fixtures

const BASE: &str = "https://sync.example.com";
const NOTE: &str = "abc123def456";
const DEVICE: &str = "device-a";
const MASTER_KEY: [u8; 32] = [7u8; 32];
const SIGNING_SEED: [u8; 32] = [11u8; 32];
/// Deliberately far **outside** any thirty-day window, whenever this suite runs.
/// The first-sync bodies pass is windowed (chapter 10 §10.6.1), so a note this
/// old arrives with its metadata and no body.
const OLD: &str = "2020-01-01T00:00:00.000Z";
/// Deliberately far **inside** it, for the same reason and the opposite effect.
/// Both constants are fixed rather than computed from the clock, so neither
/// test's premise can quietly invert on some future afternoon (defect 133).
const RECENT: &str = "2099-01-01T00:00:00.000Z";

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn scratch_vault(label: &str) -> Vault {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-api-vault-sync-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open")
}

fn descriptor() -> DeviceDescriptor {
    DeviceDescriptor {
        name: "Kaan's iPhone".to_string(),
        platform: DevicePlatform::Ios,
        os_version: Some("27.0".to_string()),
        app_version: "1.4.2".to_string(),
        vault_id: None,
    }
}

/// A session over the two fake seams, carrying an access token and — unless
/// `unlocked` is false — the master key an unlock would have written.
fn session(transport: Arc<FakeTransport>, unlocked: bool) -> Arc<AuthSession> {
    let store = FakeSecureStore::new();
    store.put_text(SecureStoreKey::AccessToken, "access-1");
    if unlocked {
        store
            .set(SecureStoreKey::MasterKey, MASTER_KEY.to_vec())
            .expect("plant the master key");
    }
    Arc::new(
        AuthSession::new(
            transport,
            store,
            BASE.to_string(),
            "ios".to_string(),
            descriptor(),
        )
        .expect("a session"),
    )
}

fn vault_key() -> Vec<u8> {
    derive_vault_key(MASTER_KEY.to_vec()).expect("the account vault key")
}

fn keypair() -> (Vec<u8>, Vec<u8>) {
    let (public, secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    (public, secret.to_vec())
}

/// `GET /auth/devices`, chapter 01 §1.4.0.
fn devices_response(
    public_key: &[u8],
) -> Result<HttpResponse, memry_core::api::errors::TransportError> {
    response(
        200,
        &json!({"devices": [{"id": DEVICE, "signingPublicKey": BASE64.encode(public_key)}]})
            .to_string(),
    )
}

/// A real chapter 04 record envelope, sealed under the account's real vault key
/// by the device the directory above names. Not a placeholder: the exported
/// path builds a real `AccountCipher`, so a scripted cipher would test nothing.
fn sealed_note(secret_key: Vec<u8>, modified_at: &str) -> Json {
    let signer = DeviceSigner::new(DEVICE, secret_key).expect("a signer");
    let sealer = AccountSealer::new(vault_key(), signer);
    sealer
        .seal_record(&PendingRecord {
            operation: SyncOperation::Update,
            row: SyncItemRow {
                item_type: "note".to_owned(),
                item_id: NOTE.to_owned(),
                payload: Some(
                    json!({"title": "A note from the server", "modifiedAt": modified_at})
                        .to_string(),
                ),
                payload_state: "full".to_owned(),
                clock: Some(json!({ DEVICE: 1 }).to_string()),
                field_clocks: None,
                server_cursor: None,
                signer_device_id: None,
                updated_at: 1,
                deleted_at: None,
                corrupt_reason: None,
                corrupt_at: None,
            },
        })
        .expect("seals")
}

fn changes_page(modified_at: &str) -> String {
    json!({
        "items": [{
            "id": NOTE, "type": "note", "version": 1,
            "modifiedAt": instants::to_epoch_ms(modified_at).expect("a parseable instant"),
            "size": 12,
        }],
        "deleted": [],
        "hasMore": false,
        "nextCursor": 10,
    })
    .to_string()
}

/// A `blockContainer > paragraph > text` body, the smallest thing
/// `extract_text` reports a line for.
fn body_update(text: &str) -> Vec<u8> {
    let doc = Doc::with_client_id(99);
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    {
        let mut txn = doc.transact_mut();
        let container = fragment.insert(&mut txn, 0, XmlElementPrelim::empty("blockContainer"));
        let paragraph = container.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
        paragraph.insert(&mut txn, 0, XmlTextPrelim::new(text));
    }
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

fn packed_base64(update: &[u8], secret_key: &[u8]) -> String {
    let packed = pack(
        &CrdtRequest {
            note_id: NOTE,
            update,
            vault_key: &vault_key(),
            signing_secret_key: secret_key,
        },
        &CrdtMaterial::random(),
    )
    .expect("pack");
    BASE64.encode(packed)
}

/// The refs page, the metadata page, and the bootstrap 501 that precedes them.
///
/// Chapter 10 §10.12: a deployment with no bootstrap key answers 501 and the
/// client says nothing about it. Scripting it here is the honest default — the
/// fallback is the path most deployments take.
fn first_sync_script(
    public_key: &[u8],
    secret_key: Vec<u8>,
    modified_at: &str,
) -> Vec<Result<HttpResponse, memry_core::api::errors::TransportError>> {
    vec![
        devices_response(public_key),
        error_response(501, "BOOTSTRAP_UNAVAILABLE", "no bootstrap key"),
        response(200, &changes_page(modified_at)),
        response(
            200,
            &json!({ "items": [sealed_note(secret_key, modified_at)] }).to_string(),
        ),
    ]
}

// ------------------------------------------------------------------ tests

/// **The test this task exists for.** Nothing writes into this vault except the
/// pull, and the assertion before the pull is what makes the one after it mean
/// something.
#[tokio::test]
async fn an_empty_vault_is_filled_by_the_pull_and_by_nothing_else() {
    let vault = scratch_vault("fills");
    let notes = vault.notes();
    let (public, secret) = keypair();

    // A genuinely empty vault: `Vault::open` ran the migrations and that is
    // all. This is the phone Kaan held.
    assert!(
        notes.list().expect("the list").is_empty(),
        "nothing has filled this database yet"
    );
    assert!(
        notes.folders().expect("the folders").is_empty(),
        "and no folder either"
    );

    let transport = FakeTransport::new(first_sync_script(&public, secret, OLD));
    let sync = vault.sync(session(transport.clone(), true));

    assert!(
        !sync.is_first_sync_complete().expect("the meta read"),
        "a vault that has never synced does not claim it has"
    );

    let summary = sync.first_sync(None).await.expect("the first sync");

    assert_eq!(summary.refs_recorded, 1);
    assert_eq!(summary.metadata_applied, 1);
    assert_eq!(summary.metadata_corrupt, 0);
    assert!(!summary.elevated, "§10.12: the 501 fell back silently");
    // The note is older than the window, so the bodies pass asked for nothing
    // and the script ends at the metadata page.
    assert_eq!(summary.bodies, 0);
    assert_eq!(transport.calls_to("/sync/crdt/updates").len(), 0);

    let listed = notes.list().expect("the list");
    assert_eq!(listed.len(), 1, "the pull is what put this row here");
    assert_eq!(listed[0].id, NOTE);
    assert_eq!(listed[0].title, "A note from the server");

    assert!(
        sync.is_first_sync_complete().expect("the meta read"),
        "and the run recorded itself as done"
    );
}

/// A pass that fails part way through must not leave the vault looking empty —
/// which is the shape of spec-defect 136 itself, and of the `/sync/vaults`
/// reader that once reported "no vaults" against an account holding four.
///
/// The metadata landed; the body pass was refused. The honest rendering of that
/// is one note whose body is not here yet, plus the reason the call threw. It is
/// never an empty vault.
#[tokio::test]
async fn a_failed_bodies_pass_still_leaves_the_notes_that_arrived_visible() {
    let vault = scratch_vault("partial");
    let notes = vault.notes();
    let (public, secret) = keypair();

    // A recent note, so the bodies pass runs — and §7.8's snapshot probe is
    // refused by the server. A 403 rather than a 500 deliberately: chapter 00
    // §0.6.1's ladder retries 5xx, so a 500 here would be three more scripted
    // responses and would be testing the ladder rather than the rule.
    let mut script = first_sync_script(&public, secret, RECENT);
    script.push(error_response(
        403,
        "SYNC_VAULT_FORBIDDEN",
        "not your vault",
    ));
    let transport = FakeTransport::new(script);
    let sync = vault.sync(session(transport.clone(), true));

    let error = sync
        .first_sync(None)
        .await
        .expect_err("the bodies pass failed");
    assert!(
        matches!(error, SyncError::Api { .. }),
        "a non-2xx crosses as a response, never as a transport failure: {error:?}"
    );

    let listed = notes.list().expect("the list");
    assert_eq!(listed.len(), 1, "the note that arrived is still here");
    assert_eq!(listed[0].id, NOTE);
    assert!(
        !sync.is_first_sync_complete().expect("the meta read"),
        "and the run did not record itself as done"
    );
}

/// FR-028's "older content on demand". The body of a windowed-out note is not
/// missing data — it is data the first sync deliberately did not ask for, and
/// `fetch_note_body` is the only way it can ever arrive.
#[tokio::test]
async fn a_windowed_out_body_arrives_only_through_the_on_demand_fetch() {
    let vault = scratch_vault("ondemand");
    let notes = vault.notes();
    let (public, secret) = keypair();

    let transport = FakeTransport::new(first_sync_script(&public, secret.clone(), OLD));
    let sync = vault.sync(session(transport.clone(), true));
    sync.first_sync(None).await.expect("the first sync");

    let before = notes
        .read(NOTE.to_string())
        .expect("the read")
        .expect("the note");
    assert!(
        !before.body.present,
        "the metadata arrived and the body did not, and the read says so"
    );
    assert_eq!(before.body.text, "");

    // The second script: the directory again, then §7.8's snapshot probe, then
    // the update itself.
    let update = body_update("Hello from the server");
    let transport = FakeTransport::new(vec![
        devices_response(&public),
        response(200, &json!({ "snapshot": Json::Null }).to_string()),
        response(
            200,
            &json!({"updates": [{
                "sequenceNum": 1,
                "data": packed_base64(&update, &secret),
                "createdAt": 1_700_000_000_000i64,
                "signerDeviceId": DEVICE,
            }], "hasMore": false})
            .to_string(),
        ),
    ]);
    let sync = vault.sync(session(transport.clone(), true));

    let fetched = sync
        .fetch_note_body(NOTE.to_string())
        .await
        .expect("the fetch");
    assert_eq!(fetched.updates, 1);
    assert!(!fetched.stopped);

    let after = notes
        .read(NOTE.to_string())
        .expect("the read")
        .expect("the note");
    assert!(after.body.present);
    assert_eq!(after.body.text, "Hello from the server");
}

/// Chapter 07 §7.15: the server answers with the surviving log of a document
/// the record feed says is gone, so a body fetched for a note this vault has no
/// live record of would land with no row to hang it on. Refused, and refused
/// **before** any request — a permanent answer, never a transient one.
#[tokio::test]
async fn a_body_fetch_for_a_note_this_vault_does_not_hold_is_refused() {
    let vault = scratch_vault("unknown");
    let transport = FakeTransport::new(vec![]);
    let sync = vault.sync(session(transport.clone(), true));

    let error = sync
        .fetch_note_body(NOTE.to_string())
        .await
        .expect_err("refused");
    assert_eq!(
        error,
        SyncError::UnknownNote {
            id: NOTE.to_string()
        }
    );
    assert_eq!(transport.call_count(), 0, "and nothing was asked of anyone");
}

/// No master key means no vault key, and a pull with no vault key could only
/// record every item as corrupt. It refuses before the first request, and the
/// variant says "locked", not "the network failed" and not "the keychain is
/// locked" — three different remedies.
#[tokio::test]
async fn a_device_that_has_never_unlocked_refuses_before_it_asks_anything() {
    let vault = scratch_vault("locked");
    let transport = FakeTransport::new(vec![]);
    let sync = vault.sync(session(transport.clone(), false));

    let error = sync.first_sync(None).await.expect_err("refused");
    assert_eq!(error, SyncError::Locked);
    assert_eq!(transport.call_count(), 0);
}
