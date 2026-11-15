//! The note embedding lane as the app wires it (`ml_worker::register_embedding_lane` and
//! `register_on_close`): a real vault, vault tier and note index, the managed settings, and a
//! managed `EmbeddingService` over a fake model. A mock app test lives here, not in the lib's
//! unit tests: the lib test exe has no Common Controls v6 manifest on Windows (#3842).

// Only its store and wait: the mock vault of the command tests does not register the lane.
#[allow(dead_code)]
mod support;

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use memry_core::crypto::sodium;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_desktop::ai::features::{self, AiSettingsPatch};
use memry_desktop::embedding::download::Abort;
use memry_desktop::embedding::projector::drain_deferred;
use memry_desktop::embedding::service::{
    EmbedError, EmbeddingService, Engine, ModelLoader, ModelProgress, Timing,
};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::{IndexReport, NoteIndex};
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, Session};
use memry_desktop::settings::SettingsService;
use memry_desktop::vault::consumer::{Applied, VaultTier};
use memry_tauri::ml_worker;
use tauri::Manager;
use tauri::test::{MockRuntime, mock_app};
use tokio::sync::broadcast::error::TryRecvError;

use support::{MemoryStore, WAIT};

const ALPHA: &str = "Alpha keeps the first body of this note.\n";
const BETA: &str = "Beta is a second note with enough text.\n";

/// The texts the fake model embedded.
#[derive(Default)]
struct Embedded(Mutex<Vec<String>>);

impl Embedded {
    fn any(&self, needle: &str) -> bool {
        self.0
            .lock()
            .unwrap()
            .iter()
            .any(|text| text.contains(needle))
    }
}

struct FakeEngine(Arc<Embedded>);

impl Engine for FakeEngine {
    fn embed_text(&mut self, text: &str) -> Result<Vec<f32>, EmbedError> {
        self.0.0.lock().unwrap().push(text.to_owned());
        Ok(vec![0.0625; 256])
    }
}

struct Loader(Arc<Embedded>);

impl ModelLoader for Loader {
    fn load(
        &self,
        _: &Abort,
        _: &(dyn Fn(ModelProgress) + Sync),
    ) -> Result<Box<dyn Engine>, String> {
        Ok(Box::new(FakeEngine(self.0.clone())))
    }
}

struct Lane {
    _dir: tempfile::TempDir,
    vault: PathBuf,
    session: Session,
    tier: Arc<VaultTier>,
    settings: SettingsService,
    service: Arc<EmbeddingService>,
    embedded: Arc<Embedded>,
    _app: tauri::App<MockRuntime>,
}

/// A vault holding `a.md`, opened through a session wired as `vault_boot` wires it, with its
/// first walk done.
fn lane() -> Lane {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("vault");
    fs::create_dir_all(&vault).unwrap();
    fs::write(vault.join("a.md"), ALPHA).unwrap();
    let store: Arc<dyn SecureStore> = Arc::new(MemoryStore::default());
    let (_, secret) = sodium::sign_seed_keypair(&[7u8; 32]).unwrap();
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .unwrap();
    let config = Arc::new(AppConfig::load(dir.path().join("memry-config.json")));
    let session = Session::new(VaultRegistry::new(config.clone()));
    let tier = VaultTier::new(store.clone());
    tier.set_identity(NotesIdentity::new(store.clone()));
    tier.register(&session);
    // `vault_boot`'s drain: the notes the open's build deferred are embedded once it ends.
    let built: Arc<OnceLock<Weak<NoteIndex>>> = Arc::default();
    let index = {
        let (built, session) = (built.clone(), session.clone());
        NoteIndex::new(
            tier.clone(),
            move |report| {
                if let (IndexReport::Indexing, Some(index)) =
                    (report, built.get().and_then(Weak::upgrade))
                {
                    drain_deferred(&session, &index);
                }
            },
            |_| {},
            |_| {},
        )
    };
    built.set(Arc::downgrade(&index)).unwrap();
    index.register(&session);

    let app = mock_app();
    let settings = SettingsService::new(store, config);
    let embedded = Arc::new(Embedded::default());
    let service = EmbeddingService::new(
        Arc::new(Loader(embedded.clone())),
        Arc::new(|_| {}),
        Timing::default(),
    );
    app.manage(settings.clone());
    app.manage(service.clone());
    ml_worker::register_embedding_lane(app.handle(), &session, &index, &tier);
    ml_worker::register_on_close(app.handle(), &session);

    let mut facts = tier.subscribe();
    session.open(&vault, OpenSource::Select).unwrap();
    let deadline = Instant::now() + WAIT;
    loop {
        assert!(Instant::now() < deadline, "the open walk did not end");
        match facts.try_recv() {
            Ok(Applied::Indexed { .. }) => break,
            Ok(_) | Err(TryRecvError::Lagged(_)) => continue,
            Err(TryRecvError::Empty) => std::thread::sleep(Duration::from_millis(20)),
            Err(TryRecvError::Closed) => panic!("the tier closed before the open walk ended"),
        }
    }
    Lane {
        _dir: dir,
        vault,
        session,
        tier,
        settings,
        service,
        embedded,
        _app: app,
    }
}

impl Lane {
    fn until(&self, what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + WAIT;
        while !done() {
            assert!(Instant::now() < deadline, "timed out: {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Every queued event projected and the open's reconcile ended.
    fn settled(&self) {
        let runtime = self.session.projections().expect("open");
        assert!(runtime.flush(WAIT));
        self.until("the reconcile ends", || runtime.live_threads() <= 1);
    }

    /// Writes the file and waits for the tier to apply it.
    fn write(&self, rel: &str, text: &str) {
        let mut facts = self.tier.subscribe();
        fs::write(self.vault.join(rel), text).unwrap();
        let deadline = Instant::now() + WAIT;
        loop {
            assert!(Instant::now() < deadline, "{rel} was not applied");
            match facts.try_recv() {
                Ok(Applied::Added { path, .. } | Applied::Changed { path, .. }) if path == rel => {
                    return;
                }
                Ok(_) | Err(TryRecvError::Lagged(_)) => continue,
                Err(TryRecvError::Empty) => std::thread::sleep(Duration::from_millis(20)),
                Err(TryRecvError::Closed) => panic!("the tier closed"),
            }
        }
    }
}

#[test]
fn an_open_vault_and_a_note_written_later_are_embedded() {
    let l = lane();
    l.until("the open embeds a.md", || l.embedded.any("Alpha keeps"));

    l.write("b.md", BETA);
    l.until("the feed embeds b.md", || l.embedded.any("Beta is"));
}

/// The lane reads `ai.enabled` from the vault's settings before each inference: a note written
/// while it is off stays owed, and is embedded once it is on.
#[test]
fn with_ai_off_in_the_vault_settings_a_note_is_only_owed() {
    let l = lane();
    l.until("the open embeds a.md", || l.embedded.any("Alpha keeps"));
    l.settled();
    let open = l.session.current().expect("open");
    let ai = |enabled| {
        let patch = AiSettingsPatch {
            enabled: Some(enabled),
            ..AiSettingsPatch::default()
        };
        features::write(&l.settings, Some(&open), &patch).unwrap();
    };
    ai(false);

    l.write("b.md", BETA);
    let runtime = l.session.projections().expect("open");
    runtime.reconcile_named(&["embedding"]).unwrap();
    l.settled();
    assert!(!l.embedded.any("Beta is"));

    ai(true);
    runtime.reconcile_named(&["embedding"]).unwrap();
    l.until("the reconcile embeds b.md", || l.embedded.any("Beta is"));
}

/// The vault close stops the model (REVIEW-4548): nothing of the closed vault is served.
#[test]
fn a_vault_close_stops_the_model() {
    let l = lane();
    l.until("the open embeds a.md", || l.embedded.any("Alpha keeps"));
    l.until("the model is loaded", || l.service.status().loaded);

    l.session.close();
    assert!(!l.service.status().loaded);
}
