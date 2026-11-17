//! `VaultSyncBackend` over a real `Vault`: the at-rest key it installs never outlives an open
//! that failed, and a keychain that does not answer is retried by reading only.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use memry_core::api::auth::{AuthSession, DeviceDescriptor};
use memry_core::api::errors::{SecureStoreError, SyncError};
use memry_core::api::vault::Vault;
use memry_core::crypto::agent_envelope::Purpose;
use memry_core::protocol::auth::DevicePlatform;
use memry_core::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::storage::open_data;
use memry_desktop::seams::tls::{PinFailure, PinFailureSink};
use memry_desktop::seams::transport::app_transport;
use memry_desktop::sync::backend::{SyncBackend, VaultSyncBackend};
use memry_desktop::sync::error_category::SyncErrorCategory;
use memry_desktop::sync::gate::{Entitlement, SyncStartGate, VaultBinding};
use memry_desktop::sync::supervisor::{SupervisorParts, SyncSupervisor};

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

/// A vault bound to no server vault, over `store`: `sync_driver` fails after the key went in.
fn unbound(dir: &std::path::Path, store: Arc<dyn SecureStore>) -> (Arc<Vault>, VaultSyncBackend) {
    let data = dir.join("vault").join(".memry").join("core");
    std::fs::create_dir_all(&data).unwrap();
    let vault =
        Arc::new(Vault::open("unbound".into(), data.to_string_lossy().into_owned()).unwrap());
    let session = AuthSession::new(
        app_transport(&["127.0.0.1".to_owned()], Arc::new(NoPins)),
        Arc::clone(&store),
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
        None,
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
    (vault, backend)
}

#[tokio::test]
async fn a_failed_open_leaves_no_at_rest_key() {
    let dir = tempfile::tempdir().unwrap();
    let store = device_key::with_device_key();
    store.set(SecureStoreKey::MasterKey, vec![9u8; 32]).unwrap();
    let (vault, backend) = unbound(dir.path(), store);

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

/// A keychain that answers `Locked` while `locked` is set, counting every call.
struct LockedStore {
    inner: Arc<dyn SecureStore>,
    locked: AtomicBool,
    reads: AtomicUsize,
    /// Writes, deletes and clears.
    changes: AtomicUsize,
}

impl SecureStore for LockedStore {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if self.locked.load(Ordering::SeqCst) {
            return Err(SecureStoreError::Locked);
        }
        self.inner.get(key)
    }
    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        self.changes.fetch_add(1, Ordering::SeqCst);
        self.inner.set(key, value)
    }
    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        self.changes.fetch_add(1, Ordering::SeqCst);
        self.inner.delete(key)
    }
    fn clear(&self) -> Result<(), SecureStoreError> {
        self.changes.fetch_add(1, Ordering::SeqCst);
        self.inner.clear()
    }
}

/// `keychain-retry.ts`: a locked keychain is read again along the ladder and on recovery, and
/// nothing ever writes or deletes a secret over it (a `Locked` read is never "no key").
#[tokio::test(start_paused = true)]
async fn a_locked_keychain_is_only_read_again_never_written() {
    let dir = tempfile::tempdir().unwrap();
    let inner = device_key::with_device_key();
    inner.set(SecureStoreKey::MasterKey, vec![9u8; 32]).unwrap();
    let store = Arc::new(LockedStore {
        inner,
        locked: AtomicBool::new(true),
        reads: AtomicUsize::new(0),
        changes: AtomicUsize::new(0),
    });
    let (_vault, backend) = unbound(dir.path(), Arc::clone(&store) as Arc<dyn SecureStore>);
    let backend = Arc::new(backend);

    let facts = backend.auth_facts().await;
    assert!(
        facts.keychain_unavailable && !facts.key_verified,
        "{facts:?}"
    );
    assert!(matches!(
        backend.open().await,
        Err(SyncError::SecureStore { .. })
    ));

    let gate = Arc::new(SyncStartGate::default());
    gate.set_binding(VaultBinding::Bound);
    gate.set_entitlement(Entitlement::Entitled);
    let (recovered, recovered_rx) = tokio::sync::broadcast::channel(4);
    let supervisor = SyncSupervisor::start(
        &tokio::runtime::Handle::current(),
        SupervisorParts {
            backend: Arc::clone(&backend) as Arc<dyn SyncBackend>,
            gate,
            reachability: Arc::new(Online),
            power: None,
            keychain_recovered: Some(recovered_rx),
            db: open_data(&dir.path().join("data.db")).unwrap(),
            telemetry: None,
            signals: memry_desktop::sync::signals::AuthSignals::new(),
            on_status: Arc::new(|_| {}),
            on_event: Arc::new(|_| {}),
        },
    );
    let before = store.reads.load(Ordering::SeqCst);
    // The start read and retries at 15, 45, 105, 225 and 525 s.
    tokio::time::sleep(Duration::from_secs(600)).await;
    let reads = store.reads.load(Ordering::SeqCst) - before;
    assert_eq!(reads, 6, "the start and five ladder retries");
    assert_eq!(
        supervisor.status().error_category,
        Some(SyncErrorCategory::KeychainUnavailable)
    );

    store.locked.store(false, Ordering::SeqCst);
    recovered.send(()).unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(
        store.reads.load(Ordering::SeqCst) >= before + reads + 2,
        "the recovery read the gate and opened at once"
    );
    supervisor.stop().await;
    assert_eq!(
        store.changes.load(Ordering::SeqCst),
        0,
        "no secret written or deleted"
    );
}
