//! Untrusted-input guards of the Readwise planners (`memry_desktop::readwise`): Readwise payloads
//! and note bodies are peer and vault data. Depth on a 2 MiB thread, linear step counts, output
//! bounds, and properties of the section reader and its damaged-marker rules.

use memry_desktop::readwise::highlights::LinkedIds;
use memry_desktop::readwise::journal::{
    JournalBook, JournalWrite, plan_journal_write, read_day_section,
};
use memry_desktop::readwise::plan_append::{PlanAppendOptions, plan_append};
use memry_desktop::readwise::plan_note::{BookPlan, PlanNoteOptions, plan_note};
use memry_desktop::readwise::planner_steps;
use memry_desktop::readwise::section::{
    SECTION_START, SectionProblem, SectionRead, hash_section_body, read_section, seal_section,
};
use memry_desktop::readwise::text::escape_paragraphs;
use memry_desktop::readwise::types::{
    CategorySwitches, FolderLayout, ReadwiseBook, ReadwiseHighlight, SavedImages,
};
use memry_test_kit::{
    assert_output_bounded, assert_steps_at_most, on_small_stack, output_bound, proptest_config,
};
use proptest::prelude::*;

const END: &str = "<!-- readwise:end v1 last=2026-10-22T18:05:00.001Z hash=0badf00d -->";

fn highlight(id: i64, text: String) -> ReadwiseHighlight {
    ReadwiseHighlight {
        id,
        text: Some(text),
        location: Some(id as f64),
        created_at: Some("2026-10-22T18:05:00Z".into()),
        ..Default::default()
    }
}

fn plan(book: &ReadwiseBook) -> String {
    let images = SavedImages::new();
    let options = PlanNoteOptions {
        root: "Readwise",
        folder_layout: FolderLayout::ByCategory,
        categories: CategorySwitches::default(),
        time_zone: chrono_tz::UTC,
        images: &images,
    };
    match plan_note(book, &options).expect("plan") {
        BookPlan::Note(note) => note.section,
        other => panic!("not a note: {other:?}"),
    }
}

/// The planners hold no recursion: a megabyte of nesting-shaped text in a highlight and in a
/// note body plans on a 2 MiB thread.
#[test]
fn nesting_shaped_input_plans_on_a_small_stack() {
    on_small_stack(|| {
        let shapes = [
            "[[".repeat(500_000),
            "> ".repeat(500_000),
            "<a".repeat(500_000),
        ];
        for (id, text) in shapes.into_iter().enumerate() {
            let book = ReadwiseBook {
                user_book_id: 1,
                highlights: Some(vec![highlight(id as i64, text)]),
                ..Default::default()
            };
            assert!(plan(&book).starts_with(SECTION_START));
        }
        let body = format!("{SECTION_START}\n").repeat(200_000);
        assert!(matches!(
            read_section(&body),
            SectionRead::Missing {
                problem: SectionProblem::DuplicateMarkers,
                ..
            }
        ));
    });
}

/// TypeScript dedupes image URLs with `imageUrls.includes`, quadratic in the image count; the
/// port dedupes through a set.
#[test]
fn image_urls_dedupe_in_linear_steps() {
    let n = 20_000;
    let book = ReadwiseBook {
        user_book_id: 1,
        cover_image_url: Some("https://cdn.example.com/cover.png".into()),
        highlights: Some(
            (0..n)
                .map(|i| highlight(i, format!("![](https://cdn.example.com/{i}.png)")))
                .collect(),
        ),
        ..Default::default()
    };
    // One step per URL (cover included) and one per rendered highlight.
    assert_steps_at_most(
        "plan_note image urls",
        planner_steps,
        2 * n as usize + 10,
        || {
            plan(&book);
        },
    );
}

/// Each highlight is looked up in the note's linked ids twice: a set, not a scan.
#[test]
fn linked_ids_are_looked_up_in_linear_steps() {
    let n = 20_000;
    let highlights: Vec<_> = (0..n).map(|i| highlight(i, format!("h{i}"))).collect();
    let linked = LinkedIds::from_ids(0..n);
    let images = SavedImages::new();
    let options = PlanAppendOptions {
        last: Some("2026-10-22T00:00:00.000Z"),
        note_created: "2026-10-21T00:00:00.000Z",
        linked_ids: &linked,
        time_zone: chrono_tz::UTC,
        images: &images,
    };
    assert_steps_at_most(
        "plan_append linked ids",
        planner_steps,
        3 * n as usize + 10,
        || {
            assert_eq!(plan_append(&highlights, &options).unwrap().markdown, "");
        },
    );
}

#[test]
fn section_reading_visits_each_line_once() {
    let lines = 100_000;
    let body = format!("{SECTION_START}\n{}{END}", "- a line\n".repeat(lines));
    assert_steps_at_most("read_section lines", planner_steps, lines + 10, || {
        assert!(matches!(read_section(&body), SectionRead::Found { .. }));
    });
}

#[test]
fn escaping_stays_within_the_output_bound() {
    for unit in ["[[", "<a", "#a ", "[ ]", "![", "- ", "1. "] {
        let text = unit.repeat(10_000);
        assert_output_bounded(unit, text.len(), escape_paragraphs(&text).len());
    }
}

/// A line of a note body, weighted toward markers and their damaged forms.
fn marker_line() -> impl Strategy<Value = String> {
    prop_oneof![
        Just(SECTION_START.to_string()),
        Just(format!("  {SECTION_START}\r")),
        Just(END.to_string()),
        Just("<!-- readwise:end v2 last=x hash=0 -->".to_string()),
        Just("<!-- readwise:end v1 last=x hash=XYZ -->".to_string()),
        Just("text <!-- readwise:start".to_string()),
        Just("<!-- readwise-day:start -->".to_string()),
        Just("<!-- readwise-day:end v1 hash=0 -->".to_string()),
        Just(String::new()),
        "[ -~\u{a0}\u{1F600}\r\t]{0,12}",
    ]
}

fn exact(line: &str, marker: &str) -> bool {
    line.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}') == marker
}

proptest! {
    #![proptest_config(proptest_config(256))]

    /// The damaged-marker rules against a model that only counts marker lines.
    #[test]
    fn damaged_markers_follow_the_rules(lines in prop::collection::vec(marker_line(), 0..12)) {
        let body = lines.join("\n");
        let starts = lines.iter().filter(|l| exact(l, SECTION_START)).count();
        let ends = lines.iter().filter(|l| {
            let t = l.trim();
            t.starts_with("<!-- readwise:end ") && t.ends_with(" -->")
        }).count();
        let inline = lines.iter().any(|l| {
            !exact(l, SECTION_START) && !l.trim().starts_with("<!-- readwise:end ")
                && (l.contains("<!-- readwise:start") || l.contains("<!-- readwise:end"))
        });
        match read_section(&body) {
            SectionRead::Found { range, text, untouched, marker } => {
                prop_assert!(!inline && starts == 1 && ends == 1);
                prop_assert!(body[range.clone()].contains(text));
                prop_assert_eq!(untouched, marker.is_some_and(|m| m.hash == hash_section_body(text)));
            }
            SectionRead::Missing { problem, end } => {
                let expected = if inline {
                    SectionProblem::InlineMarker
                } else if starts > 1 || ends > 1 {
                    SectionProblem::DuplicateMarkers
                } else if ends == 0 && starts == 0 {
                    SectionProblem::NoStart
                } else if ends == 0 {
                    SectionProblem::NoEnd
                } else if starts == 0 {
                    SectionProblem::NoStart
                } else {
                    SectionProblem::OutOfOrder
                };
                prop_assert_eq!(problem, expected);
                prop_assert_eq!(end.is_some(), ends == 1 && !inline && starts <= 1);
                if let Some(end) = end {
                    prop_assert!(body[end.range].trim().starts_with("<!-- readwise:end "));
                }
            }
        }
    }

    /// A sealed section of marker-free text reads back untouched, with its `last`.
    #[test]
    fn sealed_sections_read_back_untouched(body in "[ -~\u{a0}\u{1F600}\r\n\t]{0,80}", last in "[!-~]{1,24}") {
        prop_assume!(!body.contains("<!-- readwise"));
        let sealed = seal_section(&body, &last);
        let note = format!("intro\n\n{sealed}\n\noutro");
        match read_section(&note) {
            SectionRead::Found { untouched, marker, .. } => {
                prop_assert!(untouched);
                prop_assert_eq!(marker.map(|m| m.last), Some(last.clone()));
            }
            other => prop_assert!(false, "not found: {other:?}"),
        }
        prop_assert!(sealed.len() <= output_bound(body.len() + last.len()));
    }

    /// Line endings and trailing blanks the editor round trip may change leave the hash alone.
    #[test]
    fn the_hash_ignores_line_endings_and_trailing_blanks(lines in prop::collection::vec("[ -~\u{1F600}]{0,10}", 0..8)) {
        let lf = lines.join("\n");
        let crlf = lines.iter().map(|l| format!("{}  \t", l.trim_end())).collect::<Vec<_>>().join("\r\n");
        prop_assert_eq!(hash_section_body(&lf.lines().map(str::trim_end).collect::<Vec<_>>().join("\n")), hash_section_body(&crlf));
    }

    /// Escaping only inserts zero-width spaces, within the output bound.
    #[test]
    fn escaping_only_inserts_zero_width_spaces(text in "[#\\[\\]!<>xX =~`\\-+*0-9a-zA-Z\u{a0}\u{200b}\n]{0,60}") {
        let escaped = escape_paragraphs(&text);
        let strip = |s: &str| s.replace('\u{200b}', "");
        prop_assert_eq!(strip(&escaped), strip(&memry_desktop::readwise::text::normalize_paragraphs(&text)));
        prop_assert!(escaped.len() <= output_bound(text.len()));
    }

    /// Re-rendering an untouched day section is idempotent: the second plan changes nothing.
    #[test]
    fn day_rerender_is_idempotent(
        prefix in "[ -~\n]{0,30}",
        counts in prop::collection::vec(1u64..5, 1..4),
        later in 1u64..5,
    ) {
        prop_assume!(!prefix.contains("<!--"));
        let books = |extra: u64| -> Vec<JournalBook> {
            counts.iter().enumerate().map(|(i, c)| JournalBook {
                title: format!("Book {i}"),
                count: c + extra,
                first: format!("2026-10-22T0{i}:00:00.000Z"),
            }).collect()
        };
        let JournalWrite::Append { markdown } = plan_journal_write(None, &books(0), &[]) else {
            panic!("a missing entry gets the whole section");
        };
        let body = format!("{prefix}\n\n{markdown}\n");
        prop_assert!(read_day_section(&body).untouched());
        let JournalWrite::Update { content } = plan_journal_write(Some(&body), &books(later), &[]) else {
            panic!("new counts rewrite an untouched section");
        };
        prop_assert_eq!(plan_journal_write(Some(&content), &books(later), &[]), JournalWrite::Unchanged);
    }
}
