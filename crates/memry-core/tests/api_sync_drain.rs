//! `VaultSync::drain_bodies` (#5233): the bodies a first sync left owed, one
//! bounded round per call, while the shell is in the foreground.
//!
//! Real `HttpClient`, `AuthSession`, SQLite and update log; only the transport
//! and the secure store are fakes.

mod http_fakes;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeSecureStore, FakeTransport, jwt, response, response_with_header};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::errors::{StorageError, TransportError};
use memry_core::api::sync::{SyncPhase, SyncProgress, SyncProgressListener};
use memry_core::api::vault::Vault;
use memry_core::crypto::sodium;
use memry_core::protocol::auth::DevicePlatform;
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use memry_core::seams::transport::HttpResponse;
use memry_core::storage::Db;
use memry_core::sync::body_debt;
use serde_json::json;

const BASE: &str = "https://sync.example.com";
const MASTER_KEY: [u8; 32] = [7u8; 32];
const SIGNING_SEED: [u8; 32] = [11u8; 32];

static SCRATCH: AtomicU64 = AtomicU64::new(0);

type Answer = Result<HttpResponse, TransportError>;

fn vault_with_side(label: &str, transport: Arc<FakeTransport>) -> (Vault, Db, Arc<AuthSession>) {
    let (_public, secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    let store = FakeSecureStore::new();
    store.put_text(
        SecureStoreKey::AccessToken,
        &jwt(json!({"sub": "user-1", "device_id": "server-device-1", "type": "access", "exp": 9_999_999_999u64})),
    );
    store
        .set(SecureStoreKey::MasterKey, MASTER_KEY.to_vec())
        .expect("plant the master key");
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-api-sync-drain-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    let vault = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    let side = memry_core::storage::open_data(&dir.join("data.db")).expect("a second handle");
    let session = Arc::new(
        AuthSession::new(
            transport,
            store,
            BASE.to_string(),
            "ios".to_string(),
            DeviceDescriptor {
                name: "Phone".to_string(),
                platform: DevicePlatform::Ios,
                form_factor: None,
                os_version: None,
                app_version: "1.0.0".to_string(),
                vault_id: None,
            },
        )
        .expect("a session"),
    );
    (vault, side, session)
}

/// `count` live notes, every one owed a body and holding a body cursor, so
/// the round probes them first (§7.8).
fn owed_notes(side: &Db, count: usize) -> Vec<String> {
    let ids: Vec<String> = (0..count)
        .map(|index| format!("drained{index:05}"))
        .collect();
    let seeded = ids.clone();
    side.call_blocking(move |conn| {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, 'done')",
            [memry_core::sync::note_body_feed::META_NOTE_BODY_LEGACY_PULL],
        )
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })?;
        for id in &seeded {
            memry_core::domain::notes::create(
                conn,
                &memry_core::domain::notes::NewNote {
                    id,
                    title: "From another device",
                    folder_path: Some("Notes"),
                    content: "",
                    tags: &[],
                    properties: None,
                    emoji: None,
                },
                "device-b",
                1_760_000_000_000,
            )?;
            memry_core::sync::store::write_cursor(conn, &format!("crdt:{id}"), Some("5"), 1)?;
            body_debt::owe(conn, id)?;
        }
        Ok(())
    })
    .expect("owed notes");
    ids
}

fn owed(side: &Db) -> Vec<String> {
    side.call_blocking(|conn| body_debt::owed(conn))
        .expect("the owed documents")
}

fn devices() -> Answer {
    let (public, _secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    response(
        200,
        &json!({"devices": [{"id": "server-device-1", "signingPublicKey": BASE64.encode(&public)}]})
            .to_string(),
    )
}

/// A deployment with no bootstrap HMAC key (§10.12): the round runs at one
/// stream.
fn no_bootstrap() -> Answer {
    response(
        501,
        r#"{"error":{"code":"BOOTSTRAP_UNAVAILABLE","message":"not configured"}}"#,
    )
}

fn probe_page() -> Answer {
    response(200, &json!({"notes": {}}).to_string())
}

fn updates_page() -> Answer {
    response(200, &json!({"updates": [], "hasMore": false}).to_string())
}

#[derive(Default)]
struct Recorded(Mutex<Vec<SyncProgress>>);

impl SyncProgressListener for Recorded {
    fn progress(&self, progress: SyncProgress) {
        self.0.lock().unwrap().push(progress);
    }
}

#[tokio::test]
async fn a_round_pulls_every_owed_body_and_counts_documents_of_the_vault() {
    let transport = FakeTransport::new(vec![]);
    let (vault, side, session) = vault_with_side("all", transport.clone());
    owed_notes(&side, 3);
    for answer in [devices(), no_bootstrap(), probe_page()] {
        transport.push(answer);
    }
    for _ in 0..3 {
        transport.push(updates_page());
    }

    let progress = Arc::new(Recorded::default());
    let summary = vault
        .sync(session)
        .drain_bodies(Some(progress.clone()))
        .await
        .expect("the round");

    assert_eq!(summary.documents, 3, "{summary:?}");
    assert_eq!(summary.remaining, 0, "{summary:?}");
    assert!(!summary.elevated);
    assert!(owed(&side).is_empty());
    let ticks: Vec<(SyncPhase, u64, Option<u64>)> = progress
        .0
        .lock()
        .unwrap()
        .iter()
        .map(|tick| (tick.phase, tick.completed, tick.total))
        .collect();
    assert_eq!(
        ticks,
        (0..=3)
            .map(|done| (SyncPhase::Bodies, done, Some(3)))
            .collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn a_round_with_nothing_owed_makes_no_request() {
    // The script is empty: any request panics the transport.
    let transport = FakeTransport::new(vec![]);
    let (vault, _side, session) = vault_with_side("nothing", transport.clone());

    let summary = vault
        .sync(session)
        .drain_bodies(None)
        .await
        .expect("the round");

    assert_eq!((summary.documents, summary.remaining), (0, 0));
    assert_eq!(transport.call_count(), 0);
}

#[tokio::test]
async fn a_rate_limit_ends_the_round_and_leaves_the_rest_owed_for_the_next() {
    let transport = FakeTransport::new(vec![]);
    let (vault, side, session) = vault_with_side("rate-limited", transport.clone());
    let ids = owed_notes(&side, 3);
    for answer in [devices(), no_bootstrap(), probe_page(), updates_page()] {
        transport.push(answer);
    }
    transport.push(response(
        429,
        r#"{"error":{"code":"RATE_LIMITED","message":"slow down"}}"#,
    ));

    let first = vault
        .sync(Arc::clone(&session))
        .drain_bodies(None)
        .await
        .expect("a 429 ends the round, it does not fail it");
    assert_eq!((first.documents, first.remaining), (1, 2), "{first:?}");
    assert_eq!(owed(&side), ids[1..].to_vec());

    for answer in [
        devices(),
        no_bootstrap(),
        probe_page(),
        updates_page(),
        updates_page(),
    ] {
        transport.push(answer);
    }
    let second = vault
        .sync(session)
        .drain_bodies(None)
        .await
        .expect("the next round");
    assert_eq!((second.documents, second.remaining), (2, 0), "{second:?}");
}

/// #5247 C40.2: a round a `429` ended after pulling something is not
/// followed at once by another: until the server's `Retry-After` the next
/// round makes no request and pulls nothing, which pauses the shell's drain.
#[tokio::test(start_paused = true)]
async fn a_round_after_a_rate_limit_waits_out_the_retry_after() {
    let transport = FakeTransport::new(vec![]);
    let (vault, side, session) = vault_with_side("retry-after", transport.clone());
    let ids = owed_notes(&side, 3);
    for answer in [devices(), no_bootstrap(), probe_page(), updates_page()] {
        transport.push(answer);
    }
    transport.push(response_with_header(
        429,
        r#"{"error":{"code":"RATE_LIMITED","message":"slow down"}}"#,
        ("retry-after", "30"),
    ));
    let sync = vault.sync(session);

    let first = sync.drain_bodies(None).await.expect("the round");
    assert_eq!((first.documents, first.remaining), (1, 2), "{first:?}");

    let calls = transport.call_count();
    let paused = sync.drain_bodies(None).await.expect("the paused round");
    assert_eq!((paused.documents, paused.remaining), (0, 2), "{paused:?}");
    assert_eq!(
        transport.call_count(),
        calls,
        "no request inside Retry-After"
    );
    assert_eq!(owed(&side), ids[1..].to_vec());

    tokio::time::advance(std::time::Duration::from_secs(30)).await;
    for answer in [
        devices(),
        no_bootstrap(),
        probe_page(),
        updates_page(),
        updates_page(),
    ] {
        transport.push(answer);
    }
    let resumed = sync.drain_bodies(None).await.expect("the next round");
    assert_eq!(
        (resumed.documents, resumed.remaining),
        (2, 0),
        "{resumed:?}"
    );
}

/// A `Retry-After` past any sane window neither panics the round nor parks
/// the drain for the life of the process: the pause is capped at ten minutes.
#[tokio::test(start_paused = true)]
async fn an_absurd_retry_after_is_capped() {
    let transport = FakeTransport::new(vec![]);
    let (vault, side, session) = vault_with_side("retry-after-cap", transport.clone());
    owed_notes(&side, 2);
    for answer in [devices(), no_bootstrap(), probe_page(), updates_page()] {
        transport.push(answer);
    }
    transport.push(response_with_header(
        429,
        r#"{"error":{"code":"RATE_LIMITED","message":"slow down"}}"#,
        ("retry-after", &u64::MAX.to_string()),
    ));
    let sync = vault.sync(session);

    let first = sync.drain_bodies(None).await.expect("the round");
    assert_eq!((first.documents, first.remaining), (1, 1), "{first:?}");

    tokio::time::advance(std::time::Duration::from_secs(600)).await;
    for answer in [devices(), no_bootstrap(), probe_page(), updates_page()] {
        transport.push(answer);
    }
    let resumed = sync.drain_bodies(None).await.expect("the next round");
    assert_eq!(
        (resumed.documents, resumed.remaining),
        (1, 0),
        "{resumed:?}"
    );
}

#[tokio::test]
async fn a_granted_session_widens_the_round_and_is_closed_after_it() {
    let transport = FakeTransport::new(vec![]);
    let (vault, side, session) = vault_with_side("elevated", transport.clone());
    owed_notes(&side, 2);
    transport.push(devices());
    transport.push(response(
        200,
        &json!({"session": {"token": "boot-token", "expiresAt": 4_000_000_000i64}, "tailCursor": 10})
            .to_string(),
    ));
    for answer in [probe_page(), updates_page(), updates_page()] {
        transport.push(answer);
    }
    transport.push(response(200, &json!({"success": true}).to_string()));

    let summary = vault
        .sync(session)
        .drain_bodies(None)
        .await
        .expect("the round");

    assert!(summary.elevated, "{summary:?}");
    assert_eq!(summary.remaining, 0);
    assert_eq!(transport.calls_to("/sync/bootstrap/close").len(), 1);
}
