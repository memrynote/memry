//! Spelling suggestions and the personal dictionary. The system web views underline
//! misspellings through the `spellcheck` attribute; suggestions and the dictionary come from the
//! platform backend behind [`SpellBackend`] (`apps/desktop-tauri/src-tauri/src/spell`). The input
//! rules are `AddWordToDictionaryInputSchema` (`packages/contracts/src/writing-tools-api.ts`).

use serde::Serialize;

/// Suggestions shown for one word.
pub const MAX_SUGGESTIONS: usize = 8;

/// The longest word the dictionary takes, in characters.
pub const MAX_WORD_CHARS: usize = 100;

/// A platform spell checker.
pub trait SpellBackend: Send + Sync {
    /// Whether `word` is spelled correctly.
    fn check(&self, word: &str) -> bool;
    /// Up to `max` replacements for a misspelled `word`, best first.
    fn suggest(&self, word: &str, max: usize) -> Vec<String>;
    /// Adds `word` to the personal dictionary; false when the backend refused.
    fn add(&self, word: &str) -> bool;
}

/// What the page needs to build its menu.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SpellResult {
    /// False when no dictionary could be loaded (Enchant missing on Linux): the page shows no
    /// suggestions and no dictionary entry.
    pub available: bool,
    pub misspelled: bool,
    pub suggestions: Vec<String>,
}

impl SpellResult {
    const UNAVAILABLE: Self = Self {
        available: false,
        misspelled: false,
        suggestions: Vec::new(),
    };
}

/// `word` trimmed, or `None` when it is empty or longer than [`MAX_WORD_CHARS`].
pub fn normalize_word(word: &str) -> Option<&str> {
    let word = word.trim();
    let length = word.chars().count();
    (1..=MAX_WORD_CHARS).contains(&length).then_some(word)
}

pub fn check_word(backend: Option<&dyn SpellBackend>, word: &str) -> SpellResult {
    let Some(backend) = backend else {
        return SpellResult::UNAVAILABLE;
    };
    let Some(word) = normalize_word(word) else {
        return SpellResult {
            available: true,
            misspelled: false,
            suggestions: Vec::new(),
        };
    };
    if backend.check(word) {
        return SpellResult {
            available: true,
            misspelled: false,
            suggestions: Vec::new(),
        };
    }
    let mut suggestions = backend.suggest(word, MAX_SUGGESTIONS);
    suggestions.truncate(MAX_SUGGESTIONS);
    SpellResult {
        available: true,
        misspelled: true,
        suggestions,
    }
}

pub fn add_word(backend: Option<&dyn SpellBackend>, word: &str) -> bool {
    match (backend, normalize_word(word)) {
        (Some(backend), Some(word)) => backend.add(word),
        _ => false,
    }
}

/// Adds each valid word and returns how many the backend took.
pub fn add_words(backend: Option<&dyn SpellBackend>, words: &[String]) -> u32 {
    let taken = words.iter().filter(|word| add_word(backend, word)).count();
    u32::try_from(taken).unwrap_or(u32::MAX)
}

/// The locale Enchant is asked for: the first of `LC_ALL`, `LC_MESSAGES` and `LANG` that is set
/// and is not the `C` locale, without its encoding (`en_US.UTF-8` is `en_US`).
pub fn enchant_tag(lc_all: Option<&str>, lc_messages: Option<&str>, lang: Option<&str>) -> String {
    [lc_all, lc_messages, lang]
        .into_iter()
        .flatten()
        .map(|value| value.split(['.', '@']).next().unwrap_or(""))
        .find(|value| !value.is_empty() && *value != "C" && *value != "POSIX")
        .unwrap_or("en_US")
        .to_owned()
}

/// Language tags tried in order for the Windows spell checker: the user's locale (`en-GB`), its
/// language alone (`en`), then `en-US`.
pub fn windows_language_candidates(user_locale: &str) -> Vec<String> {
    let mut tags = vec![user_locale.to_owned()];
    if let Some((language, _)) = user_locale.split_once('-') {
        tags.push(language.to_owned());
    }
    tags.push("en-US".to_owned());
    tags.dedup();
    let mut unique: Vec<String> = Vec::new();
    for tag in tags {
        if !tag.is_empty() && !unique.contains(&tag) {
            unique.push(tag);
        }
    }
    unique
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// A dictionary of known words with a few canned corrections.
    struct Fake {
        added: Mutex<Vec<String>>,
    }

    impl SpellBackend for Fake {
        fn check(&self, word: &str) -> bool {
            matches!(word, "the" | "hello") || self.added.lock().unwrap().iter().any(|w| w == word)
        }
        fn suggest(&self, word: &str, max: usize) -> Vec<String> {
            let all: Vec<String> = if word == "teh" {
                (0..20).map(|n| format!("the{n}")).collect()
            } else {
                Vec::new()
            };
            all.into_iter().take(max).collect()
        }
        fn add(&self, word: &str) -> bool {
            self.added.lock().unwrap().push(word.to_owned());
            true
        }
    }

    fn fake() -> Fake {
        Fake {
            added: Mutex::new(Vec::new()),
        }
    }

    #[test]
    fn a_misspelled_word_comes_back_with_at_most_eight_suggestions() {
        let backend = fake();
        let result = check_word(Some(&backend), "  teh ");
        assert!(result.available && result.misspelled);
        assert_eq!(result.suggestions.len(), MAX_SUGGESTIONS);
        assert_eq!(result.suggestions[0], "the0");
    }

    #[test]
    fn a_correct_word_has_no_suggestions() {
        let backend = fake();
        assert_eq!(
            check_word(Some(&backend), "hello"),
            SpellResult {
                available: true,
                misspelled: false,
                suggestions: vec![]
            }
        );
    }

    #[test]
    fn no_backend_reads_unavailable_and_never_misspelled() {
        let result = check_word(None, "teh");
        assert!(!result.available && !result.misspelled);
        assert!(!add_word(None, "teh"));
    }

    #[test]
    fn an_empty_or_overlong_word_is_not_checked() {
        let backend = fake();
        assert!(!check_word(Some(&backend), "   ").misspelled);
        assert!(!check_word(Some(&backend), &"a".repeat(MAX_WORD_CHARS + 1)).misspelled);
        assert!(!add_word(Some(&backend), ""));
        assert!(!add_word(Some(&backend), &"a".repeat(MAX_WORD_CHARS + 1)));
        assert!(add_word(Some(&backend), &"a".repeat(MAX_WORD_CHARS)));
    }

    #[test]
    fn the_limit_counts_characters_not_bytes() {
        assert!(normalize_word(&"é".repeat(MAX_WORD_CHARS)).is_some());
        assert!(normalize_word(&"é".repeat(MAX_WORD_CHARS + 1)).is_none());
    }

    #[test]
    fn an_added_word_stops_being_misspelled() {
        let backend = fake();
        assert!(check_word(Some(&backend), "teh").misspelled);
        assert!(add_word(Some(&backend), "teh"));
        assert!(!check_word(Some(&backend), "teh").misspelled);
    }

    #[test]
    fn add_words_counts_only_the_words_the_backend_took() {
        let backend = fake();
        let words = ["alpha".to_owned(), " ".to_owned(), "beta".to_owned()];
        assert_eq!(add_words(Some(&backend), &words), 2);
        assert_eq!(add_words(None, &words), 0);
    }

    #[test]
    fn the_enchant_tag_skips_the_c_locale_and_drops_the_encoding() {
        assert_eq!(enchant_tag(None, None, Some("en_GB.UTF-8")), "en_GB");
        assert_eq!(
            enchant_tag(Some("de_DE@euro"), None, Some("en_US.UTF-8")),
            "de_DE"
        );
        assert_eq!(
            enchant_tag(Some("C"), Some("POSIX"), Some("fr_FR.UTF-8")),
            "fr_FR"
        );
        assert_eq!(enchant_tag(Some(""), None, None), "en_US");
        assert_eq!(enchant_tag(Some("C.UTF-8"), None, None), "en_US");
    }

    #[test]
    fn windows_tries_the_locale_then_its_language_then_english() {
        assert_eq!(
            windows_language_candidates("en-GB"),
            ["en-GB", "en", "en-US"]
        );
        assert_eq!(windows_language_candidates("en-US"), ["en-US", "en"]);
        assert_eq!(windows_language_candidates("tr"), ["tr", "en-US"]);
    }
}
