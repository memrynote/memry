//! The shell's one registered sink sees a real first sync and a real drain
//! round through the exported API (#5215).
//!
//! The sink is a process-global, so this binary holds a single test: a second
//! one would run alongside it and report into the same sink. Real `HttpClient`,
//! `AuthSession`, SQLite and update log; only the transport and the secure
//! store are fakes.

use crate::http_fakes;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use http_fakes::{FakeSecureStore, FakeTransport, jwt, response};
use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::diagnostics::set_diagnostics_sink;
use memry_core::api::errors::{StorageError, TransportError};
use memry_core::api::vault::Vault;
use memry_core::crypto::sodium;
use memry_core::protocol::auth::DevicePlatform;
use memry_core::seams::diagnostics::{
    BootstrapOutcome, CoreDiagnostic, DiagnosticPhase, DiagnosticsSink,
};
use memry_core::seams::secure_store::{SecureStore as _, SecureStoreKey};
use memry_core::seams::transport::HttpResponse;
use memry_core::storage::Db;
use memry_core::sync::body_debt;
use serde_json::json;

const BASE: &str = "https://sync.example.com";
const MASTER_KEY: [u8; 32] = [7u8; 32];
const SIGNING_SEED: [u8; 32] = [11u8; 32];

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
    let dir: PathBuf = crate::support::scratch_dir(&format!("api-sync-diagnostics-{label}")).keep();
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
            None,
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

fn devices() -> Answer {
    let (public, _secret) = sodium::sign_seed_keypair(&SIGNING_SEED).expect("a keypair");
    response(
        200,
        &json!({"devices": [{"id": "server-device-1", "signingPublicKey": BASE64.encode(&public)}]})
            .to_string(),
    )
}

fn probe_page() -> Answer {
    response(200, &json!({"notes": {}}).to_string())
}

fn updates_page() -> Answer {
    response(200, &json!({"updates": [], "hasMore": false}).to_string())
}

fn granted() -> Answer {
    response(
        200,
        &json!({"session": {"token": "boot-token", "expiresAt": 4_000_000_000i64}, "tailCursor": 10})
            .to_string(),
    )
}

#[derive(Default)]
struct Captured(Mutex<Vec<CoreDiagnostic>>);

impl Captured {
    /// What arrived since the last call.
    fn take(&self) -> Vec<CoreDiagnostic> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

impl DiagnosticsSink for Captured {
    fn record(&self, event: CoreDiagnostic) {
        self.0.lock().unwrap().push(event);
    }
}

/// The request count of the one final `PhaseStats` of `phase`.
fn finished_requests(events: &[CoreDiagnostic], phase: DiagnosticPhase) -> u32 {
    let counts: Vec<u32> = events
        .iter()
        .filter_map(|event| match event {
            CoreDiagnostic::PhaseStats {
                phase: seen,
                finished: true,
                requests,
                ..
            } if *seen == phase => Some(requests.requests),
            _ => None,
        })
        .collect();
    assert_eq!(counts.len(), 1, "{events:?}");
    counts[0]
}

// Registers the process-global sink, so this must stay the binary's only test.
#[tokio::test]
async fn the_registered_sink_hears_a_first_sync_and_a_drain_round_and_counts_only_their_requests() {
    let sink = Arc::new(Captured::default());
    set_diagnostics_sink(sink.clone());

    // An empty vault's first sync: the device directory and the bootstrap
    // open and close are the session's, and are not counted.
    let transport = FakeTransport::new(vec![]);
    let (vault, _side, session) = vault_with_side("first", transport.clone());
    for answer in [
        devices(),
        granted(),
        response(
            404,
            r#"{"error":{"code":"NOT_FOUND","message":"no pack route"}}"#,
        ),
        response(
            200,
            &json!({"items": [], "deleted": [], "hasMore": false, "nextCursor": 10}).to_string(),
        ),
        response(
            404,
            r#"{"error":{"code":"NOT_FOUND","message":"no pack route"}}"#,
        ),
        response(200, &json!({"success": true}).to_string()),
    ] {
        transport.push(answer);
    }
    vault
        .sync(session)
        .first_sync(None)
        .await
        .expect("the first sync");

    let events = sink.take();
    assert_eq!(
        events[0],
        CoreDiagnostic::BootstrapOpened {
            outcome: BootstrapOutcome::Granted,
            status: 200,
        },
        "{events:?}"
    );
    assert_eq!(finished_requests(&events, DiagnosticPhase::RecordPacks), 1);
    assert_eq!(finished_requests(&events, DiagnosticPhase::Refs), 1);
    assert_eq!(finished_requests(&events, DiagnosticPhase::BodyPacks), 1);

    // A drain round of two owed notes under a granted session.
    let transport = FakeTransport::new(vec![]);
    let (vault, side, session) = vault_with_side("drain", transport.clone());
    owed_notes(&side, 2);
    transport.push(devices());
    transport.push(granted());
    for answer in [probe_page(), updates_page(), updates_page()] {
        transport.push(answer);
    }
    transport.push(response(200, &json!({"success": true}).to_string()));
    vault
        .sync(session)
        .drain_bodies(None)
        .await
        .expect("the round");

    let events = sink.take();
    assert_eq!(
        events[..2],
        [
            CoreDiagnostic::BootstrapOpened {
                outcome: BootstrapOutcome::Granted,
                status: 200,
            },
            CoreDiagnostic::BodyPassStarted {
                elevated: true,
                concurrency: 2,
                documents: 2,
                up_to_date: None,
            },
        ],
        "{events:?}"
    );
    assert_eq!(
        finished_requests(&events, DiagnosticPhase::DrainBodies),
        3,
        "the probe and the two documents' updates, not the open, the close or the directory"
    );
}
