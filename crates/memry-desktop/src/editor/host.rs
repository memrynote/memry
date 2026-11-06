//! [`EditorHost`]: the open vault's editor, served to windows.
//!
//! **Subscribed before opened.** A window's subscriber and the document's listener are in place
//! before core opens the document for it, so an update committed while the open runs reaches
//! the window: either inside the state it receives or on its channel, and Yjs ignores the one it
//! gets twice. Subscribing after the open would lose an update committed in between.
//!
//! **Lock order.** Core calls a listener with none of its locks held, and the listener takes the
//! subscriber map. So the map may be held while core's subscribe or unsubscribe runs, and never
//! while a core call that commits (and so fans out) runs.

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use memry_core::api::editor::{Editor, ListenerId, Opened, Origin};
use memry_core::api::vault::Vault;
use memry_core::seams::secure_store::SecureStore;

use super::{Deliver, EditorHostError, Subscriber, frame};
use crate::session::{OpenStage, OpenVault, Session, canonical, lock};

/// How often unheld documents past their grace period are unloaded.
const SWEEP_EVERY: Duration = Duration::from_secs(15);
const SWEEP_TICK: Duration = Duration::from_millis(100);

/// The editor's lifecycle, for the windows (`crdt:provider-reset`, `crdt:provider-ready`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostEvent {
    /// The vault closed: every window's binding is dead. Windows wait for `Ready` to reopen.
    Reset,
    /// The vault at `vault_path` serves `open` again.
    Ready { vault_path: String },
}

/// `crdt:get-health`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EditorHealth {
    pub persistent: bool,
    /// Launches in a row, this one included, whose edits stayed in memory. The streak across
    /// launches is not kept yet, so it counts this launch only.
    pub in_memory_sessions: u32,
}

struct Doc {
    listener: ListenerId,
    subscribers: Vec<Subscriber>,
}

type Docs = Mutex<HashMap<String, Doc>>;

#[derive(Clone)]
struct Served {
    vault: Weak<Vault>,
    path: PathBuf,
    editor: Arc<Editor>,
    docs: Arc<Docs>,
}

pub struct EditorHost {
    store: Arc<dyn SecureStore>,
    notify: Box<dyn Fn(HostEvent) + Send + Sync>,
    served: Mutex<Option<Served>>,
}

impl EditorHost {
    pub fn new(
        store: Arc<dyn SecureStore>,
        notify: impl Fn(HostEvent) + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            notify: Box::new(notify),
            served: Mutex::new(None),
        })
    }

    /// Serves each vault from its open until its close, says so to the windows, and sweeps its
    /// unheld documents on [`SWEEP_EVERY`].
    pub fn register(self: &Arc<Self>, session: &Session) {
        let host = Arc::clone(self);
        session.on_open(
            "editor-host",
            OpenStage::Defaults,
            Arc::new(move |view| host.serve(view)),
        );
        let host = Arc::clone(self);
        session.on_open(
            "editor-ready",
            OpenStage::SyncStart,
            Arc::new(move |view| {
                if host.serving(view).is_some() {
                    (host.notify)(HostEvent::Ready {
                        vault_path: view.path.to_string_lossy().into_owned(),
                    });
                }
                Ok(())
            }),
        );
        let host = Arc::clone(self);
        session.on_background(
            "editor-sweep",
            Arc::new(move |view, cancel| {
                loop {
                    let mut waited = Duration::ZERO;
                    while waited < SWEEP_EVERY {
                        if cancel.is_cancelled() {
                            return Ok(());
                        }
                        std::thread::sleep(SWEEP_TICK);
                        waited += SWEEP_TICK;
                    }
                    if let Some(served) = host.serving(view) {
                        served.editor.sweep(now_ms());
                    }
                }
            }),
        );
        let host = Arc::clone(self);
        session.on_close("editor-host", Arc::new(move |view| host.stop(view)));
    }

    /// Serves `view`'s editor from now on.
    fn serve(&self, view: &OpenVault) -> Result<(), String> {
        let editor = view
            .vault
            .editor(Arc::clone(&self.store))
            .map_err(|error| format!("the vault opens without its editor: {error}"))?;
        *lock(&self.served) = Some(Served {
            vault: Arc::downgrade(&view.vault),
            path: canonical(&view.path),
            editor,
            docs: Arc::default(),
        });
        Ok(())
    }

    /// `view` closed: its windows' subscriptions go with the served editor (its listeners find
    /// no subscriber), and every window hears the reset. A late close of an earlier vault
    /// leaves the open one served and its windows bound.
    pub fn stop(&self, view: &OpenVault) {
        {
            let mut served = lock(&self.served);
            let ours = served
                .as_ref()
                .is_some_and(|s| Weak::ptr_eq(&s.vault, &Arc::downgrade(&view.vault)));
            if !ours {
                return;
            }
            *served = None;
        }
        (self.notify)(HostEvent::Reset);
    }

    /// `subscriber`'s window opens `note_id` and receives its state; from now on every update
    /// another window or writer commits reaches its channel. `vault_path` is the vault the
    /// window's editor belongs to, when it says.
    pub fn open(
        &self,
        note_id: &str,
        vault_path: Option<&Path>,
        subscriber: Subscriber,
    ) -> Result<Opened, EditorHostError> {
        let served = self.current()?;
        if vault_path.is_some_and(|path| canonical(path) != served.path) {
            return Err(EditorHostError::OtherVault);
        }
        let label = subscriber.window_label.clone();
        let replaced = served.subscribe(note_id, subscriber);
        served.editor.open(note_id, &label).map_err(|error| {
            // A window that had the document open keeps it, as core keeps its hold.
            if !replaced {
                served.drop_subscriber(note_id, &label);
            }
            error.into()
        })
    }

    /// A window's edit: stored, queued and sent to the other windows.
    pub fn apply_update(
        &self,
        note_id: &str,
        update: &[u8],
        window_label: &str,
    ) -> Result<(), EditorHostError> {
        self.current()?
            .editor
            .apply_update(note_id, update, window_label)?;
        Ok(())
    }

    /// Sync step 1: what the document holds beyond the window's `state_vector`, and the
    /// document's own state vector.
    pub fn sync_step_1(
        &self,
        note_id: &str,
        state_vector: &[u8],
    ) -> Result<(Vec<u8>, Vec<u8>), EditorHostError> {
        let editor = self.current()?.editor;
        let diff = editor.state_diff(note_id, state_vector)?;
        Ok((diff, editor.state_vector(note_id)?))
    }

    /// The window closed its editor of `note_id`.
    pub fn close(&self, note_id: &str, window_label: &str) {
        if let Ok(served) = self.current() {
            served.editor.release(note_id, window_label);
            served.drop_subscriber(note_id, window_label);
        }
    }

    /// The window is gone (closed, or its page died or was replaced): it lets go of every
    /// document it held, and nothing is sent to it any more.
    pub fn forget_window(&self, window_label: &str) {
        let Ok(served) = self.current() else { return };
        served.editor.release_holder(window_label);
        let mut docs = lock(&served.docs);
        docs.retain(|_, doc| {
            doc.subscribers.retain(|s| s.window_label != window_label);
            if doc.subscribers.is_empty() {
                served.editor.unsubscribe(doc.listener);
            }
            !doc.subscribers.is_empty()
        });
    }

    pub fn health(&self) -> Result<EditorHealth, EditorHostError> {
        // With no vault open nothing is held in memory: Electron answers from the last launch's
        // verdict, which is persistent unless its store failed.
        let Ok(served) = self.current() else {
            return Ok(EditorHealth {
                persistent: true,
                in_memory_sessions: 0,
            });
        };
        let persistent = served.editor.health()?.persistent;
        Ok(EditorHealth {
            persistent,
            in_memory_sessions: u32::from(!persistent),
        })
    }

    fn current(&self) -> Result<Served, EditorHostError> {
        lock(&self.served)
            .clone()
            .ok_or(EditorHostError::NotServing)
    }

    fn serving(&self, view: &OpenVault) -> Option<Served> {
        self.current()
            .ok()
            .filter(|s| Weak::ptr_eq(&s.vault, &Arc::downgrade(&view.vault)))
    }
}

impl Served {
    /// Adds `subscriber`, or replaces its window's earlier one (a reopen brings a new channel).
    /// True when it replaced one.
    fn subscribe(&self, note_id: &str, subscriber: Subscriber) -> bool {
        let mut docs = lock(&self.docs);
        let doc = match docs.entry(note_id.to_owned()) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => {
                let listener = self
                    .editor
                    .subscribe(note_id, fan_out(Arc::downgrade(&self.docs), note_id));
                entry.insert(Doc {
                    listener,
                    subscribers: Vec::new(),
                })
            }
        };
        let label = &subscriber.window_label;
        match doc
            .subscribers
            .iter_mut()
            .find(|s| &s.window_label == label)
        {
            Some(earlier) => {
                *earlier = subscriber;
                true
            }
            None => {
                doc.subscribers.push(subscriber);
                false
            }
        }
    }

    fn drop_subscriber(&self, note_id: &str, window_label: &str) {
        let mut docs = lock(&self.docs);
        let Some(doc) = docs.get_mut(note_id) else {
            return;
        };
        doc.subscribers.retain(|s| s.window_label != window_label);
        if doc.subscribers.is_empty() {
            self.editor.unsubscribe(doc.listener);
            docs.remove(note_id);
        }
    }
}

/// The listener of one document: each update goes to every subscriber but the window that sent
/// it. A channel that cannot receive any more is dropped (its window is gone); the window's
/// close releases its hold.
fn fan_out(docs: Weak<Docs>, note_id: &str) -> impl Fn(&[u8], &Origin) + Send + Sync + 'static {
    let note_id = note_id.to_owned();
    move |update, origin| {
        let Some(docs) = docs.upgrade() else { return };
        let sender = match origin {
            Origin::Local(holder) => Some(holder.as_str()),
            _ => None,
        };
        let targets: Vec<Deliver> = lock(&docs)
            .get(&note_id)
            .map(|doc| {
                doc.subscribers
                    .iter()
                    .filter(|s| Some(s.window_label.as_str()) != sender)
                    .map(|s| Arc::clone(&s.channel))
                    .collect()
            })
            .unwrap_or_default();
        if targets.is_empty() {
            return;
        }
        let message = frame(update, origin);
        let gone: Vec<Deliver> = targets
            .into_iter()
            .filter(|channel| !channel(message.clone()))
            .collect();
        if gone.is_empty() {
            return;
        }
        if let Some(doc) = lock(&docs).get_mut(&note_id) {
            doc.subscribers
                .retain(|s| !gone.iter().any(|g| Arc::ptr_eq(g, &s.channel)));
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}
