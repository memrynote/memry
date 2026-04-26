//! `notify` filesystem watcher with path-keyed debounce.
//!
//! - `start(vault_root, sender)` registers a recursive recommended
//!   watcher rooted at `vault_root` and returns an opaque handle that
//!   stops the watcher when dropped.
//! - Raw `notify` events are filtered: hidden basenames (`.foo`),
//!   anything inside `.memry/`, and unsupported extensions are
//!   ignored before queuing.
//! - A path-keyed debounce coalesces rapid writes within 150ms per
//!   file. Each file gets its own pending timer.
//! - The output channel emits `VaultEvent { relative_path, kind }`
//!   where `kind` is `Created`, `Modified`, or `Deleted`.

use crate::error::AppResult;
use crate::vault::paths;
use notify::{event::ModifyKind, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc::UnboundedSender;
use tokio::task::JoinHandle;

const DEBOUNCE_MS: u64 = 150;

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultEvent {
    pub relative_path: String,
    pub kind: VaultEventKind,
}

#[derive(Debug, Clone, Copy, serde::Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum VaultEventKind {
    Created,
    Modified,
    Deleted,
}

pub struct WatcherHandle {
    _watcher: RecommendedWatcher,
    _scheduler: JoinHandle<()>,
    cancel: Arc<std::sync::atomic::AtomicBool>,
}

impl Drop for WatcherHandle {
    fn drop(&mut self) {
        self.cancel
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

#[derive(Default)]
struct PendingMap {
    pending: HashMap<PathBuf, PendingEntry>,
}

struct PendingEntry {
    last_event: VaultEventKind,
    deadline: std::time::Instant,
}

pub fn start(vault_root: &Path, out: UnboundedSender<VaultEvent>) -> AppResult<WatcherHandle> {
    let canonical_root = dunce::canonicalize(vault_root)?;
    let pending = Arc::new(Mutex::new(PendingMap::default()));
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (raw_tx, mut raw_rx) = tokio::sync::mpsc::unbounded_channel::<notify::Event>();

    let cb_root = canonical_root.clone();
    let raw_tx_for_cb = raw_tx.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if event.paths.iter().all(|p| should_ignore(&cb_root, p)) {
                return;
            }
            let _ = raw_tx_for_cb.send(event);
        }
    })?;
    drop(raw_tx);

    watcher.watch(&canonical_root, RecursiveMode::Recursive)?;

    let pending_drain = pending.clone();
    let cancel_drain = cancel.clone();
    let root_for_drain = canonical_root.clone();
    let _drain: JoinHandle<()> = tokio::spawn(async move {
        while let Some(event) = raw_rx.recv().await {
            if cancel_drain.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            let kind = classify(&event.kind);
            for path in event.paths {
                if should_ignore(&root_for_drain, &path) {
                    continue;
                }
                let deadline = std::time::Instant::now() + Duration::from_millis(DEBOUNCE_MS);
                let mut g = pending_drain.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(entry) = g.pending.get_mut(&path) {
                    entry.deadline = deadline;
                    entry.last_event = if matches!(kind, VaultEventKind::Deleted)
                        || (matches!(entry.last_event, VaultEventKind::Deleted) && !path.exists())
                    {
                        VaultEventKind::Deleted
                    } else {
                        kind
                    };
                } else {
                    g.pending.insert(
                        path,
                        PendingEntry {
                            last_event: kind,
                            deadline,
                        },
                    );
                }
            }
        }
    });

    let pending_emit = pending.clone();
    let cancel_emit = cancel.clone();
    let root_for_emit = canonical_root.clone();
    let scheduler: JoinHandle<()> = tokio::spawn(async move {
        let tick = Duration::from_millis(50);
        loop {
            if cancel_emit.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            tokio::time::sleep(tick).await;
            let now = std::time::Instant::now();
            let ready: Vec<(PathBuf, VaultEventKind)> = {
                let mut g = pending_emit.lock().unwrap_or_else(|p| p.into_inner());
                let mut ready = Vec::new();
                g.pending.retain(|path, entry| {
                    if entry.deadline <= now {
                        ready.push((path.clone(), entry.last_event));
                        false
                    } else {
                        true
                    }
                });
                ready
            };
            for (path, kind) in ready {
                if let Some(rel) = paths::to_relative_path(&root_for_emit, &path) {
                    let _ = out.send(VaultEvent {
                        relative_path: rel,
                        kind,
                    });
                } else if matches!(kind, VaultEventKind::Deleted) {
                    if let Ok(stripped) = path.strip_prefix(&root_for_emit) {
                        let rel = stripped.to_string_lossy().replace('\\', "/");
                        let _ = out.send(VaultEvent {
                            relative_path: rel,
                            kind,
                        });
                    }
                }
            }
        }
    });

    Ok(WatcherHandle {
        _watcher: watcher,
        _scheduler: scheduler,
        cancel,
    })
}

fn should_ignore(root: &Path, path: &Path) -> bool {
    let rel = match path.strip_prefix(root) {
        Ok(rel) => rel,
        Err(_) => return true,
    };
    for component in rel.components() {
        if let std::path::Component::Normal(seg) = component {
            let s = seg.to_string_lossy();
            if s.starts_with('.') {
                return true;
            }
        }
    }
    if !path.is_dir() {
        let lower = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();
        if lower.is_empty() {
            return true;
        }
        let supported = matches!(
            lower.as_str(),
            "md" | "markdown"
                | "png"
                | "jpg"
                | "jpeg"
                | "gif"
                | "webp"
                | "svg"
                | "pdf"
                | "mp3"
                | "wav"
                | "m4a"
                | "ogg"
                | "mp4"
                | "mov"
                | "webm"
        );
        return !supported;
    }
    false
}

fn classify(kind: &EventKind) -> VaultEventKind {
    match kind {
        EventKind::Create(_) => VaultEventKind::Created,
        EventKind::Modify(ModifyKind::Name(_)) => VaultEventKind::Modified,
        EventKind::Modify(_) => VaultEventKind::Modified,
        EventKind::Remove(_) => VaultEventKind::Deleted,
        _ => VaultEventKind::Modified,
    }
}
