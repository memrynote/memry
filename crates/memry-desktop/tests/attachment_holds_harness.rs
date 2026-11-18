//! Chunk holds against the real sync Worker (`--features harness`, the server of
//! `tests/sync_harness.rs`), through the desktop transport and `memry_core`'s `holds` (#3535,
//! Step 18 S4, chapter 14 §14.8.1 and §14.8.2). The server sweep is the Worker's cron
//! (`Server::purge`), which runs `cleanupOrphanedBlobChunks`.
//!
//! | Test                                                              | Rule                        |
//! | ----------------------------------------------------------------- | --------------------------- |
//! | a hold keeps a dereferenced chunk live until its release          | §14.8.1 holds, sweep, replay |
//! | a probe holds nothing past itself and finds a freed attachment    | §14.8.2 `probeNoteAttachments` |

#![cfg(feature = "harness")]

#[path = "device_key/mod.rs"]
mod device_key;
#[path = "harness_server/mod.rs"]
mod harness_server;

use std::collections::BTreeSet;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use harness_server::{NoPins, Server};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::crypto::keys;
use memry_core::protocol::attachment_upload::{
    complete, dereference, frame_chunks, initiate, put_chunk,
};
use memry_core::protocol::auth::DevicePlatform;
use memry_core::protocol::http::HttpClient;
use memry_core::seams::secure_store::SecureStoreKey;
use memry_core::sync::attachments::holds::{
    self, AttachmentChunks, HoldOutcome, Holder, canvas_asset_holder_id,
};
use memry_desktop::seams::transport::app_transport;

const MASTER_KEY: [u8; 32] = [9u8; 32];
const VAULT_ID: &str = "default";

/// The server's device 0, signed in.
fn session(server: &Server) -> AuthSession {
    let boot = &server.devices[0];
    let secret = BASE64
        .decode(boot["signingSecretKey"].as_str().unwrap())
        .unwrap();
    let store = device_key::with_device_key();
    store.set(SecureStoreKey::DeviceSigningKey, secret).unwrap();
    let token = boot["accessToken"].as_str().unwrap().as_bytes().to_vec();
    store.set(SecureStoreKey::AccessToken, token).unwrap();
    AuthSession::new(
        app_transport(&["127.0.0.1".to_owned()], Arc::new(NoPins)),
        store,
        server.url.clone(),
        "desktop".into(),
        DeviceDescriptor {
            name: "harness-holds".into(),
            platform: DevicePlatform::Macos,
            form_factor: None,
            os_version: None,
            app_version: "1.0.0".into(),
            vault_id: None,
        },
        None,
    )
    .unwrap()
}

/// Uploads `len` bytes in 1 KiB chunks and returns the chunk hashes the server keys them by.
async fn upload(http: &HttpClient, attachment_id: &str, len: usize, seed: u8) -> Vec<String> {
    let plain: Vec<u8> = (0..len)
        .map(|i| (i as u8).wrapping_mul(31) ^ seed)
        .collect();
    let chunks = frame_chunks(&plain, &[seed; 32], 1024, |i| vec![seed ^ i as u8; 24]).unwrap();
    let upload = initiate(
        http,
        VAULT_ID,
        attachment_id,
        "file.bin",
        len as u64,
        &chunks,
    )
    .await
    .expect("initiate");
    for chunk in &chunks {
        put_chunk(http, VAULT_ID, &upload.session_id, chunk)
            .await
            .expect("a chunk");
    }
    complete(http, VAULT_ID, &upload.session_id, &[])
        .await
        .expect("complete");
    chunks
        .iter()
        .map(|c| c.reference.encrypted_hash.clone())
        .collect()
}

fn held(missing: &[&str]) -> HoldOutcome {
    HoldOutcome::Held {
        missing: missing.iter().map(|m| (*m).to_owned()).collect(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hold_keeps_a_dereferenced_chunk_live_until_its_release() {
    let mut server = Server::start();
    let auth = session(&server);
    let http = auth.http();
    let key = keys::derive_vault_key(&MASTER_KEY).unwrap();
    let chunks = upload(&http, "a1b2c3d4e5f60718293a4b5c6d7e8f90", 3 * 1024, 1).await;
    assert_eq!(chunks.len(), 3);
    let holder = |image: &str| Holder {
        holder_id: canvas_asset_holder_id(&key, "canvas-1", image).unwrap(),
        chunk_hashes: chunks.clone(),
    };
    let (a, b, c, d) = (holder("a"), holder("b"), holder("c"), holder("d"));

    assert_eq!(
        holds::hold(&http, VAULT_ID, &[a.clone()]).await,
        held(&[]),
        "live chunks hold"
    );
    assert_eq!(
        holds::hold(&http, VAULT_ID, &[a.clone()]).await,
        held(&[]),
        "holding again is a no-op"
    );

    // The uploader frees them; the hold keeps them through the sweep.
    dereference(&http, VAULT_ID, &chunks)
        .await
        .expect("dereference");
    server.purge();
    assert_eq!(
        holds::hold(&http, VAULT_ID, &[b.clone()]).await,
        held(&[]),
        "a held chunk is live at ref_count 0 and survives the sweep"
    );
    holds::release(&http, VAULT_ID, &[b.holder_id.clone()])
        .await
        .unwrap();

    // The last hold goes: the chunks are dead, and a replayed release changes nothing.
    holds::release(&http, VAULT_ID, &[a.holder_id.clone()])
        .await
        .unwrap();
    holds::release(&http, VAULT_ID, &[a.holder_id.clone()])
        .await
        .unwrap();
    server.purge();
    assert_eq!(
        holds::hold(&http, VAULT_ID, &[c.clone()]).await,
        held(&[c.holder_id.as_str()]),
        "a dereferenced, unheld, swept chunk is missing"
    );
    holds::release(&http, VAULT_ID, &[a.holder_id.clone()])
        .await
        .unwrap();
    assert_eq!(
        holds::hold(&http, VAULT_ID, &[d.clone()]).await,
        held(&[d.holder_id.as_str()]),
        "a release replay brought nothing back"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_probe_holds_nothing_past_itself_and_finds_a_freed_attachment() {
    let mut server = Server::start();
    let auth = session(&server);
    let http = auth.http();
    let key = keys::derive_vault_key(&MASTER_KEY).unwrap();
    let live = AttachmentChunks {
        attachment_id: "11111111111111111111111111111111".into(),
        chunk_hashes: upload(&http, "11111111111111111111111111111111", 2 * 1024, 2).await,
    };
    let freed = AttachmentChunks {
        attachment_id: "22222222222222222222222222222222".into(),
        chunk_hashes: upload(&http, "22222222222222222222222222222222", 1024, 3).await,
    };
    let both = [live.clone(), freed.clone()];

    let first = holds::probe_note_attachments(&http, VAULT_ID, &key, "note-1", &both)
        .await
        .unwrap();
    assert_eq!(first, held(&[]), "both are stored");

    // Had the probe kept its holds, `freed` would stay live under them.
    dereference(&http, VAULT_ID, &freed.chunk_hashes)
        .await
        .unwrap();
    server.purge();
    let second = holds::probe_note_attachments(&http, VAULT_ID, &key, "note-1", &both)
        .await
        .unwrap();
    let missing: BTreeSet<String> = [freed.attachment_id.clone()].into();
    assert_eq!(
        second,
        HoldOutcome::Held { missing },
        "only the freed one is gone"
    );
}
