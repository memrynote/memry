//! The editor host over a real session and `data.db` (Step 14b): each window's edit reaches the
//! other windows and never its sender, a window that is gone lets go of its documents, and the
//! vault's close and open reach the windows as reset and ready.

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use memry_core::api::editor::Editor;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::editor::{EditorHost, EditorHostError, HostEvent, Subscriber};
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, Session};
use yrs::updates::decoder::Decode as _;
use yrs::updates::encoder::Encode as _;
use yrs::{Doc, GetString as _, ReadTxn as _, StateVector, Text as _, Transact as _, Update};

use crate::device_key;

type Frames = Arc<Mutex<Vec<Vec<u8>>>>;

struct Env {
    _dir: tempfile::TempDir,
    vault: PathBuf,
    store: Arc<dyn SecureStore>,
    session: Session,
    host: Arc<EditorHost>,
    events: Arc<Mutex<Vec<HostEvent>>>,
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("vault");
    fs::create_dir_all(&vault).unwrap();
    fs::create_dir_all(dir.path().join("app")).unwrap();
    let registry = VaultRegistry::new(Arc::new(AppConfig::load(
        dir.path().join("app/memry-config.json"),
    )));
    let session = Session::new(registry);
    let store = device_key::with_device_key();
    let events: Arc<Mutex<Vec<HostEvent>>> = Arc::default();
    let heard = Arc::clone(&events);
    let host = EditorHost::new(store.clone(), move |event| {
        heard.lock().unwrap().push(event)
    });
    host.register(&session);
    session.open(&vault, OpenSource::Select).unwrap();
    Env {
        _dir: dir,
        vault,
        store,
        session,
        host,
        events,
    }
}

impl Env {
    fn note(&self) -> String {
        let core = self.session.current().unwrap().vault;
        core.notes_writer(self.store.clone())
            .unwrap()
            .create("A note".into(), None)
            .unwrap()
    }

    fn editor(&self) -> Arc<Editor> {
        let core = self.session.current().unwrap().vault;
        core.editor(self.store.clone()).unwrap()
    }

    /// `window` opens `note` with a channel that records each frame.
    fn open(&self, note: &str, window: &str) -> (Window, Frames) {
        let frames: Frames = Arc::default();
        let sink = Arc::clone(&frames);
        let opened = self
            .host
            .open(
                note,
                Some(&self.vault),
                Subscriber {
                    window_label: window.to_owned(),
                    channel: Arc::new(move |frame| {
                        sink.lock().unwrap().push(frame);
                        true
                    }),
                },
            )
            .unwrap();
        (Window::from_state(&opened.state), frames)
    }
}

/// A window's copy of a document.
struct Window(Doc);

impl Window {
    fn from_state(state: &[u8]) -> Self {
        let window = Self(Doc::new());
        window.apply(state);
        window
    }

    fn apply(&self, update: &[u8]) {
        self.0
            .transact_mut()
            .apply_update(Update::decode_v1(update).unwrap())
            .unwrap();
    }

    /// Types `text` at the end and returns the update the editor sends.
    fn type_text(&self, text: &str) -> Vec<u8> {
        let root = self.0.get_or_insert_text("t");
        let before = self.0.transact().state_vector();
        let mut txn = self.0.transact_mut();
        let end = root.len(&txn);
        root.insert(&mut txn, end, text);
        drop(txn);
        self.0.transact().encode_diff_v1(&before)
    }

    fn text(&self) -> String {
        let root = self.0.get_or_insert_text("t");
        root.get_string(&self.0.transact())
    }

    fn state_vector(&self) -> Vec<u8> {
        self.0.transact().state_vector().encode_v1()
    }
}

#[test]
fn an_edit_reaches_the_other_window_tagged_as_another_windows_and_never_its_sender() {
    let env = env();
    let note = env.note();
    let (main, main_frames) = env.open(&note, "main");
    let (side, side_frames) = env.open(&note, "side");

    let update = main.type_text("typed in main");
    env.host.apply_update(&note, &update, "main").unwrap();

    assert!(
        main_frames.lock().unwrap().is_empty(),
        "the sender hears nothing"
    );
    let frames = side_frames.lock().unwrap().clone();
    let mut expected = vec![0u8];
    expected.extend_from_slice(&update);
    assert_eq!(frames, vec![expected], "origin 0, then the bytes as sent");
    side.apply(&frames[0][1..]);
    assert_eq!(side.text(), "typed in main");

    let reply = side.type_text(", answered");
    env.host.apply_update(&note, &reply, "side").unwrap();
    assert_eq!(side_frames.lock().unwrap().len(), 1);
    main.apply(&main_frames.lock().unwrap()[0][1..]);
    assert_eq!(main.text(), side.text());
}

#[test]
fn a_window_that_is_gone_lets_go_of_its_documents_and_hears_nothing_more() {
    let env = env();
    let note = env.note();
    let (main, _) = env.open(&note, "main");
    let (_, side_frames) = env.open(&note, "side");

    env.host.forget_window("side");
    env.host
        .apply_update(&note, &main.type_text("after side left"), "main")
        .unwrap();

    assert!(side_frames.lock().unwrap().is_empty());
    assert!(env.editor().is_open(&note), "main still holds it");
    env.host.forget_window("main");
    assert!(!env.editor().is_open(&note), "nobody holds it any more");
}

#[test]
fn a_closed_editor_releases_only_its_window_and_a_dead_channel_is_dropped() {
    let env = env();
    let note = env.note();
    let (main, _) = env.open(&note, "main");
    let (_, side_frames) = env.open(&note, "side");
    let dead_calls = Arc::new(Mutex::new(0));
    let calls = Arc::clone(&dead_calls);
    env.host
        .open(
            &note,
            None,
            Subscriber {
                window_label: "crashed".to_owned(),
                channel: Arc::new(move |_| {
                    *calls.lock().unwrap() += 1;
                    false
                }),
            },
        )
        .unwrap();

    env.host.close(&note, "side");
    env.host
        .apply_update(&note, &main.type_text("one"), "main")
        .unwrap();
    env.host
        .apply_update(&note, &main.type_text("two"), "main")
        .unwrap();

    assert!(side_frames.lock().unwrap().is_empty());
    assert_eq!(
        *dead_calls.lock().unwrap(),
        1,
        "a dead channel is tried once"
    );
    assert!(env.editor().is_open(&note));
    env.host.close(&note, "main");
    env.host.forget_window("crashed");
    assert!(!env.editor().is_open(&note));
}

#[test]
fn sync_step_1_answers_what_the_window_lacks_and_the_documents_state_vector() {
    let env = env();
    let note = env.note();
    let (main, _) = env.open(&note, "main");
    let (side, side_frames) = env.open(&note, "side");
    let before = side.state_vector();
    env.host
        .apply_update(&note, &main.type_text("missed"), "main")
        .unwrap();

    let (diff, state_vector) = env.host.sync_step_1(&note, &before).unwrap();
    let late = Window::from_state(&diff);
    assert_eq!(late.text(), "missed");
    assert_eq!(
        StateVector::decode_v1(&state_vector).unwrap(),
        main.0.transact().state_vector()
    );
    assert_eq!(
        side_frames.lock().unwrap().len(),
        1,
        "the channel had it too"
    );
}

#[test]
fn a_window_that_opens_while_another_types_misses_no_edit() {
    let env = env();
    let note = env.note();
    let (main, _) = env.open(&note, "main");
    let updates: Vec<Vec<u8>> = (0..400).map(|n| main.type_text(&format!("{n},"))).collect();
    let windows = std::thread::scope(|scope| {
        scope.spawn(|| {
            for update in &updates {
                env.host.apply_update(&note, update, "main").unwrap();
            }
        });
        (0..60)
            .map(|n| env.open(&note, &format!("w{n}")))
            .collect::<Vec<_>>()
    });

    for (window, frames) in windows {
        for frame in frames.lock().unwrap().iter() {
            window.apply(&frame[1..]);
        }
        assert_eq!(
            window.text(),
            main.text(),
            "its state and its channel hold every edit"
        );
    }
}

#[test]
fn a_vault_close_resets_the_windows_and_the_next_open_says_ready() {
    let env = env();
    let note = env.note();
    let path = env.vault.to_string_lossy().into_owned();
    assert_eq!(
        *env.events.lock().unwrap(),
        vec![HostEvent::Ready {
            vault_path: path.clone()
        }]
    );
    let (main, main_frames) = env.open(&note, "main");
    let other = tempfile::tempdir().unwrap();
    let refused = env.host.open(
        &note,
        Some(other.path()),
        Subscriber {
            window_label: "elsewhere".to_owned(),
            channel: Arc::new(|_| true),
        },
    );
    assert!(matches!(refused, Err(EditorHostError::OtherVault)));

    let editor = env.editor();
    let closed = env.session.current().unwrap();
    env.session.close();
    assert_eq!(env.events.lock().unwrap().last(), Some(&HostEvent::Reset));
    assert!(matches!(
        env.host
            .apply_update(&note, &main.type_text("late"), "main"),
        Err(EditorHostError::NotServing)
    ));
    editor
        .absorb(
            &note,
            &main.type_text("still"),
            memry_core::api::editor::Origin::External,
        )
        .unwrap();
    assert!(
        main_frames.lock().unwrap().is_empty(),
        "the closed vault's listeners are gone"
    );

    env.session.open(other.path(), OpenSource::Select).unwrap();
    assert_eq!(
        env.events.lock().unwrap().last(),
        Some(&HostEvent::Ready {
            vault_path: other.path().to_string_lossy().into_owned()
        })
    );
    env.host.stop(&closed);
    assert_eq!(
        env.events.lock().unwrap().len(),
        3,
        "a late close of the earlier vault resets nobody"
    );
    assert!(env.host.health().unwrap().persistent);
}
