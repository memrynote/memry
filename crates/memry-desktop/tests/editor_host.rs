//! The editor host over a real session and `data.db` (Step 14b): each window's edit reaches the
//! other windows and never its sender, a window that is gone lets go of its documents, and the
//! vault's close and open reach the windows as reset and ready.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use memry_core::api::editor::Editor;
use memry_core::api::errors::SecureStoreError;
use memry_core::api::errors::StorageError;
use memry_core::crdt::{body_writes, update_log};
use memry_core::domain::external_feed::{FeedInput, FeedOutcome};
use memry_core::domain::vault_locks::TargetKind;
use memry_core::markdown::convert::api::Converter;
use memry_core::seams::secure_store::SecureStore;
use memry_core::seams::secure_store::SecureStoreKey;
use memry_desktop::editor::{
    BARRIER, EditorHost, EditorHostError, HostEvent, RELEASE, Subscriber, TypingHold,
};
use memry_desktop::error::{FailureKind, map_core};
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
    env_with(device_key::with_device_key())
}

fn env_with(store: Arc<dyn SecureStore>) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("vault");
    fs::create_dir_all(&vault).unwrap();
    fs::create_dir_all(dir.path().join("app")).unwrap();
    let registry = VaultRegistry::new(Arc::new(AppConfig::load(
        dir.path().join("app/memry-config.json"),
    )));
    let session = Session::new(registry);
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

    /// The note's file was edited outside the app, and the feed took it.
    fn outside_edit(&self, note: &str, markdown: &str) {
        let core = self.session.current().unwrap().vault;
        let feed = core.external_feed(self.store.clone()).unwrap();
        let input = FeedInput {
            note_id: note,
            markdown,
            note_path: None,
            writing: None,
            frontmatter: None,
            embeds: None,
        };
        let fed = feed.feed(&Converter::new(Default::default()), input);
        assert_eq!(fed.unwrap(), FeedOutcome::Fed);
    }

    /// `window` opens `note` with a channel that records each frame.
    fn open(&self, note: &str, window: &str) -> (Window, Frames) {
        let (subscriber, frames) = recording(window);
        let opened = self.host.open(note, Some(&self.vault), subscriber).unwrap();
        (Window::from_state(&opened.state), frames)
    }
}

/// A subscriber of `window` that records each frame.
fn recording(window: &str) -> (Subscriber, Frames) {
    let frames: Frames = Arc::default();
    let sink = Arc::clone(&frames);
    let subscriber = Subscriber {
        window_label: window.to_owned(),
        channel: Arc::new(move |frame| {
            sink.lock().unwrap().push(frame);
            true
        }),
    };
    (subscriber, frames)
}

/// A secure store that answers `Locked` while `locked` is set, as a keychain behind an
/// unanswered prompt does.
struct Lockable {
    inner: Arc<dyn SecureStore>,
    locked: AtomicBool,
}

impl SecureStore for Lockable {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        if self.locked.load(Ordering::SeqCst) {
            return Err(SecureStoreError::Locked);
        }
        self.inner.get(key)
    }

    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        self.inner.set(key, value)
    }

    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        self.inner.delete(key)
    }

    fn clear(&self) -> Result<(), SecureStoreError> {
        self.inner.clear()
    }
}

fn copy_dir(from: &std::path::Path, to: &std::path::Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
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

    let (diff, state_vector) = env.host.sync_step_1(&note, &before, "side").unwrap();
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
fn a_purged_document_tells_every_window_to_open_it_again() {
    let env = env();
    let note = env.note();
    let (_, main_frames) = env.open(&note, "main");
    let (_, side_frames) = env.open(&note, "side");

    env.editor().purge(&note);

    assert_eq!(*main_frames.lock().unwrap(), vec![vec![4]]);
    assert_eq!(*side_frames.lock().unwrap(), vec![vec![4]]);
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
        .apply_update(&note, &Window(Doc::new()).type_text("still"), "other")
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

#[test]
fn a_window_left_bound_to_the_previous_vault_cannot_write_into_the_next() {
    let env = env();
    let note = env.note();
    let (popout, _) = env.open(&note, "popout");
    env.session.close();
    let copy = env.vault.with_file_name("copy");
    copy_dir(&env.vault, &copy);
    env.session.open(&copy, OpenSource::Select).unwrap();

    let typed = popout.type_text("written in the vault that was left");
    let refused = env.host.apply_update(&note, &typed, "popout");
    let step = env
        .host
        .sync_step_1(&note, &popout.state_vector(), "popout");

    assert!(
        matches!(refused, Err(EditorHostError::NotOpen { .. })),
        "{refused:?}"
    );
    assert!(
        matches!(step, Err(EditorHostError::NotOpen { .. })),
        "{step:?}"
    );
    let (main, _) = recording("main");
    let opened = env.host.open(&note, Some(&copy), main).unwrap();
    assert_eq!(Window::from_state(&opened.state).text(), "");
}

#[test]
fn a_keychain_locked_while_the_vault_opens_fails_only_until_it_unlocks() {
    let store = Arc::new(Lockable {
        inner: device_key::with_device_key(),
        locked: AtomicBool::new(true),
    });
    let env = env_with(store.clone());
    let (window, _) = recording("main");

    let locked = env.host.open("any", None, window.clone()).unwrap_err();

    assert_eq!(map_core(&locked).code, "secure_store_locked");
    store.locked.store(false, Ordering::SeqCst);
    let note = env.note();
    env.host.open(&note, None, window).unwrap();
}

#[test]
fn a_failed_open_leaves_no_subscriber_behind() {
    let env = env();
    let (window, frames) = recording("main");

    let missing = env.host.open("no-such-note", None, window);

    assert!(missing.is_err());
    env.editor().purge("no-such-note");
    assert!(frames.lock().unwrap().is_empty());
}

#[test]
fn the_last_dead_channel_takes_the_documents_listener_with_it() {
    let env = env();
    let note = env.note();
    let dead = Subscriber {
        window_label: "crashed".to_owned(),
        channel: Arc::new(|_| false),
    };
    env.host.open(&note, None, dead).unwrap();
    let writer = Window(Doc::new());
    env.editor()
        .apply_update(&note, &writer.type_text("one"), "elsewhere")
        .unwrap();

    let (reloaded, frames) = recording("crashed");
    env.host.open(&note, None, reloaded).unwrap();
    env.editor()
        .apply_update(&note, &writer.type_text("two"), "elsewhere")
        .unwrap();

    assert_eq!(frames.lock().unwrap().len(), 1, "one listener, one frame");
}

#[test]
fn an_edit_of_a_locked_note_is_refused_as_note_locked_and_reaches_no_window() {
    let env = env();
    let note = env.note();
    let (main, _) = env.open(&note, "main");
    let (_side, side_frames) = env.open(&note, "side");
    let core = env.session.current().unwrap().vault;
    core.locks().set(TargetKind::Note, &note, true).unwrap();

    let refused = env
        .host
        .apply_update(&note, &main.type_text("typed"), "main")
        .unwrap_err();

    let failure = map_core(&refused);
    assert_eq!(
        (failure.kind, failure.code),
        (FailureKind::Locked, "note_locked")
    );
    assert_eq!(
        failure.message, "The owner made this note read-only.",
        "Electron's fixed text, which the renderer localizes"
    );
    assert!(side_frames.lock().unwrap().is_empty());
}

/// Electron has no refusal text for a large file: its renderer never mounts an editor for one.
/// The code is what the renderer swaps to the viewer on (#3531 14c-2).
#[test]
fn an_edit_of_a_large_file_note_is_refused_as_note_large_file_and_reaches_no_window() {
    let env = env();
    let note = env.note();
    let (main, _) = env.open(&note, "main");
    let (_side, side_frames) = env.open(&note, "side");
    let core = env.session.current().unwrap().vault;
    core.note_files().record_large_file(&note, true).unwrap();

    let refused = env
        .host
        .apply_update(&note, &main.type_text("typed"), "main")
        .unwrap_err();

    let failure = map_core(&refused);
    assert_eq!(
        (failure.kind, failure.code),
        (FailureKind::Invalid, "note_large_file")
    );
    assert_eq!(
        failure.message, "This note is too large to edit. It opens read-only.",
        "user-facing text, no note id"
    );
    assert!(side_frames.lock().unwrap().is_empty());
}

#[test]
fn only_a_stored_window_edit_asks_for_its_file_to_be_written() {
    let env = env();
    let note = env.note();
    let (main, _) = env.open(&note, "main");
    let edited = || {
        env.events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| matches!(event, HostEvent::Edited { .. }))
            .cloned()
            .collect::<Vec<_>>()
    };

    let update = main.type_text("typed");
    env.host.apply_update(&note, &update, "main").unwrap();
    assert_eq!(
        edited(),
        vec![HostEvent::Edited {
            note_id: note.clone()
        }]
    );

    env.host.apply_update(&note, &update, "main").unwrap();
    assert_eq!(edited().len(), 1, "an update the body has changes nothing");

    let core = env.session.current().unwrap().vault;
    core.locks().set(TargetKind::Note, &note, true).unwrap();
    let refused = env.host.apply_update(&note, &main.type_text("x"), "main");
    assert!(refused.is_err());
    assert_eq!(edited().len(), 1, "a refused edit writes no file");
}

/// The kind byte and the barrier id of each barrier frame `frames` recorded, and the origin
/// byte alone of each update.
fn kinds(frames: &Frames) -> Vec<(u8, Option<u32>)> {
    frames
        .lock()
        .unwrap()
        .iter()
        .map(|frame| match frame[0] {
            BARRIER | RELEASE => (
                frame[0],
                Some(u32::from_le_bytes(frame[1..5].try_into().unwrap())),
            ),
            origin => (origin, None),
        })
        .collect()
}

/// Waits for the barrier frame `frames` recorded first, and returns its id.
fn barrier_of(frames: &Frames) -> u32 {
    let deadline = std::time::Instant::now() + Duration::from_secs(25);
    loop {
        if let Some((_, Some(id))) = kinds(frames).into_iter().find(|(k, _)| *k == BARRIER) {
            return id;
        }
        assert!(std::time::Instant::now() < deadline, "no barrier frame");
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// An outside edit waits for each window's answer to its barrier, and the window hears the
/// release after the edit's frame, on the same channel: its hold of new typing covers the
/// whole time the edit's frame is on its way.
#[test]
fn a_window_hears_the_outside_edit_between_its_barrier_and_its_release() {
    let env = env();
    let note = env.note();
    let (main, main_frames) = env.open(&note, "main");
    let (_side, side_frames) = env.open(&note, "side");
    let holding = {
        let (host, note) = (Arc::clone(&env.host), note.clone());
        std::thread::spawn(move || host.hold_typing(&note, Duration::from_secs(25)))
    };

    let id = barrier_of(&main_frames);
    assert_eq!(barrier_of(&side_frames), id);
    // Typing sent at the barrier is stored before the hold is given.
    let typed = main.type_text("typed before the answer");
    env.host.apply_update(&note, &typed, "main").unwrap();
    env.host.typing_sent("main", id);
    assert!(!holding.is_finished(), "given before every window answered");
    env.host.typing_sent("side", id);
    let hold: TypingHold = holding.join().unwrap().expect("windows have the note open");
    env.outside_edit(&note, "edited outside");
    drop(hold);

    let side = [
        (BARRIER, Some(id)),
        (0, None),
        (2, None),
        (RELEASE, Some(id)),
    ];
    assert_eq!(kinds(&side_frames), side);
    let main = [(BARRIER, Some(id)), (2, None), (RELEASE, Some(id))];
    assert_eq!(kinds(&main_frames), main);
}

/// A window that does not answer is waited for no longer than the wait: the outside edit goes
/// on, and the window is released with the others.
#[test]
fn a_window_that_does_not_answer_holds_an_outside_edit_only_as_long_as_the_wait() {
    let env = env();
    let note = env.note();
    let (_main, main_frames) = env.open(&note, "main");
    let (_side, side_frames) = env.open(&note, "side");
    let holding = {
        let (host, note) = (Arc::clone(&env.host), note.clone());
        std::thread::spawn(move || host.hold_typing(&note, Duration::from_millis(200)))
    };
    let id = barrier_of(&main_frames);
    env.host.typing_sent("main", id);

    drop(holding.join().unwrap().expect("windows have the note open"));
    assert_eq!(
        kinds(&side_frames),
        [(BARRIER, Some(id)), (RELEASE, Some(id))]
    );
    assert_eq!(
        kinds(&main_frames),
        [(BARRIER, Some(id)), (RELEASE, Some(id))]
    );
}

/// An outside edit of a note no window has open asks no window, and waits for none.
#[test]
fn an_outside_edit_of_a_note_no_window_has_open_holds_nothing() {
    let env = env();
    let note = env.note();
    assert!(
        env.host
            .hold_typing(&note, Duration::from_secs(25))
            .is_none()
    );
    let (_main, frames) = env.open(&note, "main");
    env.host.close(&note, "main");
    assert!(
        env.host
            .hold_typing(&note, Duration::from_secs(25))
            .is_none()
    );
    assert!(frames.lock().unwrap().is_empty());
}

/// A window's edit that waits for the writer while the feed holds it lands after the feed's
/// rows: the other windows hear the outside edit first, though core tells its listeners only
/// once the writer is free.
#[test]
fn a_window_edit_waiting_for_an_outside_edit_reaches_the_other_windows_after_it() {
    let env = env();
    let note = env.note();
    let (main, _) = env.open(&note, "main");
    let (side, side_frames) = env.open(&note, "side");
    let outside = side.type_text("edited outside");
    let db = env.session.current().unwrap().vault.db_handle();
    let (committed, written) = mpsc::channel();
    let id = note.clone();
    let writer = std::thread::spawn(move || {
        db.call_blocking(|conn| {
            body_writes::as_external(|| update_log::append_local_update(conn, &id, &outside, 1))
                .map_err(|error| StorageError::Failed {
                    what: error.to_string(),
                })?;
            committed.send(()).unwrap();
            // Holds the writer, its row committed and not told yet.
            std::thread::sleep(Duration::from_millis(30));
            Ok(())
        })
    });
    written.recv().unwrap();

    let typed = main.type_text("typed");
    env.host.apply_update(&note, &typed, "main").unwrap();
    writer.join().unwrap().unwrap();

    assert_eq!(kinds(&side_frames), [(2, None), (0, None)]);
}
