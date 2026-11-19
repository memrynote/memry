//! The sandbox vault: a populated showcase vault the app builds in its own data
//! folder, outside the user's vault list (Electron: `apps/desktop/src/main/vault/sandbox.ts`).
//!
//! Electron runs the TypeScript generator (`apps/cli/src/sandbox/`) on every
//! regeneration. The Tauri app replays a template that generator exported once
//! (`apps/cli/src/sandbox/export-template.ts`) into `resources/sandbox/`:
//! the vault files, `seed.json` (the database rows, parsed as [`Manifest`]) and
//! `manifest.json` (the moment and the generator's count table, [`TemplateInfo`]).
//! [`rebase`] moves the template's dates to today, [`replay`] builds the vault from the
//! template, and [`marker`] records which app version generated the folder.

pub mod manifest;
pub mod marker;
pub mod rebase;
pub mod replay;

pub use manifest::{AssetCopy, Manifest, Row, TemplateInfo};
pub use rebase::{Rebase, device_zone_name};
pub use replay::{ReplayOptions, SeedCounts, Template, replay};

/// Why a sandbox template or marker could not be used.
#[derive(Debug, thiserror::Error)]
pub enum SandboxError {
    #[error("sandbox template is too large: {0}")]
    TooLarge(String),
    #[error("sandbox template is not valid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("sandbox template version {0} is not supported")]
    UnsupportedVersion(u32),
    #[error("sandbox template time zone {0:?} is not supported; templates are exported in UTC")]
    UnsupportedTimezone(String),
    #[error("sandbox template generatedAt {0:?} is not an RFC 3339 instant")]
    BadGeneratedAt(String),
    #[error("sandbox template has rows for unknown table {0:?}")]
    UnknownTable(String),
    #[error("sandbox template path {0:?} is not a plain vault-relative path")]
    UnsafePath(String),
    #[error("sandbox template asset {0:?} is not a bundled asset file name with a sha256")]
    BadAsset(String),
    #[error("sandbox template value {0} is not an RFC 3339 instant")]
    BadRow(String),
    #[error("sandbox template lists {0:?}, which its vault folder lacks")]
    MissingFile(String),
    #[error("sandbox target {0:?} is not a folder name the replay may write")]
    UnsafeTarget(String),
    #[error(
        "sandbox target {0:?} holds files; only an earlier sandbox is replaced, and only when asked"
    )]
    TargetNotEmpty(String),
    #[error("sandbox file error at {path}: {message}")]
    Io { path: String, message: String },
    #[error("sandbox vault database: {0}")]
    Core(String),
    #[error("sandbox note {0:?} was not created")]
    NoteNotCreated(String),
}
