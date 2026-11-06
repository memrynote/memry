//! The fold's text helpers reproduce `packages/contracts/test-vectors/note-fold-text.json`,
//! which Electron's fold engine generates (`apps/desktop/scripts/note-fold-oracle/`):
//! the language a text reads as, its sentences, word and token counts and whether it folds,
//! and every date and link pill as the text a reader sees, in each language tag the engine
//! answers.
//!
//! One count differs by design: the words of a script ICU splits with a dictionary, in a text
//! counted by words (not Chinese, Japanese or Korean). `unicode-segmentation` (UAX #29) has no
//! dictionary: a Han, Hiragana, Thai, Lao, Khmer or Myanmar run is one word per character, at
//! least as many as ICU's dictionary words, and a Katakana run is one word, at most as many.
//! Such a case checks everything else exactly and its count against that bound.

use memry_desktop::fold::text::{
    count_words, detect_language, estimate_tokens, is_cjk, is_foldable, split_sentences,
};
use memry_desktop::fold::tokens::{Zone, expand_inline_tokens, without_inline_tokens};
use serde_json::{Value, json};

/// Where UAX #29 and ICU's dictionary part ways on a count.
#[derive(Debug, PartialEq)]
enum Dictionary {
    /// One word per character here: never fewer than ICU's.
    PerCharacter,
    /// One word per run here: never more than ICU's.
    PerRun,
}

fn dictionary(input: &str) -> Option<Dictionary> {
    let per_character = |c: char| {
        matches!(u32::from(c),
            0x3040..=0x309f // Hiragana
            | 0x3400..=0x4dbf | 0x4e00..=0x9fff // Han
            | 0x0e00..=0x0eff // Thai, Lao
            | 0x1000..=0x109f // Myanmar
            | 0x1780..=0x17ff) // Khmer
    };
    let katakana = |c: char| matches!(u32::from(c), 0x30a0..=0x30ff | 0xff66..=0xff9f);
    if input.chars().any(per_character) {
        Some(Dictionary::PerCharacter)
    } else if input.chars().any(katakana) {
        Some(Dictionary::PerRun)
    } else {
        None
    }
}

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/contracts/test-vectors/note-fold-text.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("note-fold-text.json"))
        .expect("json")
}

fn cases<'a>(
    vectors: &'a Value,
    class: &str,
) -> impl Iterator<Item = (&'a str, &'a str, &'a str, &'a Value)> {
    vectors[class].as_array().expect(class).iter().map(|case| {
        let field = |name: &str| case[name].as_str().expect(name);
        (
            field("name"),
            field("input"),
            field("language"),
            &case["expected"],
        )
    })
}

#[test]
fn text_reads_as_the_electron_engine_reads_it() {
    let vectors = vectors();
    assert_eq!(vectors["timeZone"], "UTC");
    let (mut seen, mut bounded) = (0, 0);
    for (name, input, language, expected) in cases(&vectors, "text") {
        let mut actual = json!({
            "detected": detect_language(input),
            "sentences": split_sentences(input),
            "words": count_words(input, language),
            "tokens": estimate_tokens(input, language),
            "foldable": is_foldable(input, language),
        });
        if let Some(kind) = dictionary(input).filter(|_| !is_cjk(language)) {
            let (here, icu) = (actual["words"].as_u64(), expected["words"].as_u64());
            match kind {
                Dictionary::PerCharacter => assert!(here >= icu, "{name}: {here:?} < {icu:?}"),
                Dictionary::PerRun => assert!(here <= icu, "{name}: {here:?} > {icu:?}"),
            }
            for field in ["words", "tokens"] {
                actual[field] = expected[field].clone();
            }
            bounded += 1;
        }
        assert_eq!(&actual, expected, "{name}");
        seen += 1;
    }
    assert!(seen >= 40, "{seen} text cases");
    // Thai, Lao, Khmer, Myanmar, halfwidth Katakana, and the Hiragana and Han share cases.
    assert_eq!(bounded, 8, "the cases held to a bound");
}

#[test]
fn tokens_read_as_the_electron_engine_writes_them() {
    let vectors = vectors();
    let mut seen = 0;
    for (name, input, language, expected) in cases(&vectors, "tokens") {
        let actual = json!({
            "expanded": expand_inline_tokens(input, language, Zone::Utc),
            "blanked": without_inline_tokens(input),
        });
        assert_eq!(&actual, expected, "{name}");
        seen += 1;
    }
    assert!(seen >= 40, "{seen} token cases");
}
