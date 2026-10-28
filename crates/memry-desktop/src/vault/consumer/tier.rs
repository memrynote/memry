//! Hangs the watcher and the consumer on the session: both start at `OpenStage::Watcher` of
//! every open and stop, joined, when the vault closes. The rows' lane lives across sessions
//! (the app holds it), and is open only while a vault is.

use std::sync::{Arc, Mutex};

use memry_core::seams::secure_store::SecureStore;
use tokio::sync::broadcast;

use super::apply::Applier;
use super::identity::{DeferIdentity, NoteIdentity};
use super::rows::RowOwner;
use super::{Applied, Consumer, ConsumerOptions, QUEUE_CAPACITY, inbox};
use crate::session::{OpenStage, OpenVault, Session};
use crate::vault::config::read_vault_config;
use crate::vault::watch::{EchoGuard, NewFiles, VaultWatcher};

pub struct VaultTier {
    /// The own-write record of the open vault session; every open and close starts a new one.
    echo: Mutex<Arc<EchoGuard>>,
    /// Holds the device key the feed writes under.
    store: Arc<dyn SecureStore>,
    rows: Arc<RowOwner>,
    identity: Mutex<Arc<dyn NoteIdentity>>,
    options: ConsumerOptions,
    running: Mutex<Option<Running>>,
}

struct Running {
    watcher: VaultWatcher,
    consumer: Consumer,
}

impl VaultTier {
    pub fn new(store: Arc<dyn SecureStore>) -> Arc<Self> {
        Self::with_options(store, ConsumerOptions::default())
    }

    pub fn with_options(store: Arc<dyn SecureStore>, options: ConsumerOptions) -> Arc<Self> {
        Arc::new(Self {
            echo: Mutex::new(Arc::default()),
            store,
            rows: RowOwner::new(),
            identity: Mutex::new(Arc::new(DeferIdentity)),
            options,
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
        // fact reaches a consumer that is stopping.
        if let Some(Running {
            watcher,
            mut consumer,
        }) = running
        {
            watcher.stop_and_drop();
            consumer.stop();
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
        let applier = Applier {
            root: vault.path.clone(),
            vault: vault.vault.clone(),
            rows: self.rows.clone(),
            identity,
            feed,
            settings: vault.vault.app_settings(self.store.clone()).ok(),
            feed_changes: self.options.feed_changes,
        };
        let consumer = Consumer::start(applier, inbox, watcher.handle(), exclude)
            .map_err(|error| error.to_string())?;
        Ok(Running { watcher, consumer })
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
