//! `VaultSyncBackend` over a real `Vault`: the at-rest key it installs never outlives an open
//! that failed.

use std::sync::Arc;

use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::vault::Vault;
use memry_core::crypto::agent_envelope::Purpose;
use memry_core::protocol::auth::DevicePlatform;
use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use memry_core::seams::secure_store::SecureStoreKey;
use memry_desktop::seams::tls::{PinFailure, PinFailureSink};
use memry_desktop::seams::transport::app_transport;
use memry_desktop::sync::backend::{SyncBackend, VaultSyncBackend};

use crate::device_key;

struct NoPins;

impl PinFailureSink for NoPins {
    fn pin_failed(&self, failure: PinFailure) {
        panic!("no request is sent: {}", failure.hostname);
    }
}

struct Online;

impl Reachability for Online {
    fn current(&self) -> Reachable {
        Reachable::Wifi
    }
    fn observe(&self, _observer: Arc<dyn ReachabilityObserver>) {}
}

/// The vault is bound to no server vault, so `sync_driver` fails after the key went in.
#[tokio::test]
async fn a_failed_open_leaves_no_at_rest_key() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("vault").join(".memry").join("core");
    std::fs::create_dir_all(&data).unwrap();
    let vault =
        Arc::new(Vault::open("unbound".into(), data.to_string_lossy().into_owned()).unwrap());
    let store = device_key::with_device_key();
    store.set(SecureStoreKey::MasterKey, vec![9u8; 32]).unwrap();
    let session = AuthSession::new(
        app_transport(&["127.0.0.1".to_owned()], Arc::new(NoPins)),
        store.clone(),
        "http://127.0.0.1:9".into(),
        "desktop".into(),
        DeviceDescriptor {
            name: "unbound".into(),
            platform: DevicePlatform::Macos,
            form_factor: None,
            os_version: None,
            app_version: "1.0.0".into(),
            vault_id: None,
        },
    )
    .unwrap();
    let backend = VaultSyncBackend::new(
        Arc::clone(&vault),
        Arc::new(session),
        store,
        Arc::new(Online),
        Vec::new(),
        Arc::new(|| (true, true)),
    );

    assert!(
        backend.open().await.is_err(),
        "an unbound vault does not sync"
    );
    assert!(
        vault
            .at_rest_key()
            .seal(Purpose::MessageContent, "x")
            .is_err(),
        "the key installed for the open is gone"
    );
}
