//! Sign-out through the IPC a renderer calls (`sync_logout`), on a mock app over a real
//! `AccountService`, `BillingService` and `memry-config.json`, with the server scripted.

#[allow(
    dead_code,
    reason = "only the open, invoke and memory keychain of the harness are used"
)]
mod support;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, mpsc};

use memry_core::api::errors::TransportError;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_desktop::account::{AccountService, device};
use memry_desktop::billing::{BillingService, OpenFailed, UrlOpener};
use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::registry::AppConfig;
use serde_json::{Value, json};
use support::{MemoryStore, Mocked, WAIT};
use tauri::Manager;
use tauri::test::MockRuntime;
use tauri_specta::collect_commands;

/// `{"sub":"u","device_id":"server-device","exp":4102444800}`, unsigned: the session reads the
/// claims and the scripted server checks nothing.
const ACCESS_TOKEN: &str = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.\
    eyJzdWIiOiJ1IiwiZGV2aWNlX2lkIjoic2VydmVyLWRldmljZSIsImV4cCI6NDEwMjQ0NDgwMH0.c2ln";
const STATUS: &str = "https://sync.test/auth/billing";

/// Answers the billing status with a paid plan once `release` fires, telling `asked` it
/// arrived; every other request (the session's logout) is `200 {}`.
struct Server {
    asked: Mutex<mpsc::Sender<()>>,
    release: Arc<tokio::sync::Notify>,
}

#[async_trait::async_trait]
impl Transport for Server {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        let body = if request.url == STATUS {
            self.asked.lock().unwrap().send(()).unwrap();
            self.release.notified().await;
            json!({
                "plan": "plus", "cadence": "monthly", "status": "active", "source": "paddle",
                "email": "a@b.c",
                "limits": {
                    "storageLimit": 1_073_741_824, "maxFileSize": 5_242_880, "maxVaults": 1,
                    "versionHistoryDays": 30,
                },
                "usage": { "storageUsed": 0 },
                "expiresAt": null,
                "canManageBilling": true,
            })
        } else {
            json!({})
        };
        Ok(HttpResponse {
            status: 200,
            headers: HashMap::new(),
            body: body.to_string().into_bytes(),
        })
    }

    fn open_socket(
        &self,
        _request: SocketRequest,
        _listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        Err(TransportError::Failed {
            what: "no sockets".into(),
        })
    }
}

struct NoBrowser;

impl UrlOpener for NoBrowser {
    fn open(&self, _url: &str) -> Result<(), OpenFailed> {
        Err(OpenFailed::Failed)
    }
}

/// Account A's plan answers after A signed out through `sync_logout`: the next account starts
/// with no cached verdict and no file limit of A's.
#[test]
fn a_plan_answer_landing_after_sync_logout_is_not_kept() {
    let commands = tauri_specta::Builder::new()
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .commands(collect_commands![
            memry_tauri::commands::sync_account::sync_logout::<MockRuntime>,
        ]);
    let mocked = Mocked::open(&[], commands);
    let dir = tempfile::tempdir().unwrap();
    let config = Arc::new(AppConfig::load(dir.path().join("memry-config.json")));
    let keychain = Arc::new(MemoryStore::default());
    for (key, value) in [
        (SecureStoreKey::MasterKey, vec![9; 32]),
        (
            SecureStoreKey::DeviceSigningKey,
            memry_core::crypto::sodium::sign_seed_keypair(&[7; 32])
                .unwrap()
                .1
                .to_vec(),
        ),
        (
            SecureStoreKey::AccessToken,
            ACCESS_TOKEN.as_bytes().to_vec(),
        ),
        (SecureStoreKey::RefreshToken, b"refresh".to_vec()),
    ] {
        keychain.set(key, value).unwrap();
    }
    let (asked, arrived) = mpsc::channel();
    let release = Arc::new(tokio::sync::Notify::new());
    let server = Arc::new(Server {
        asked: Mutex::new(asked),
        release: release.clone(),
    });
    let account = Arc::new(
        AccountService::new(
            server,
            keychain,
            "https://sync.test".into(),
            device::descriptor("1.0.0"),
            config.clone(),
        )
        .unwrap(),
    );
    let billing = Arc::new(BillingService::new(
        account.clone(),
        config.clone(),
        Arc::new(NoBrowser),
        mocked.session().inner().clone(),
        None,
        tauri::async_runtime::handle().inner().clone(),
        &LaunchEnv::default(),
    ));
    mocked.webview.manage(account);
    mocked.webview.manage(billing.clone());

    let asking = billing.clone();
    let status = tauri::async_runtime::spawn(async move { asking.status().await });
    arrived.recv_timeout(WAIT).expect("the status is in flight");

    let signed_out = mocked.invoke("sync_logout", json!({})).unwrap();
    assert_eq!(signed_out["success"], json!(true));
    release.notify_one();
    tauri::async_runtime::block_on(status).unwrap().unwrap();

    let entitlement = config.read(|c| c.get("sync").and_then(|s| s.get("entitlement")).cloned());
    assert_eq!(entitlement.unwrap_or(Value::Null), Value::Null);
    assert_eq!(billing.max_file_size(), None);
}
