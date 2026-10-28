//! Spelling suggestions and the personal dictionary, one backend per platform behind
//! `memry_desktop::shell::spell::SpellBackend`: `NSSpellChecker` on macOS, `ISpellChecker` on
//! Windows, Enchant (loaded at run time) on Linux.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod mac;
#[cfg(windows)]
mod win;

use std::sync::{Arc, OnceLock};

use memry_desktop::shell::spell::SpellBackend;
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::CommandError;
use crate::startup::{self, Stage};

type Factory = Box<dyn Fn() -> Option<Arc<dyn SpellBackend>> + Send + Sync>;

/// The platform backend, or none when the platform has no dictionary. The backend is built on
/// first use, which is always on the blocking pool: the Windows one waits up to five seconds for
/// COM and the dictionary, and boot must not.
pub struct SpellService {
    backend: OnceLock<Option<Arc<dyn SpellBackend>>>,
    make: Factory,
}

/// Removes a word a spec added to the personal dictionary (macOS only: the other backends keep
/// theirs in the throwaway profile of the runner).
#[cfg(all(target_os = "macos", feature = "e2e"))]
pub fn unlearn(app: &AppHandle<Wry>, word: &str) {
    mac::unlearn(app, word);
}

impl SpellService {
    fn lazy(make: Factory) -> Self {
        Self {
            backend: OnceLock::new(),
            make,
        }
    }

    /// Builds the backend on the first call; every later call reuses it.
    pub fn backend(&self) -> Option<Arc<dyn SpellBackend>> {
        self.backend
            .get_or_init(|| {
                let backend = (self.make)();
                if backend.is_none() {
                    tracing::warn!(
                        scope = "Spell",
                        "no spell checker is available; suggestions are off"
                    );
                }
                backend
            })
            .clone()
    }
}

pub fn register_stages() {
    startup::register(Stage::Handlers, "register spell checker", register);
}

fn register(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    #[cfg(target_os = "macos")]
    let make: Factory = {
        let app = app.clone();
        Box::new(move || Some(Arc::new(mac::MacSpell::new(app.clone())) as _))
    };
    #[cfg(target_os = "linux")]
    let make: Factory = Box::new(|| linux::Enchant::load().map(|e| Arc::new(e) as _));
    #[cfg(windows)]
    let make: Factory = Box::new(|| win::WinSpell::start().map(|w| Arc::new(w) as _));
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    let make: Factory = Box::new(|| None);
    app.manage(SpellService::lazy(make));
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    struct Fake;
    impl SpellBackend for Fake {
        fn check(&self, _: &str) -> bool {
            true
        }
        fn suggest(&self, _: &str, _: usize) -> Vec<String> {
            Vec::new()
        }
        fn add(&self, _: &str) -> bool {
            true
        }
    }

    #[test]
    fn the_backend_is_not_built_until_first_used_and_then_only_once() {
        let built = Arc::new(AtomicUsize::new(0));
        let counter = built.clone();
        let service = SpellService::lazy(Box::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Some(Arc::new(Fake) as _)
        }));
        assert_eq!(built.load(Ordering::SeqCst), 0);
        assert!(service.backend().is_some());
        assert!(service.backend().is_some());
        assert_eq!(built.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_platform_with_no_dictionary_stays_without_one() {
        let built = Arc::new(AtomicUsize::new(0));
        let counter = built.clone();
        let service = SpellService::lazy(Box::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            None
        }));
        assert!(service.backend().is_none());
        assert!(service.backend().is_none());
        assert_eq!(built.load(Ordering::SeqCst), 1);
    }
}
