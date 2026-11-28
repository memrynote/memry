use std::collections::HashMap;
use std::fs;

use super::*;
use crate::api::errors::{SecureStoreError, TransportError};
use crate::seams::secure_store::{SecureStore, SecureStoreKey};
use crate::semantic::fakes::{Cdn, Scratch, Wifi, files, manifest};

struct Setup {
    scratch: Scratch,
    semantic: SemanticSearch,
    cdn: Arc<Cdn>,
    wifi: Arc<Wifi>,
    vault: Arc<Vault>,
}

const ROOMY: u64 = 1 << 40;

fn setup() -> Setup {
    let scratch = Scratch::new();
    let files = files();
    let (cdn, wifi) = (Cdn::new(&files), Wifi::on());
    let semantic =
        SemanticSearch::over(scratch.models(manifest(&files)), cdn.clone(), wifi.clone());
    let vault_dir = scratch.0.join("vault");
    fs::create_dir_all(&vault_dir).unwrap();
    let vault = Arc::new(Vault::open("v1".into(), vault_dir.to_string_lossy().into()).unwrap());
    Setup {
        scratch,
        semantic,
        cdn,
        wifi,
        vault,
    }
}

impl Setup {
    fn state(&self) -> ModelState {
        self.semantic.status(self.vault.clone()).model
    }

    fn total(&self) -> u64 {
        files().iter().map(|(_, bytes)| bytes.len() as u64).sum()
    }
}

#[tokio::test]
async fn enable_downloads_to_ready_and_a_second_enable_fetches_nothing() {
    let s = setup();
    assert_eq!(s.state(), ModelState::Off);
    assert_eq!(s.semantic.enable(ROOMY).await.unwrap(), ModelState::Ready);
    assert_eq!(s.state(), ModelState::Ready);
    assert_eq!(s.semantic.status(s.vault.clone()).download_bytes, s.total());

    let calls = s.cdn.requests.lock().unwrap().len();
    assert_eq!(
        s.semantic.enable(0).await.unwrap(),
        ModelState::Ready,
        "nothing left to store"
    );
    assert_eq!(s.cdn.requests.lock().unwrap().len(), calls);
}

#[tokio::test]
async fn enable_refuses_without_room_for_the_rest_plus_headroom_and_stays_off() {
    let s = setup();
    let needed = s.total() + SPACE_HEADROOM_BYTES;
    let refused = s.semantic.enable(needed - 1).await.unwrap_err();
    assert!(matches!(
        refused,
        SemanticError::Storage { source: StorageError::OutOfSpace { needed_bytes, .. } } if needed_bytes == needed
    ));
    assert_eq!(s.state(), ModelState::Off);
    assert!(s.cdn.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn status_reports_waiting_for_wifi_with_progress_and_resume_finishes() {
    let s = setup();
    let wifi = s.wifi.clone();
    s.cdn.hook(move |call, _| {
        if call == 1 {
            wifi.set(Reachable::Cellular);
        }
        None
    });
    let waiting = s.semantic.enable(ROOMY).await.unwrap();
    assert_eq!(
        waiting,
        ModelState::WaitingForWifi {
            received: download::RANGE_BYTES,
            total: s.total()
        }
    );
    assert_eq!(s.state(), waiting);

    s.wifi.set(Reachable::Wifi);
    assert_eq!(
        s.state(),
        ModelState::WaitingForWifi {
            received: download::RANGE_BYTES,
            total: s.total()
        },
        "status reports the last attempt until resume runs"
    );
    assert_eq!(s.semantic.resume().await.unwrap(), ModelState::Ready);
}

#[tokio::test]
async fn a_failed_download_reports_its_failure_and_resume_retries() {
    let s = setup();
    s.cdn.hook(|call, _| {
        (call == 3).then(|| {
            Err(TransportError::Failed {
                what: "reset".into(),
            })
        })
    });
    let failed = ModelState::Failed {
        received: download::RANGE_BYTES,
        total: s.total(),
        failure: DownloadFailure::Network,
    };
    assert_eq!(s.semantic.enable(ROOMY).await.unwrap(), failed);
    assert_eq!(s.state(), failed);

    s.cdn.hook(|_, _| None);
    assert_eq!(s.semantic.resume().await.unwrap(), ModelState::Ready);
}

#[tokio::test]
async fn resume_without_the_opt_in_does_nothing() {
    let s = setup();
    assert_eq!(s.semantic.resume().await.unwrap(), ModelState::Off);
    assert!(s.cdn.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_relaunch_off_wifi_reports_waiting_until_resume_runs() {
    let s = setup();
    s.wifi.set(Reachable::Cellular);
    let state = s.semantic.enable(ROOMY).await.unwrap();
    assert_eq!(
        state,
        ModelState::WaitingForWifi {
            received: 0,
            total: s.total()
        }
    );

    let relaunched = SemanticSearch::over(s.semantic.model.clone(), s.cdn.clone(), s.wifi.clone());
    assert_eq!(relaunched.status(s.vault.clone()).model, state);
    s.wifi.set(Reachable::Wifi);
    assert_eq!(
        relaunched.status(s.vault.clone()).model,
        ModelState::Downloading {
            received: 0,
            total: s.total()
        }
    );
}

#[tokio::test]
async fn disable_removes_the_model_the_opt_in_and_this_vaults_vectors() {
    let s = setup();
    s.semantic.enable(ROOMY).await.unwrap();
    s.semantic.status(s.vault.clone());
    let vectors = s.vault.directory().join("vectors.db");
    assert!(vectors.exists(), "status opened vectors.db while opted in");

    s.semantic.disable(s.vault.clone()).await.unwrap();
    assert_eq!(s.state(), ModelState::Off);
    assert!(!vectors.exists());
    let models = s.scratch.0.join("models");
    assert_eq!(fs::read_dir(&models).unwrap().count(), 0);

    assert_eq!(
        s.semantic.enable(ROOMY).await.unwrap(),
        ModelState::Ready,
        "turning it back on downloads again"
    );
}

#[tokio::test]
async fn a_finished_download_sweeps_other_revisions_and_parts() {
    let s = setup();
    let models = s.scratch.0.join("models");
    fs::create_dir_all(models.join("old-model/onnx")).unwrap();
    fs::write(models.join("old-model/onnx/model.onnx"), b"old").unwrap();
    s.semantic.enable(ROOMY).await.unwrap();

    let mut left: Vec<_> = fs::read_dir(&models)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    left.sort();
    assert_eq!(left, ["opt-in", "test-model-1"]);
    assert!(!models.join("test-model-1/.partial").exists());
}

#[test]
fn status_counts_live_notes_and_this_models_vectors() {
    let s = setup();
    let writer = s.vault.notes_writer(Arc::new(Store::default())).unwrap();
    let kept = writer.create("Kept".into(), None).unwrap();
    let gone = writer.create("Gone".into(), None).unwrap();
    writer.delete(gone).unwrap();
    let status = s.semantic.status(s.vault.clone());
    assert_eq!((status.embedded_notes, status.total_notes), (0, 1));

    s.semantic.model.set_opted_in().unwrap();
    let db = vector_db::open(&s.vault.directory().join("vectors.db"), true)
        .unwrap()
        .unwrap();
    let state = |note_id: &str, vector_key: &str| vector_db::NoteState {
        note_id: note_id.into(),
        vector_key: vector_key.into(),
        input_version: 6,
        source_key: [0; 32],
        window_count: 0,
    };
    db.call_blocking(|conn| {
        let store = VectorStore::new(conn);
        store.replace_note(&state(&kept, "test-key"), &[], 0)?;
        store.replace_note(&state("other", "another-model"), &[], 0)
    })
    .unwrap();
    drop(db);
    let status = s.semantic.status(s.vault.clone());
    assert_eq!((status.embedded_notes, status.total_notes), (1, 1));
}

#[derive(Default)]
struct Store(Mutex<HashMap<String, Vec<u8>>>);

impl SecureStore for Store {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        if matches!(key, SecureStoreKey::DeviceSigningKey) {
            return Ok(Some([[7; 32], [9; 32]].concat()));
        }
        Ok(lock(&self.0).get(&format!("{key:?}")).cloned())
    }
    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        lock(&self.0).insert(format!("{key:?}"), value);
        Ok(())
    }
    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        lock(&self.0).remove(&format!("{key:?}"));
        Ok(())
    }
    fn clear(&self) -> Result<(), SecureStoreError> {
        lock(&self.0).clear();
        Ok(())
    }
}

#[tokio::test]
async fn a_storage_failure_mid_download_reports_failed_storage_and_still_errs() {
    let s = setup();
    let model_dir = s.scratch.0.join("models/test-model-1");
    fs::create_dir_all(&model_dir).unwrap();
    fs::write(model_dir.join(".partial"), b"not a directory").unwrap();

    assert!(s.semantic.enable(ROOMY).await.is_err());
    assert_eq!(
        s.state(),
        ModelState::Failed {
            received: 0,
            total: s.total(),
            failure: DownloadFailure::Storage,
        }
    );

    fs::remove_file(model_dir.join(".partial")).unwrap();
    assert_eq!(s.semantic.resume().await.unwrap(), ModelState::Ready);
}

#[tokio::test]
async fn a_storage_failure_after_turning_off_reports_off() {
    let s = setup();
    let model_dir = s.scratch.0.join("models/test-model-1");
    fs::create_dir_all(&model_dir).unwrap();
    fs::write(model_dir.join(".partial"), b"not a directory").unwrap();

    assert_eq!(s.semantic.run_download().await.unwrap(), ModelState::Off);
    assert_eq!(s.state(), ModelState::Off);
}

#[tokio::test]
async fn a_status_poll_that_saw_the_opt_in_before_disable_leaves_no_vectors_db() {
    let s = setup();
    s.semantic.model.set_opted_in().unwrap();
    s.semantic.status(s.vault.clone());
    let vectors = s.vault.directory().join("vectors.db");
    assert!(vectors.exists());

    s.semantic.disable(s.vault.clone()).await.unwrap();
    // The poll checked the opt-in, then parked on the vectors lock that
    // disable held.
    let embedded = s.semantic.embedded_notes(s.vault.directory()).unwrap();
    assert_eq!(embedded, 0);
    assert!(!vectors.exists(), "vectors.db survived off");
    assert!(lock(&s.semantic.vectors).is_empty());
}
