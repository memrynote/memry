//! The typing barrier end to end, over a real session, the shipped tier, its watcher and the
//! editor host: typing a window had not sent when the note's file was edited outside reaches
//! the body before the consumer chooses between the two, so it wins and is never lost in blocks
//! the outside edit deleted; and a window with no typing hears the outside edit between its
//! barrier and its release. The barrier's frames are the host tests in `editor_host.rs`.

use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use memry_core::crdt::BODY_FRAGMENT;
use memry_desktop::editor::{BARRIER, EditorHost, RELEASE, Subscriber};
use memry_desktop::vault::consumer::{Applied, ChangeSource};
use yrs::types::xml::XmlOut;
use yrs::updates::decoder::Decode as _;
use yrs::{Doc, ReadTxn as _, Text as _, Transact as _, Update, WriteTxn as _, XmlFragment as _};

use crate::vault_env::{Env, WAIT, creates, env, indexed};

type Frames = Arc<Mutex<Vec<Vec<u8>>>>;

const OUTSIDE: &str = "edited outside\n";

struct Served {
    e: Env,
    host: Arc<EditorHost>,
    id: String,
}

/// A vault holding one note, `n.md` ("first words"), served to windows by an editor host the
/// tier asks for their typing.
fn served() -> Served {
    let store = Mutex::new(None);
    let mut e = env(|made| {
        *store.lock().unwrap() = Some(made.clone());
        Some(creates(made))
    });
    let host = EditorHost::new(store.into_inner().unwrap().unwrap(), |_| {});
    host.register(&e.session);
    e.tier.set_editor_host(&host);
    e.write("n.md", "first words\n");
    e.open();
    e.facts_until(indexed);
    let id = e.rows()[0].0.clone();
    // The watcher's start settles before the test edits the file.
    std::thread::sleep(Duration::from_millis(300));
    Served { e, host, id }
}

/// A window's copy of the note, and the frames its channel received.
struct Window {
    doc: Doc,
    frames: Frames,
}

impl Served {
    fn open(&self, label: &str) -> Window {
        let frames: Frames = Arc::default();
        let sink = Arc::clone(&frames);
        let subscriber = Subscriber {
            window_label: label.to_owned(),
            channel: Arc::new(move |frame| {
                sink.lock().unwrap().push(frame);
                true
            }),
        };
        let opened = self
            .host
            .open(&self.id, Some(&self.e.vault), subscriber)
            .unwrap();
        let doc = Doc::new();
        doc.transact_mut()
            .apply_update(Update::decode_v1(&opened.state).unwrap())
            .unwrap();
        Window { doc, frames }
    }

    fn changed_by_the_watcher(&mut self) {
        let id = self.id.clone();
        self.e.facts_until(move |f| {
            matches!(f, Applied::Changed { note_id, source: ChangeSource::Watcher, .. } if *note_id == id)
        });
    }

    /// Waits for the write-back to write `text` to the note's file.
    fn file_becomes(&self, text: &str) {
        let deadline = Instant::now() + WAIT;
        while self.e.read("n.md") != text {
            assert!(
                Instant::now() < deadline,
                "the file is {:?}",
                self.e.read("n.md")
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Window {
    /// The kind byte of each frame the window received, once it holds the outside edit's frame
    /// and the release.
    fn kinds_once_released(&self) -> Vec<u8> {
        let deadline = Instant::now() + WAIT;
        loop {
            let kinds: Vec<u8> = self.frames.lock().unwrap().iter().map(|f| f[0]).collect();
            if kinds.contains(&RELEASE) && kinds.contains(&2) {
                return kinds;
            }
            assert!(Instant::now() < deadline, "the frames are {kinds:?}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Types `text` at the end of the first paragraph and returns the update, not sent yet.
    fn type_text(&self, text: &str) -> Vec<u8> {
        let before = self.doc.transact().state_vector();
        let mut txn = self.doc.transact_mut();
        let fragment = txn.get_or_insert_xml_fragment(BODY_FRAGMENT);
        let mut node = fragment.get(&txn, 0).expect("a block group");
        let paragraph = loop {
            node = match node {
                XmlOut::Element(element) => element.get(&txn, 0).expect("a child"),
                XmlOut::Text(text) => break text,
                XmlOut::Fragment(_) => panic!("a fragment in the body"),
            };
        };
        let end = paragraph.len(&txn);
        paragraph.insert(&mut txn, end, text);
        drop(txn);
        self.doc.transact().encode_diff_v1(&before)
    }

    /// Sends `typed` as the window does once its channel asks: at the barrier, then answers
    /// it; or, with no barrier, after the outside edit's frame, as typing still on its way.
    fn send_when_asked(
        &self,
        served: &Served,
        label: &str,
        typed: Vec<u8>,
    ) -> JoinHandle<Option<u8>> {
        let (host, id, label) = (
            Arc::clone(&served.host),
            served.id.clone(),
            label.to_owned(),
        );
        let frames = Arc::clone(&self.frames);
        std::thread::spawn(move || {
            let deadline = Instant::now() + WAIT;
            loop {
                let first = frames
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|frame| matches!(frame.first(), Some(&BARRIER | &2)))
                    .cloned();
                if let Some(frame) = first {
                    host.apply_update(&id, &typed, &label).unwrap();
                    if frame[0] == BARRIER {
                        let barrier = u32::from_le_bytes(frame[1..5].try_into().unwrap());
                        host.typing_sent(&label, barrier);
                    }
                    return Some(frame[0]);
                }
                if Instant::now() > deadline {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        })
    }
}

/// Typing the window had not sent when the file was edited outside is sent at the barrier: the
/// body is ahead of the file when the consumer chooses, so the typing wins, the outside file is
/// kept as a version, and the write-back writes the typing.
#[test]
fn typing_not_sent_when_the_file_is_edited_outside_wins_over_the_edit() {
    let mut s = served();
    let main = s.open("main");
    let typed = main.type_text(" and more");
    let answered = main.send_when_asked(&s, "main", typed);

    s.e.write("n.md", OUTSIDE);
    s.changed_by_the_watcher();

    let answered = answered.join().unwrap();
    assert_eq!(s.e.body(&s.id), "first words and more");
    assert!(s.e.versions(&s.id).iter().any(|v| v == OUTSIDE));
    assert_eq!(answered, Some(BARRIER));
    s.file_becomes("first words and more\n");
}

/// Two windows each hold typing they had not sent: both send it at the barrier, the body keeps
/// each once, and the outside edit is kept as a version.
#[test]
fn two_windows_typing_both_win_over_an_outside_edit_once_each() {
    let mut s = served();
    let main = s.open("main");
    let side = s.open("side");
    let typed_main = main.type_text(" from main");
    let typed_side = side.type_text(" from side");
    let answered = [
        main.send_when_asked(&s, "main", typed_main),
        side.send_when_asked(&s, "side", typed_side),
    ];

    s.e.write("n.md", OUTSIDE);
    s.changed_by_the_watcher();

    let answered = answered.map(|window| window.join().unwrap());
    let body = s.e.body(&s.id);
    assert!(body.starts_with("first words"), "{body}");
    assert_eq!(body.matches(" from main").count(), 1, "{body}");
    assert_eq!(body.matches(" from side").count(), 1, "{body}");
    assert!(s.e.versions(&s.id).iter().any(|v| v == OUTSIDE));
    assert_eq!(answered, [Some(BARRIER); 2]);
}

/// A window with no typing answers its barrier at once; the consumer feeds the outside edit and
/// drops its hold only after: the window's frames come barrier, the edit's frame, release, so
/// its hold of new typing covers the whole time the edit's frame is on its way.
#[test]
fn a_window_hears_the_fed_outside_edit_between_its_barrier_and_its_release() {
    let mut s = served();
    let main = s.open("main");
    let answered = {
        let (host, frames) = (Arc::clone(&s.host), Arc::clone(&main.frames));
        std::thread::spawn(move || {
            let deadline = Instant::now() + WAIT;
            loop {
                let barrier = frames
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|frame| frame.first() == Some(&BARRIER))
                    .map(|frame| u32::from_le_bytes(frame[1..5].try_into().unwrap()));
                if let Some(barrier) = barrier {
                    host.typing_sent("main", barrier);
                    return;
                }
                assert!(Instant::now() < deadline, "no barrier frame");
                std::thread::sleep(Duration::from_millis(5));
            }
        })
    };

    s.e.write("n.md", OUTSIDE);
    s.changed_by_the_watcher();
    answered.join().unwrap();

    assert_eq!(s.e.body(&s.id), "edited outside");
    assert_eq!(main.kinds_once_released(), [BARRIER, 2, RELEASE]);
}
