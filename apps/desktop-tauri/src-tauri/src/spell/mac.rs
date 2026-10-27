//! `NSSpellChecker`, which AppKit wants on the main thread. A call hands its work there and waits
//! for the answer, so the commands that use it stay off the main thread.

use std::sync::OnceLock;
use std::sync::mpsc;
use std::time::Duration;

use memry_desktop::shell::spell::SpellBackend;
use objc2_app_kit::NSSpellChecker;
use objc2_foundation::{NSNotFound, NSRange, NSString};
use tauri::{AppHandle, Wry};

const MAIN_THREAD_WAIT: Duration = Duration::from_secs(5);

pub struct MacSpell {
    app: AppHandle<Wry>,
}

/// The document tag the checker keeps its per-document state under; one for the whole app.
static DOCUMENT_TAG: OnceLock<isize> = OnceLock::new();

fn checker() -> objc2::rc::Retained<NSSpellChecker> {
    // The checker's own language, the user's first spelling language. Not
    // `automaticallyIdentifiesLanguages`: guessing the language of a single word reads a typo
    // like "teh" as a word of some other language, and the user's whole preferred list includes
    // languages with no dictionary installed, which accept every word.
    let checker = NSSpellChecker::sharedSpellChecker();
    checker.setAutomaticallyIdentifiesLanguages(false);
    checker
}

fn tag() -> isize {
    *DOCUMENT_TAG.get_or_init(NSSpellChecker::uniqueSpellDocumentTag)
}

impl MacSpell {
    pub fn new(app: AppHandle<Wry>) -> Self {
        Self { app }
    }

    fn on_main<T: Send + 'static>(&self, work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
        let (tx, rx) = mpsc::channel();
        self.app
            .run_on_main_thread(move || {
                let _ = tx.send(work());
            })
            .ok()?;
        rx.recv_timeout(MAIN_THREAD_WAIT).ok()
    }
}

impl SpellBackend for MacSpell {
    fn check(&self, word: &str) -> bool {
        let word = word.to_owned();
        // A failed hop to the main thread reads as correct: no underline beats a false one.
        self.on_main(move || {
            let string = NSString::from_str(&word);
            // SAFETY: a null word count is allowed; the string outlives the call.
            let range = unsafe {
                checker().checkSpellingOfString_startingAt_language_wrap_inSpellDocumentWithTag_wordCount(
                    &string,
                    0,
                    None,
                    false,
                    tag(),
                    std::ptr::null_mut(),
                )
            };
            range.location == NSNotFound as usize
        })
        .unwrap_or(true)
    }

    fn suggest(&self, word: &str, max: usize) -> Vec<String> {
        let word = word.to_owned();
        self.on_main(move || {
            let string = NSString::from_str(&word);
            let range = NSRange::new(0, string.length());
            checker()
                .guessesForWordRange_inString_language_inSpellDocumentWithTag(
                    range,
                    &string,
                    None,
                    tag(),
                )
                .map(|guesses| {
                    guesses
                        .iter()
                        .take(max)
                        .map(|guess| guess.to_string())
                        .collect()
                })
                .unwrap_or_default()
        })
        .unwrap_or_default()
    }

    fn add(&self, word: &str) -> bool {
        let word = word.to_owned();
        self.on_main(move || {
            checker().learnWord(&NSString::from_str(&word));
            true
        })
        .unwrap_or(false)
    }
}

/// Removes a word a spec added, so a run leaves the developer's personal dictionary as it found
/// it.
#[cfg(feature = "e2e")]
pub fn unlearn(app: &AppHandle<Wry>, word: &str) {
    let word = word.to_owned();
    let _ = app.run_on_main_thread(move || {
        checker().unlearnWord(&NSString::from_str(&word));
    });
}
