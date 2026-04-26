//! Runtime state for the vault layer.
//!
//! `VaultRuntime` owns:
//! - the current vault path (None when no vault is open)
//! - status flags (is_indexing, index_progress, error)
//! - the in-memory registry handle (loaded from disk at boot)
//! - the active `notify` watcher handle (started on open, stopped on close)
//!
//! Tauri commands lock briefly per call, so this layer uses
//! `std::sync::Mutex`. The watcher handle has its own slot so replacing or
//! dropping it never happens while the registry/status lock is held.

use crate::error::{AppError, AppResult};
use crate::vault::registry::{registry_path, VaultInfo, VaultRegistry};
use crate::vault::watcher::WatcherHandle;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub is_open: bool,
    pub path: Option<String>,
    pub is_indexing: bool,
    pub index_progress: u8,
    pub error: Option<String>,
}

pub struct VaultRuntime {
    inner: Mutex<RuntimeInner>,
    pub watcher_slot: Mutex<Option<WatcherHandle>>,
    registry_path: PathBuf,
}

struct RuntimeInner {
    current: Option<PathBuf>,
    is_indexing: bool,
    index_progress: u8,
    error: Option<String>,
    registry: VaultRegistry,
}

impl VaultRuntime {
    pub fn boot() -> AppResult<Self> {
        let registry_path = registry_path()?;
        let registry = VaultRegistry::load(&registry_path).unwrap_or_default();

        Ok(Self {
            inner: Mutex::new(RuntimeInner {
                current: registry.current.as_ref().map(PathBuf::from),
                is_indexing: false,
                index_progress: 0,
                error: None,
                registry,
            }),
            watcher_slot: Mutex::new(None),
            registry_path,
        })
    }

    pub fn status(&self) -> VaultStatus {
        let g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        VaultStatus {
            is_open: g.current.is_some(),
            path: g
                .current
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            is_indexing: g.is_indexing,
            index_progress: g.index_progress,
            error: g.error.clone(),
        }
    }

    pub fn current_path(&self) -> Option<PathBuf> {
        let g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.current.clone()
    }

    pub fn registry_snapshot(&self) -> VaultRegistry {
        let g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.registry.clone()
    }

    pub fn set_current(&self, path: Option<PathBuf>) -> AppResult<()> {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.current = path.clone();
        g.error = None;
        g.registry.set_current(
            path.as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
        );
        g.registry.save(&self.registry_path)
    }

    pub fn upsert_registry(&self, info: VaultInfo) -> AppResult<()> {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.registry.upsert(info);
        g.registry.save(&self.registry_path)
    }

    pub fn remove_from_registry(&self, vault_path: &str) -> AppResult<()> {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.registry.remove(vault_path);
        if g.current
            .as_ref()
            .is_some_and(|path| path.to_string_lossy() == vault_path)
        {
            g.current = None;
        }
        g.registry.save(&self.registry_path)
    }

    pub fn touch_registry(&self, vault_path: &str) -> AppResult<()> {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.registry.touch(vault_path);
        g.registry.save(&self.registry_path)
    }

    pub fn set_indexing(&self, indexing: bool, progress: u8) {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.is_indexing = indexing;
        g.index_progress = progress;
    }

    pub fn set_error(&self, error: Option<String>) {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.error = error;
    }

    pub fn require_current(&self) -> AppResult<PathBuf> {
        self.current_path()
            .ok_or_else(|| AppError::Vault("no vault is open".into()))
    }
}
