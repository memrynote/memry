//! The note fold reads vault files, which another device or another app may have written, so
//! it holds the untrusted-input guards: no recursion a deep note can overflow, the hand-written
//! scans linear in the input (counted in steps, never timed), the text it returns within the
//! kit's bound, and properties over arbitrary Markdown.
//!
//! The emphasis pass is a scan of its own because the `regex` crate has no lookahead: a run
//! can only close at the first `*` or `_` after it. A port that looked further for a closing
//! mark the lookahead accepts would rescan the rest of the note from every opener, which the
//! hostile inputs below turn into quadratic work.

use memry_desktop::fold::FoldLayers;
use memry_desktop::fold::engine::{assemble, prepare};
use memry_desktop::fold::morph::{MAX_LINE_TOKENS, MorphLines, build_morph};
use memry_desktop::fold::text::steps;
use memry_desktop::fold::tokens::Zone;
use memry_test_kit::{
    assert_output_bounded, assert_steps_at_most, on_small_stack, output_bound, proptest_config,
};
use proptest::prelude::*;

fn fold(markdown: &str) -> FoldLayers {
    let prepared = prepare(markdown, Zone::Utc);
    assemble("n", &prepared, |_| None).layers
}

/// Bytes of every string the snapshot carries for its reader.
fn text_bytes(layers: &FoldLayers) -> usize {
    let strings = |items: &[String]| items.iter().map(String::len).sum::<usize>();
    layers
        .sections
        .iter()
        .map(|s| {
            s.heading.as_ref().map_or(0, String::len)
                + s.paragraphs
                    .iter()
                    .map(|p| {
                        p.text.len()
                            + strings(&p.sentences)
                            + strings(&p.sentences_md)
                            + strings(&p.src_tokens)
                            + p.takeaway.len()
                            + p.topic.len()
                            + [&p.morph.takeaway, &p.morph.topic]
                                .into_iter()
                                .flatten()
                                .flatten()
                                .map(|t| t.text.len())
                                .sum::<usize>()
                    })
                    .sum::<usize>()
        })
        .sum()
}

/// The scans visit each byte a few times; with no model lines, the two fallback line maps of a
/// paragraph (Takeaway, Topic) cost at most [`MAX_LINE_TOKENS`] steps per source segment each.
fn linear_bound(len: usize) -> usize {
    (8 + 2 * MAX_LINE_TOKENS) * len + 1000
}

fn assert_linear(what: &'static str, input: String) {
    let bound = linear_bound(input.len());
    on_small_stack(move || {
        assert_steps_at_most(what, steps, bound, || {
            let layers = fold(&input);
            assert!(!layers.sections.is_empty(), "{what} must reach the scans");
        });
    });
}

const REPEATS: usize = 20_000;

#[test]
fn openers_that_never_close_are_linear() {
    // Every ` *` opens a run that closes at the next `*`, which the lookahead refuses.
    assert_linear(
        "unclosed emphasis",
        format!("word{}", " *a".repeat(REPEATS)),
    );
}

#[test]
fn openers_before_one_far_closing_mark_are_linear() {
    assert_linear("far close", format!("{} a* end", " _w x".repeat(REPEATS)));
}

#[test]
fn many_sentences_in_one_paragraph_are_linear() {
    assert_linear("sentences", "Go **now**. ".repeat(REPEATS));
}

#[test]
fn a_deeply_nested_note_folds_on_a_small_stack() {
    let quotes = format!("{} text\n", ">".repeat(200_000));
    let lists = (0..20_000)
        .map(|depth| format!("{}- item {depth}\n", "  ".repeat(depth % 500)))
        .collect::<String>();
    let brackets = format!("{}x{}", "[".repeat(100_000), "](u)".repeat(100_000));
    for input in [quotes, lists, brackets] {
        let words = format!("{input}\n\n{}", "word ".repeat(200));
        let layers = on_small_stack(move || fold(&words));
        assert!(!layers.sections.is_empty());
    }
}

/// A model line is model output: a long one over a long paragraph would fill a quadratic table.
/// Past `MAX_LCS_CELLS` the line is not mapped, so the work stays linear in the text.
#[test]
fn a_long_model_line_over_a_long_paragraph_is_not_mapped() {
    let words = |n: usize| (0..n).map(|i| format!("w{i} ")).collect::<String>();
    let (text, line) = (words(3_000), words(3_000));
    let sentences = vec![text.trim_end().to_owned()];
    let bound = 8 * (text.len() + line.len()) + 1000;
    let mut morph = None;
    assert_steps_at_most("model line map", steps, bound, || {
        morph = Some(build_morph(
            &text,
            &sentences,
            &MorphLines {
                key_takeaway: None,
                key_reason: None,
                takeaway: Some(&line),
                topic: None,
                fallback: false,
            },
            "en",
        ));
    });
    let mapped = morph
        .expect("the map")
        .morph
        .takeaway
        .expect("the line's tokens");
    assert!(
        mapped.iter().all(|t| t.src.is_none()),
        "nothing is mapped past the cap"
    );
}

/// A paragraph with no spaces is one long fallback line (its first 12 whitespace-split words):
/// mapped, it would cost as many steps as segments squared, just under `MAX_LCS_CELLS` here.
#[test]
fn a_paragraph_without_spaces_maps_in_linear_work() {
    let paragraph = "a-".repeat(940);
    let input = format!("{paragraph}a.\n\n").repeat(20);
    assert_linear("paragraphs without spaces", input);
}

#[test]
fn a_large_note_returns_text_within_the_bound() {
    let input = "A sentence with **bold** and `code`. Another one *here*.\n\n".repeat(5_000);
    let layers = on_small_stack({
        let input = input.clone();
        move || fold(&input)
    });
    assert_output_bounded("fold text", input.len(), text_bytes(&layers));
}

const PIECES: &[&str] = &[
    "word ",
    "Wörd ",
    "İş ",
    "語",
    "。",
    "！",
    "？",
    ". ",
    "? ",
    "! ",
    "… ",
    "\n",
    "\n\n",
    "\r\n",
    "# ",
    "## ",
    "- ",
    "1. ",
    "- [ ] ",
    "> ",
    "> [!note] ",
    "```",
    "~~~",
    "| a |",
    "![i](u)",
    "![[e]]",
    "<div>",
    "</b>",
    "**",
    "__",
    "~~",
    "`",
    "*",
    "_",
    "[",
    "]",
    "(",
    ")",
    "[[",
    "]]",
    "|",
    "\\",
    "\u{A0}",
    "\u{3000}",
    "\u{FEFF}",
    "\t",
    "3.5",
    "Dr. ",
    "\u{1F600}",
    "e\u{301}",
    "((date:",
    "((mention:",
    "))",
    "eyJhIjoxfQ",
    "---\n",
];

fn soup() -> impl Strategy<Value = String> {
    prop::collection::vec(prop::sample::select(PIECES), 0..160).prop_map(|pieces| pieces.concat())
}

proptest! {
    #![proptest_config(proptest_config(512))]

    #[test]
    fn any_markdown_folds_into_a_snapshot_that_holds_together(body in soup()) {
        // Past the threshold, and first, since an open fence hides the rest of the note: every
        // case reaches sections, sentences and the Brief.
        let input = format!("{}\n\n{body}", "word ".repeat(160));
        let before = steps();
        let layers = fold(&input);
        prop_assert!(steps() - before <= linear_bound(input.len()));
        prop_assert!(!layers.sections.is_empty());
        prop_assert!(text_bytes(&layers) <= output_bound(input.len()));
        for p in layers.sections.iter().flat_map(|s| &s.paragraphs) {
            prop_assert_eq!(p.src_tokens.concat(), p.text.clone());
            prop_assert_eq!(p.sentences_md.len(), p.sentences.len());
            prop_assert_eq!(p.src_sentence_start.len(), p.sentences.len());
            prop_assert!(p.brief_idx.iter().all(|&i| (i as usize) < p.sentences.len()));
            let mut cursor = 0;
            for sentence in &p.sentences {
                let at = p.text[cursor..].find(sentence.as_str());
                prop_assert!(at.is_some(), "sentence {:?} not in {:?}", sentence, p.text);
                cursor += at.unwrap_or(0) + sentence.len();
            }
        }
    }
}
