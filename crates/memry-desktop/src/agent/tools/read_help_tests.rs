//! The cases of Electron's `help-docs.test.ts` over the guide `build.rs` bundles, plus the
//! parsing rules of `help-docs.ts` on small pages.

use serde_json::json;

use super::*;
use crate::agent::mcp::ToolErrorCode;

fn top_sections(query: &str) -> Vec<String> {
    search_in(index(), query, 3)
        .into_iter()
        .map(|hit| format!("{}#{}", hit.page, hit.section.unwrap_or_default()))
        .collect()
}

fn pages() -> Vec<String> {
    let mut pages: Vec<String> = index().iter().map(|s| s.page.clone()).collect();
    pages.dedup();
    pages
}

fn text(page: &str, section: Option<&str>) -> String {
    read_in(index(), page, section).unwrap()["text"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn finds_the_guide_section_that_answers_a_question() {
    for (query, expected) in [
        (
            "how do I show a note on the calendar",
            "user-guide/faq#How do I show a note on the calendar?",
        ),
        (
            "note date property calendar",
            "user-guide/notes/properties-tags#Showing Dates on the Calendar",
        ),
        (
            "search text inside pdf",
            "user-guide/search#Text in PDFs and images",
        ),
        (
            "keep pdf and photo in vault",
            "user-guide/faq#Can I keep PDFs and photos in my vault?",
        ),
    ] {
        let top = top_sections(query);
        assert!(top.iter().any(|s| s == expected), "{query}: {top:?}");
    }
}

#[test]
fn leaves_out_the_cli_and_agent_api_reference_pages() {
    let pages = pages();
    assert!(pages.iter().any(|p| p == "user-guide/search"));
    assert!(pages.iter().any(|p| p == "user-guide/faq"));
    for page in [
        "user-guide/cli",
        "user-guide/cli-reference",
        "user-guide/ai/agent-api-reference",
        "user-guide/ai/agent-mcp",
        "user-guide/ai/agent-backends",
    ] {
        assert!(!pages.iter().any(|p| p == page), "{page}");
    }
}

#[test]
fn reads_a_section_with_its_subsections_or_the_whole_page() {
    let bookmarking = text("user-guide/notes/bookmarks-reminders", Some("Bookmarking"));
    assert!(bookmarking.contains("### On iPhone"));
    assert!(!bookmarking.contains("## Reminders"));
    assert!(text("user-guide/search", Some("Text in PDFs and images")).contains("PDFs and images"));
    let page = text("user-guide/search", None);
    assert!(page.contains("## Text in PDFs and images"));
    assert!(!page.contains("<!--"));
    assert!(read_in(index(), "user-guide/nope", None).is_none());
}

#[test]
fn answers_that_pdf_annotation_is_not_supported() {
    let hits = search_in(index(), "annotate highlight pdf", 1);
    assert_eq!(hits[0].page, "user-guide/faq");
}

#[test]
fn a_missing_page_or_section_is_not_found_with_both_named() {
    let error = read(&json!({ "page": "user-guide/search", "section": "Nope" })).unwrap_err();
    assert_eq!(error.code, ToolErrorCode::NotFound);
    assert_eq!(
        error.message,
        "No guide section \"Nope\" on page \"user-guide/search\". Use a page and section from a \
         memry_help_search result."
    );
    let details = error.details.unwrap();
    assert_eq!(details["section"], json!("Nope"));
    let error = read(&json!({ "page": "user-guide/nope" })).unwrap_err();
    assert_eq!(error.details.unwrap()["section"], json!(null));
}

#[test]
fn search_answers_at_most_five_results_with_short_snippets() {
    let reply = search(&json!({ "query": "note" }));
    let results = reply["results"].as_array().unwrap();
    assert!(!results.is_empty() && results.len() <= 5);
    for hit in results {
        let snippet = hit["snippet"].as_str().unwrap();
        assert!(snippet.encode_utf16().count() <= 240);
        assert!(!snippet.contains('\n'));
    }
}

#[test]
fn splits_on_level_two_and_three_headings_outside_fences() {
    let page = "---\ntitle: x\n---\n# Title\n\nintro <kbd>K</kbd>\n\n::: tip\n\n## A\n\na \
                text\n\n```\n## not a heading\n```\n\n### A1\n\nsub\n\n#### deep\n\n## B\n\nb";
    let sections = build_index(&[("p".to_owned(), page.to_owned())]);
    let heads: Vec<(Option<&str>, usize)> = sections
        .iter()
        .map(|s| (s.section.as_deref(), s.level))
        .collect();
    assert_eq!(
        heads,
        [(None, 1), (Some("A"), 2), (Some("A1"), 3), (Some("B"), 2)]
    );
    assert_eq!(sections[0].page_title, "Title");
    assert_eq!(sections[0].text, "# Title\n\nintro K");
    assert!(sections[1].text.contains("## not a heading"));
    assert!(sections[2].text.contains("#### deep"));
    let read = read_in(&sections, "p", Some("A")).unwrap();
    assert!(read["text"].as_str().unwrap().contains("### A1\n\nsub"));
    assert!(!read["text"].as_str().unwrap().contains("## B"));
}

#[test]
fn tokens_drop_stop_words_and_a_plural_s() {
    assert_eq!(tokens("How do I add Tags to notes"), ["add", "tag", "note"]);
    assert_eq!(tokens("class bus"), ["class", "bus"]);
}

#[test]
fn snippet_cut_keeps_a_surrogate_pair_whole() {
    assert_eq!(utf16_prefix("ab\u{1F600}", 3), "ab");
    assert_eq!(utf16_prefix("ab\u{1F600}", 4), "ab\u{1F600}");
}
