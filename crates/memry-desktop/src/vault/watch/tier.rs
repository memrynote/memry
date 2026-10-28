//! Hangs the watcher on the session: it starts at `OpenStage::Watcher` of every open and
//! stops, joined, when the vault closes.

use std::sync::{Arc, Mutex};

use super::echo::EchoGuard;
use super::event::EventSink;
use super::runtime::VaultWatcher;
use crate::session::{OpenStage, Session};
use crate::vault::config::read_vault_config;

pub struct VaultTier {
    /// The own-write record of the open vault session; every open and close starts a new one.
    echo: Mutex<Arc<EchoGuard>>,
    sink: EventSink,
    running: Mutex<Option<VaultWatcher>>,
}

impl VaultTier {
    pub fn new(sink: EventSink) -> Arc<Self> {
        Arc::new(Self {
            echo: Mutex::new(Arc::default()),
            sink,
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

    fn stop(&self) {
        *self.echo.lock().unwrap_or_else(|e| e.into_inner()) = Arc::default();
        let running = self
            .running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        // Joined outside the lock: it waits for the worker's current step.
        drop(running);
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
                let exclude = read_vault_config(&vault.path).exclude_patterns;
                let watcher = VaultWatcher::start(
                    vault.path.clone(),
                    exclude,
                    vault.vault.note_files(),
                    tier.echo(),
                    tier.sink.clone(),
                )
                .map_err(|error| error.to_string())?;
                *tier.running.lock().unwrap_or_else(|e| e.into_inner()) = Some(watcher);
                Ok(())
            }),
        );
        let tier = self.clone();
        session.on_close("vault-watcher", Arc::new(move |_| tier.stop()));
    }
}
