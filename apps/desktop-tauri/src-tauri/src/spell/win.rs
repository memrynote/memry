//! The Windows spell checker (`ISpellChecker`). COM objects live on the thread that made them,
//! so one thread owns the checker and every call is a message to it.

use std::sync::Mutex;
use std::sync::mpsc::{Sender, channel};
use std::time::Duration;

use memry_desktop::shell::spell::{SpellBackend, windows_language_candidates};
use windows::Win32::Globalization::{
    GetUserDefaultLocaleName, ISpellChecker, ISpellCheckerFactory, SpellCheckerFactory,
};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
    CoTaskMemFree, CoUninitialize,
};
use windows::core::{HSTRING, PWSTR};

const REPLY_WAIT: Duration = Duration::from_secs(5);
const LOCALE_NAME_MAX_LENGTH: usize = 85;

enum Request {
    Check(String, Sender<bool>),
    Suggest(String, usize, Sender<Vec<String>>),
    Add(String, Sender<bool>),
}

pub struct WinSpell {
    requests: Mutex<Sender<Request>>,
}

impl WinSpell {
    /// Starts the checker thread; `None` when Windows has no spell checker for the user's
    /// language, its language alone, or `en-US`.
    pub fn start() -> Option<Self> {
        let (requests, inbox) = channel::<Request>();
        let (ready_tx, ready_rx) = channel::<bool>();
        std::thread::Builder::new()
            .name("spell-checker".to_owned())
            .spawn(move || {
                // SAFETY: balanced with `CoUninitialize` below; this thread owns the COM state.
                if unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_err() {
                    let _ = ready_tx.send(false);
                    return;
                }
                let checker = create_checker();
                let _ = ready_tx.send(checker.is_some());
                if let Some(checker) = checker {
                    serve(&checker, &inbox);
                }
                // SAFETY: pairs the successful `CoInitializeEx` above.
                unsafe { CoUninitialize() };
            })
            .ok()?;
        ready_rx
            .recv_timeout(REPLY_WAIT)
            .ok()
            .filter(|ready| *ready)
            .map(|_| Self {
                requests: Mutex::new(requests),
            })
    }

    fn ask<T>(&self, build: impl FnOnce(Sender<T>) -> Request) -> Option<T> {
        let (reply, answer) = channel();
        self.requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .send(build(reply))
            .ok()?;
        answer.recv_timeout(REPLY_WAIT).ok()
    }
}

fn user_locale() -> String {
    let mut buffer = [0u16; LOCALE_NAME_MAX_LENGTH];
    // SAFETY: the buffer is the length Windows documents for a locale name.
    let length = unsafe { GetUserDefaultLocaleName(&mut buffer) };
    let length = usize::try_from(length).unwrap_or(0).saturating_sub(1);
    String::from_utf16_lossy(&buffer[..length.min(LOCALE_NAME_MAX_LENGTH)])
}

fn create_checker() -> Option<ISpellChecker> {
    // SAFETY: COM is initialized on this thread.
    let factory: ISpellCheckerFactory =
        unsafe { CoCreateInstance(&SpellCheckerFactory, None, CLSCTX_INPROC_SERVER) }.ok()?;
    for tag in windows_language_candidates(&user_locale()) {
        let tag = HSTRING::from(tag);
        // SAFETY: `factory` is live and `tag` is a valid wide string.
        let supported = unsafe { factory.IsSupported(&tag) }
            .map(|value| value.as_bool())
            .unwrap_or(false);
        if supported && let Ok(checker) = unsafe { factory.CreateSpellChecker(&tag) } {
            tracing::info!(scope = "Spell", "Windows spell checker for {tag}");
            return Some(checker);
        }
    }
    None
}

fn serve(checker: &ISpellChecker, inbox: &std::sync::mpsc::Receiver<Request>) {
    for request in inbox {
        match request {
            Request::Check(word, reply) => {
                let _ = reply.send(is_correct(checker, &word));
            }
            Request::Suggest(word, max, reply) => {
                let _ = reply.send(suggestions(checker, &word, max));
            }
            Request::Add(word, reply) => {
                let word = HSTRING::from(word);
                // SAFETY: `checker` is live and `word` is a valid wide string.
                let _ = reply.send(unsafe { checker.Add(&word) }.is_ok());
            }
        }
    }
}

fn is_correct(checker: &ISpellChecker, word: &str) -> bool {
    let word = HSTRING::from(word);
    // SAFETY: `checker` is live and `word` is a valid wide string.
    let Ok(errors) = (unsafe { checker.Check(&word) }) else {
        return true;
    };
    // The enumeration yields one error per misspelled range; none means the text is correct.
    let mut first = None;
    // SAFETY: `errors` is the live enumeration just returned; `first` is a valid out slot. The
    // call succeeds with S_FALSE and no error at the end of the enumeration.
    let status = unsafe { errors.Next(&mut first) };
    status.is_err() || first.is_none()
}

fn suggestions(checker: &ISpellChecker, word: &str, max: usize) -> Vec<String> {
    let word = HSTRING::from(word);
    // SAFETY: `checker` is live and `word` is a valid wide string.
    let Ok(list) = (unsafe { checker.Suggest(&word) }) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    while found.len() < max {
        let mut item = [PWSTR::null()];
        let mut fetched = 0u32;
        // SAFETY: `item` has room for the one string asked for; the string is COM-allocated.
        let status = unsafe { list.Next(&mut item, Some(&mut fetched)) };
        if status.is_err() || fetched == 0 || item[0].is_null() {
            break;
        }
        // SAFETY: a NUL-terminated string from `Next`, freed once with `CoTaskMemFree`.
        unsafe {
            if let Ok(text) = item[0].to_string() {
                found.push(text);
            }
            CoTaskMemFree(Some(item[0].0.cast()));
        }
    }
    found
}

impl SpellBackend for WinSpell {
    fn check(&self, word: &str) -> bool {
        self.ask(|reply| Request::Check(word.to_owned(), reply))
            .unwrap_or(true)
    }

    fn suggest(&self, word: &str, max: usize) -> Vec<String> {
        self.ask(|reply| Request::Suggest(word.to_owned(), max, reply))
            .unwrap_or_default()
    }

    fn add(&self, word: &str) -> bool {
        self.ask(|reply| Request::Add(word.to_owned(), reply))
            .unwrap_or(false)
    }
}
