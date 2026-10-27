//! Spelling suggestions and the personal dictionary, one backend per platform behind
//! `memry_desktop::shell::spell::SpellBackend`: `NSSpellChecker` on macOS, `ISpellChecker` on
//! Windows, Enchant (loaded at run time) on Linux.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod mac;
#[cfg(windows)]
mod win;

use std::sync::Arc;

use memry_desktop::shell::spell::SpellBackend;
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::CommandError;
use crate::startup::{self, Stage};

/// The platform backend, or none when the platform has no dictionary.
pub struct SpellService {
    backend: Option<Arc<dyn SpellBackend>>,
}

/// Removes a word a spec added to the personal dictionary (macOS only: the other backends keep
/// theirs in the throwaway profile of the runner).
#[cfg(all(target_os = "macos", feature = "e2e"))]
pub fn unlearn(app: &AppHandle<Wry>, word: &str) {
    mac::unlearn(app, word);
}

impl SpellService {
    pub fn backend(&self) -> Option<Arc<dyn SpellBackend>> {
        self.backend.clone()
    }
}

pub fn register_stages() {
    startup::register(Stage::Handlers, "start spell checker", start);
}

fn start(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    #[cfg(target_os = "macos")]
    let backend: Option<Arc<dyn SpellBackend>> = Some(Arc::new(mac::MacSpell::new(app.clone())));
    #[cfg(target_os = "linux")]
    let backend: Option<Arc<dyn SpellBackend>> = linux::Enchant::load().map(|e| Arc::new(e) as _);
    #[cfg(windows)]
    let backend: Option<Arc<dyn SpellBackend>> = win::WinSpell::start().map(|w| Arc::new(w) as _);
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    let backend: Option<Arc<dyn SpellBackend>> = None;
    if backend.is_none() {
        tracing::warn!(
            scope = "Spell",
            "no spell checker is available; suggestions are off"
        );
    }
    app.manage(SpellService { backend });
    Ok(())
}
