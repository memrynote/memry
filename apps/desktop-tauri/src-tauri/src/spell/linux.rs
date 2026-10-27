//! Enchant 2, loaded at run time so the app starts on machines without it (`available: false`).

use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::sync::Mutex;

use libloading::Library;
use memry_desktop::shell::spell::{SpellBackend, enchant_tag};

const LIBRARY_NAMES: [&str; 2] = ["libenchant-2.so.2", "libenchant-2.so"];

type BrokerInit = unsafe extern "C" fn() -> *mut c_void;
type BrokerFree = unsafe extern "C" fn(*mut c_void);
type DictExists = unsafe extern "C" fn(*mut c_void, *const c_char) -> c_int;
type RequestDict = unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void;
type FreeDict = unsafe extern "C" fn(*mut c_void, *mut c_void);
type DictCheck = unsafe extern "C" fn(*mut c_void, *const c_char, isize) -> c_int;
type DictSuggest =
    unsafe extern "C" fn(*mut c_void, *const c_char, isize, *mut usize) -> *mut *mut c_char;
type FreeStringList = unsafe extern "C" fn(*mut c_void, *mut *mut c_char);
type DictAdd = unsafe extern "C" fn(*mut c_void, *const c_char, isize);

/// Enchant is not thread-safe per dictionary, so every call holds the lock.
pub struct Enchant {
    inner: Mutex<Inner>,
}

struct Inner {
    // Held so the function pointers stay valid.
    _library: Library,
    broker: *mut c_void,
    dict: *mut c_void,
    broker_free: BrokerFree,
    free_dict: FreeDict,
    check: DictCheck,
    suggest: DictSuggest,
    free_list: FreeStringList,
    add: DictAdd,
}

// SAFETY: the raw pointers are only touched under the `Mutex` in `Enchant`.
unsafe impl Send for Inner {}

impl Enchant {
    /// The first Enchant library that loads and has a dictionary for the user's language, or
    /// `None`.
    pub fn load() -> Option<Self> {
        let library = LIBRARY_NAMES.iter().find_map(|name| {
            // SAFETY: loading a shared library runs its initializers; Enchant's are plain.
            unsafe { Library::new(*name) }.ok()
        });
        let Some(library) = library else {
            tracing::info!(
                scope = "Spell",
                "libenchant-2 is not installed; spelling suggestions are off"
            );
            return None;
        };
        match Inner::open(library) {
            Ok(inner) => Some(Self {
                inner: Mutex::new(inner),
            }),
            Err(reason) => {
                tracing::warn!(scope = "Spell", "Enchant is unusable: {reason}");
                None
            }
        }
    }
}

impl Inner {
    fn open(library: Library) -> Result<Self, String> {
        macro_rules! symbol {
            ($name:literal, $type:ty) => {
                // SAFETY: the declared signature is Enchant 2's C API for this symbol.
                *unsafe { library.get::<$type>($name) }
                    .map_err(|error| format!("{}: {error}", String::from_utf8_lossy($name)))?
            };
        }
        let broker_init: BrokerInit = symbol!(b"enchant_broker_init\0", BrokerInit);
        let broker_free: BrokerFree = symbol!(b"enchant_broker_free\0", BrokerFree);
        let dict_exists: DictExists = symbol!(b"enchant_broker_dict_exists\0", DictExists);
        let request_dict: RequestDict = symbol!(b"enchant_broker_request_dict\0", RequestDict);
        let free_dict: FreeDict = symbol!(b"enchant_broker_free_dict\0", FreeDict);
        let check: DictCheck = symbol!(b"enchant_dict_check\0", DictCheck);
        let suggest: DictSuggest = symbol!(b"enchant_dict_suggest\0", DictSuggest);
        let free_list: FreeStringList = symbol!(b"enchant_dict_free_string_list\0", FreeStringList);
        let add: DictAdd = symbol!(b"enchant_dict_add\0", DictAdd);

        let var = |name: &str| std::env::var(name).ok();
        let tag = enchant_tag(
            var("LC_ALL").as_deref(),
            var("LC_MESSAGES").as_deref(),
            var("LANG").as_deref(),
        );
        // SAFETY: the broker is freed on every path out of this function that does not keep it.
        let broker = unsafe { broker_init() };
        if broker.is_null() {
            return Err("enchant_broker_init returned null".to_owned());
        }
        let tag_c = CString::new(tag.as_str()).map_err(|error| error.to_string())?;
        let fallback = CString::new("en_US").map_err(|error| error.to_string())?;
        // SAFETY: `broker` is live and the tags are NUL-terminated.
        let chosen = unsafe {
            if dict_exists(broker, tag_c.as_ptr()) != 0 {
                Some(tag_c)
            } else if dict_exists(broker, fallback.as_ptr()) != 0 {
                Some(fallback)
            } else {
                None
            }
        };
        let Some(chosen) = chosen else {
            // SAFETY: `broker` came from `broker_init` and is not used again.
            unsafe { broker_free(broker) };
            return Err(format!("no dictionary for {tag} or en_US"));
        };
        // SAFETY: `broker` is live and `chosen` is NUL-terminated.
        let dict = unsafe { request_dict(broker, chosen.as_ptr()) };
        if dict.is_null() {
            // SAFETY: as above.
            unsafe { broker_free(broker) };
            return Err("enchant_broker_request_dict returned null".to_owned());
        }
        Ok(Self {
            _library: library,
            broker,
            dict,
            broker_free,
            free_dict,
            check,
            suggest,
            free_list,
            add,
        })
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        // SAFETY: the dictionary and the broker are ours and are released once, dictionary first.
        unsafe {
            (self.free_dict)(self.broker, self.dict);
            (self.broker_free)(self.broker);
        }
    }
}

impl Enchant {
    fn with<T>(&self, work: impl FnOnce(&Inner) -> T) -> T {
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        work(&guard)
    }
}

impl SpellBackend for Enchant {
    fn check(&self, word: &str) -> bool {
        let Ok(word_c) = CString::new(word) else {
            return true;
        };
        // SAFETY: `dict` is live under the lock; the length is the byte length.
        self.with(|inner| unsafe {
            (inner.check)(inner.dict, word_c.as_ptr(), word.len() as isize) == 0
        })
    }

    fn suggest(&self, word: &str, max: usize) -> Vec<String> {
        let Ok(word_c) = CString::new(word) else {
            return Vec::new();
        };
        self.with(|inner| {
            let mut count: usize = 0;
            // SAFETY: `dict` is live; `count` is a valid out pointer.
            let list = unsafe {
                (inner.suggest)(inner.dict, word_c.as_ptr(), word.len() as isize, &mut count)
            };
            if list.is_null() {
                return Vec::new();
            }
            let suggestions = (0..count.min(max))
                .filter_map(|index| {
                    // SAFETY: Enchant returned `count` NUL-terminated strings.
                    let item = unsafe { *list.add(index) };
                    (!item.is_null()).then(|| {
                        unsafe { CStr::from_ptr(item) }
                            .to_string_lossy()
                            .into_owned()
                    })
                })
                .collect();
            // SAFETY: `list` came from `suggest` on this dictionary and is released once.
            unsafe { (inner.free_list)(inner.dict, list) };
            suggestions
        })
    }

    fn add(&self, word: &str) -> bool {
        let Ok(word_c) = CString::new(word) else {
            return false;
        };
        // SAFETY: `dict` is live under the lock.
        self.with(|inner| unsafe {
            (inner.add)(inner.dict, word_c.as_ptr(), word.len() as isize);
        });
        true
    }
}
