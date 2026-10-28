//! Hangs the watcher, the consumer and the write-back on the session: all start at
//! `OpenStage::Watcher` of every open and stop, joined, when the vault closes. The rows' lane lives across sessions
//! (the app holds it), and is open only while a vault is.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_core::seams::secure_store::SecureStore;
use tokio::sync::broadcast;

use super::apply::Applier;
use super::identity::{DeferIdentity, NoteIdentity};
use super::rows::RowOwner;
use super::{Applied, Consumer, QUEUE_CAPACITY, inbox};
use crate::session::{OpenStage, OpenVault, Session};
use crate::shell::shutdown::StepFn;
use crate::vault::config::read_vault_config;
use crate::vault::watch::{EchoGuard, NewFiles, VaultWatcher};
use crate::vault::writeback::{Pass, WriteBack, WriteBackFailed};

pub struct VaultTier {
    /// The own-write record of the open vault session; every open and close starts a new one.
    echo: Mutex<Arc<EchoGuard>>,
    /// Holds the device key the feed writes under.
    store: Arc<dyn SecureStore>,
    rows: Arc<RowOwner>,
    identity: Mutex<Arc<dyn NoteIdentity>>,
    /// Every session's failed write-backs, for the notice.
    failures: broadcast::Sender<WriteBackFailed>,
    running: Mutex<Option<Running>>,
}

struct Running {
    watcher: VaultWatcher,
    consumer: Consumer,
    writeback: Arc<WriteBack>,
}

impl VaultTier {
    pub fn new(store: Arc<dyn SecureStore>) -> Arc<Self> {
        Arc::new(Self {
            echo: Mutex::new(Arc::default()),
            store,
            rows: RowOwner::new(),
            identity: Mutex::new(Arc::new(DeferIdentity)),
            failures: broadcast::channel(64).0,
            running: Mutex::new(None),
        })
    }

    /// The record every writer tells before it changes a vault file, so the watcher does not
    /// report the write back as an outside edit. It belongs to the open vault session: a record
    /// made in one vault must never hide a change in the next, so a writer asks again for each
    /// write instead of keeping the handle.
    pub fn echo(&self) -> Arc<EchoGuard> {
        self.echo.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// The lane the app's own file operations write their rows through.
    pub fn rows(&self) -> Arc<RowOwner> {
        self.rows.clone()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Applied> {
        self.rows.subscribe()
    }

    /// Writes the note's body to its vault file, on the write-back thread
    /// ([`crate::vault::writeback`]). The editor (Step 14) calls it once a body edit is durable,
    /// the sync driver (Step 17) once a page committed. Nothing happens while no vault is open.
    pub fn schedule(&self, note_id: &str) {
        match self
            .running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            Some(running) => running.writeback.schedule(note_id),
            None => tracing::debug!(scope = "vault_writeback", note_id, "no vault is open"),
        }
    }

    /// Every note whose file could not be updated from its body, once per run of failures.
    pub fn subscribe_failures(&self) -> broadcast::Receiver<WriteBackFailed> {
        self.failures.subscribe()
    }

    /// Runs every scheduled write-back of the open vault now and waits, at most `timeout`, for
    /// them. True when none is left; also when no vault is open.
    pub fn flush(&self, timeout: Duration) -> bool {
        let writeback = self
            .running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|running| running.writeback.clone());
        writeback.is_none_or(|writeback| writeback.flush(timeout))
    }

    /// The `flush-writebacks` shutdown step: every scheduled write-back runs inside the quit's
    /// budget. An error says some did not finish in it, so the last chance runs the step again.
    pub fn flush_step(self: &Arc<Self>) -> StepFn {
        let tier = self.clone();
        Arc::new(move |_, deadline| {
            let tier = tier.clone();
            Box::pin(async move {
                let timeout = deadline.remaining();
                let done = tokio::task::spawn_blocking(move || tier.flush(timeout))
                    .await
                    .map_err(|error| error.to_string())?;
                if done {
                    Ok(())
                } else {
                    Err("write-backs were still running when the budget ran out".into())
                }
            })
        })
    }

    /// The identity of the next open on ([`DeferIdentity`] until Step 13 sets its own).
    pub fn set_identity(&self, identity: Arc<dyn NoteIdentity>) {
        *self.identity.lock().unwrap_or_else(|e| e.into_inner()) = identity;
    }

    fn stop(&self) {
        *self.echo.lock().unwrap_or_else(|e| e.into_inner()) = Arc::default();
        let running = self
            .running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        // Joined outside the lock: each waits for its current step. The watcher first, so no
        // fact reaches a consumer that is stopping; the write-back runs what was scheduled
        // while the rows are still open.
        if let Some(Running {
            watcher,
            mut consumer,
            writeback,
        }) = running
        {
            watcher.stop_and_drop();
            consumer.stop();
            writeback.stop();
        }
        self.rows.close();
    }

    fn start(&self, vault: &OpenVault) -> Result<Running, String> {
        let exclude = read_vault_config(&vault.path).exclude_patterns;
        self.rows
            .open(vault.vault.clone())
            .map_err(|error| error.to_string())?;
        let identity = self
            .identity
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let new_files = if identity.adopts() {
            NewFiles::Report
        } else {
            NewFiles::PairOnly
        };
        let (sink, inbox) = inbox(QUEUE_CAPACITY);
        let watcher = VaultWatcher::start(
            vault.path.clone(),
            exclude.clone(),
            vault.vault.note_files(),
            self.echo(),
            sink,
            new_files,
        )
        .map_err(|error| error.to_string())?;
        let feed = vault
            .vault
            .external_feed(self.store.clone())
            .inspect_err(|error| {
                tracing::warn!(
                    scope = "vault_consumer",
                    "no file's text can reach a note in this session: {error}"
                );
            })
            .ok();
        let session = self
            .rows
            .session_for(&vault.vault)
            .map_err(|error| error.to_string())?;
        let pass = Pass::new(
            vault.path.clone(),
            vault.vault.clone(),
            self.rows.clone(),
            session,
            self.echo(),
            vault.vault.app_settings(self.store.clone()).ok(),
        );
        let writeback = WriteBack::start(pass, self.failures.clone())
            .map(Arc::new)
            .map_err(|error| error.to_string())?;
        let applier = Applier {
            root: vault.path.clone(),
            vault: vault.vault.clone(),
            rows: self.rows.clone(),
            identity,
            feed,
            settings: vault.vault.app_settings(self.store.clone()).ok(),
        };
        let consumer = Consumer::start(applier, inbox, watcher.handle(), exclude)
            .map_err(|error| error.to_string())?;
        Ok(Running {
            watcher,
            consumer,
            writeback,
        })
    }

    /// Registers the open and close hooks. A watcher that cannot start fails its hook, which
    /// the session reports and survives: the vault opens without file watching.
    pub fn register(self: &Arc<Self>, session: &Session) {
        let tier = self.clone();
        session.on_open(
            "vault-watcher",
            OpenStage::Watcher,
            Arc::new(move |vault| {
                tier.stop();
                match tier.start(vault) {
                    Ok(running) => {
                        *tier.running.lock().unwrap_or_else(|e| e.into_inner()) = Some(running);
                        Ok(())
                    }
                    Err(error) => {
                        tier.rows.close();
                        Err(error)
                    }
                }
            }),
        );
        let tier = self.clone();
        session.on_close("vault-watcher", Arc::new(move |_| tier.stop()));
    }
}
