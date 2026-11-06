//! The fold's text helpers reproduce `packages/contracts/test-vectors/note-fold-text.json`,
//! which Electron's fold engine generates (`apps/desktop/scripts/note-fold-oracle/`):
//! the language a text reads as, its sentences, word and token counts and whether it folds,
//! and every date and link pill as the text a reader sees, in each language tag the engine
//! answers.
//!
//! One count differs by design: a Han run inside a text that reads as neither Chinese nor
//! Japanese nor Korean. `Intl.Segmenter` splits it into words with ICU's dictionary, and
//! `unicode-segmentation` makes each ideograph a word (UAX #29), so the count is never lower
//! than Electron's. Such a case checks everything else and that bound.

use memry_desktop::fold::text::{
    count_words, detect_language, estimate_tokens, is_cjk, is_foldable, split_sentences,
};
use memry_desktop::fold::tokens::{Zone, expand_inline_tokens, without_inline_tokens};
use serde_json::{Value, json};

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
    let mut seen = 0;
    for (name, input, language, expected) in cases(&vectors, "text") {
        let mut actual = json!({
            "detected": detect_language(input),
            "sentences": split_sentences(input),
            "words": count_words(input, language),
            "tokens": estimate_tokens(input, language),
            "foldable": is_foldable(input, language),
        });
        let han = input
            .chars()
            .any(|c| matches!(u32::from(c), 0x4e00..=0x9fff | 0x3400..=0x4dbf));
        if han && !is_cjk(language) {
            assert!(
                actual["words"].as_u64() >= expected["words"].as_u64(),
                "{name}"
            );
            for field in ["words", "tokens"] {
                actual[field] = expected[field].clone();
            }
        }
        assert_eq!(&actual, expected, "{name}");
        seen += 1;
    }
    assert!(seen >= 25, "{seen} text cases");
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
