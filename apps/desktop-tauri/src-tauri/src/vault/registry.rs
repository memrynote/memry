//! Multi-vault registry persisted at
//! `<app-data>/memry-{device}/vaults.json`.
//!
//! This file is a per-device sibling of M2's `data.db` and stores the known
//! vault list plus the current vault path. It is small and only written on
//! explicit user actions, so sync JSON IO is intentional here.

use crate::error::{AppError, AppResult};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub path: String,
    pub name: String,
    pub note_count: i64,
    pub task_count: i64,
    pub last_opened: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultRegistry {
    #[serde(default)]
    pub vaults: Vec<VaultInfo>,
    #[serde(default)]
    pub current: Option<String>,
}

impl VaultRegistry {
    pub fn load(path: &Path) -> AppResult<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }

        let raw = fs::read_to_string(path)?;
        let parsed = serde_json::from_str(&raw).unwrap_or_default();
        Ok(parsed)
    }

    pub fn save(&self, path: &Path) -> AppResult<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let raw = serde_json::to_string_pretty(self)?;
        fs::write(path, raw)?;
        Ok(())
    }

    pub fn find(&self, vault_path: &str) -> Option<&VaultInfo> {
        self.vaults.iter().find(|vault| vault.path == vault_path)
    }

    pub fn upsert(&mut self, info: VaultInfo) {
        if let Some(existing) = self.vaults.iter_mut().find(|vault| vault.path == info.path) {
            *existing = info;
        } else {
            self.vaults.push(info);
        }
    }

    pub fn remove(&mut self, vault_path: &str) {
        self.vaults.retain(|vault| vault.path != vault_path);
        if self.current.as_deref() == Some(vault_path) {
            self.current = None;
        }
    }

    pub fn set_current(&mut self, current: Option<String>) {
        self.current = current;
    }

    pub fn touch(&mut self, vault_path: &str) {
        let now = current_iso();
        if let Some(existing) = self
            .vaults
            .iter_mut()
            .find(|vault| vault.path == vault_path)
        {
            existing.last_opened = now;
        }
    }
}

pub fn registry_path() -> AppResult<PathBuf> {
    let device = std::env::var("MEMRY_DEVICE").unwrap_or_else(|_| "default".to_string());
    let project_dirs = directories::ProjectDirs::from("com", "memry", "memry")
        .ok_or_else(|| AppError::Internal("could not determine OS project dirs".to_string()))?;

    Ok(project_dirs
        .data_dir()
        .join(format!("memry-{device}"))
        .join("vaults.json"))
}

fn current_iso() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let base = crate::vault::frontmatter_iso(duration.as_secs());
    let millis = duration.subsec_millis();

    if let Some(prefix) = base.strip_suffix('Z') {
        format!("{prefix}.{millis:03}Z")
    } else {
        base
    }
}
