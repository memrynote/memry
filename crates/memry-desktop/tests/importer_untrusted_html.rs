//! Guards of the HTML, Evernote and Apple Journal importers, which read other apps' exports:
//! nesting fails the note instead of the stack or a parse that takes minutes, conversion work,
//! journal tokens and the ENEX scan stay bounded by the input (counted in steps), a file or image too large is refused from its size,
//! a remote image never reaches a private address, a link never leaves the page's folder, and
//! properties over arbitrary input neither panic nor outgrow the budget.

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

use memry_desktop::import::MAX_SOURCE_BYTES;
use memry_desktop::import::apple_journal::{AppleJournalImporter, parse_journal_date};
use memry_desktop::import::enex::{bytes_scanned, parse_enex};
use memry_desktop::import::evernote::{EvernoteImporter, MAX_ENEX_BYTES, prepare_enml};
use memry_desktop::import::html::{HtmlImporter, MAX_ASSET_BYTES};
use memry_desktop::import::html_md::{
    BASE_STEPS, HtmlMdError, MAX_DEPTH, MAX_PARSE_DEPTH, NoHooks, STEPS_PER_INPUT_BYTE,
    html_to_markdown, parse_html, steps_taken,
};
use memry_desktop::import::remote::{RemoteAssets, RemoteError, safe_remote_asset_url};
use memry_test_kit::{assert_steps_at_most, on_small_stack, proptest_config};
use proptest::prelude::*;
use url::Url;

use crate::importer_untrusted::{ops, run, sparse};

/// Converts the body of `html` without hooks.
fn convert(html: &str) -> Result<String, HtmlMdError> {
    let mut doc = parse_html(html)?;
    let nodes = doc.body().map(|b| doc.child_nodes(b)).unwrap_or_default();
    html_to_markdown(&doc, &nodes, html.len(), &mut NoHooks).map(|md| md.markdown)
}

fn nested(open: &str, close: &str, depth: usize, inner: &str) -> String {
    format!("{}{inner}{}", open.repeat(depth), close.repeat(depth))
}

#[test]
fn nesting_up_to_the_cap_converts_and_deeper_fails_on_a_small_stack() {
    on_small_stack(|| {
        let allowed = [
            nested("<div>", "</div>", MAX_DEPTH - 1, "x"),
            nested("<blockquote>", "</blockquote>", MAX_DEPTH - 1, "x"),
            // Each list level re-indents every line below it: 100 levels stay well inside the budget.
            nested("<ul><li>", "</li></ul>", 100, "x"),
            format!(
                "<p>{}</p>",
                nested("<b><i>", "</i></b>", MAX_DEPTH / 2 - 1, "x")
            ),
            nested(
                "<table><tr><td>",
                "</td></tr></table>",
                MAX_DEPTH / 4 - 2,
                "x",
            ),
        ];
        for html in &allowed {
            let md = convert(html).unwrap_or_else(|e| panic!("{e}: {}", &html[..40]));
            assert!(md.contains('x'), "{md}");
        }
        // Deeper than the converter follows, within what the parser builds.
        let parsed = nested("<div>", "</div>", MAX_PARSE_DEPTH / 2, "x");
        assert_eq!(convert(&parsed), Err(HtmlMdError::TooDeep));
        // Past what the parser builds: without its bound each parses for many minutes, and
        // nextest's per-test timeout fails the test.
        for (open, close) in [
            ("<div>", "</div>"),
            ("<ul><li>", ""),
            ("<b>", ""),
            ("<span>", ""),
            ("<table><tr><td>", ""),
        ] {
            let html = nested(open, close, 100_000, "x");
            assert_eq!(convert(&html), Err(HtmlMdError::TooDeep), "{open}");
        }
    });
}

/// html5ever's time grows with the square of the nesting however the markup spells it, so the
/// depth of the tree it builds stops the parse. Without the bound each case parses for minutes
/// and nextest's per-test timeout fails the test.
#[test]
fn a_deep_tree_stops_the_parse_whatever_the_markup() {
    let divs = "<div>".repeat(100_000);
    for prefix in [
        "",
        "<svg><title>",
        "<svg><style>",
        "<!-->",
        "<!-- --!>",
        "<p a=\"><!--\">",
        "<math><plaintext>",
    ] {
        let html = format!("{prefix}{divs}");
        assert_eq!(
            parse_html(&html).err(),
            Some(HtmlMdError::TooDeep),
            "{prefix}"
        );
    }
}

/// Markup the parser keeps shallow converts however many tags it has.
#[test]
fn wide_pages_that_close_their_tags_implicitly_convert() {
    let pages = [
        format!("<svg>{}</svg><p>x</p>", "<path d=\"M0 0\"/>".repeat(1_100)),
        "<p><span>x".repeat(1_100),
        "<div><font>x</div>".repeat(1_100),
        "<h3>x".repeat(1_100),
        prepare_enml(&"<en-todo/>x<br/>".repeat(1_100)),
        "<li>x".repeat(5_000),
        "<a name=\"n\">x".repeat(5_000),
        format!("<script>{}</script>x", "'<div>' + ".repeat(5_000)),
        "<!-- <div> -->x".repeat(5_000),
    ];
    on_small_stack(move || {
        for html in &pages {
            let md = convert(html).unwrap_or_else(|e| panic!("{e}: {}", &html[..30]));
            assert!(md.contains('x'), "{}", &html[..30]);
        }
        let todos = convert(&pages[4]).unwrap();
        assert_eq!(todos.matches("- [ ] x").count(), 1_100);
    });
}

/// Each sub-list of an item is found by its parent, not by a search of the item's sub-lists.
#[test]
fn a_list_item_with_many_sub_lists_converts_in_linear_steps() {
    let html = format!(
        "<ul><li>a{}</li></ul>",
        "<ul><li>x</li></ul>".repeat(20_000)
    );
    let bound = 8 * html.len();
    on_small_stack(move || {
        assert_steps_at_most("sub-lists", steps_taken, bound, || {
            assert!(convert(&html).unwrap().contains("  - x"));
        });
    });
}

/// Overlays nested in each other repeat their text once per level (Electron's
/// `querySelectorAll`): past the budget the entry fails instead of holding hundreds of MB.
#[test]
fn nested_journal_overlays_fail_the_entry_instead_of_repeating_their_text() {
    let dir = tempfile::tempdir().unwrap();
    let entry = dir.path().join("entry.html");
    let html = format!(
        "<div class=\"assetGrid\"><div class=\"gridItem\">{}{}</div></div>",
        "<div class=\"gridItemOverlayText\">".repeat(1_000),
        "x".repeat(200_000)
    );
    fs::write(&entry, html).unwrap();
    let (summary, calls) = run(&AppleJournalImporter, &[&entry]);
    assert_eq!(summary.failed.len(), 1, "{summary:?}");
    assert_eq!(
        summary.failed[0].error,
        "The HTML is too complex to convert"
    );
    assert_eq!(ops(&calls, "createNote"), 0);
}

#[test]
fn a_deep_page_fails_its_note_not_the_run() {
    let dir = tempfile::tempdir().unwrap();
    let page = dir.path().join("deep.html");
    fs::write(&page, nested("<div>", "", 100_000, "x")).unwrap();
    fs::write(dir.path().join("ok.html"), "<p>fine</p>").unwrap();
    let (summary, calls) = on_small_stack(move || {
        let ok = page.with_file_name("ok.html");
        run(&HtmlImporter::default(), &[&page, &ok])
    });
    assert_eq!(summary.imported, 1, "{summary:?}");
    assert_eq!(summary.failed.len(), 1);
    assert_eq!(
        summary.failed[0].error,
        format!("The HTML is nested more than {MAX_DEPTH} levels deep")
    );
    assert_eq!(ops(&calls, "createNote"), 1);
}

#[test]
fn conversion_steps_are_linear_in_a_wide_page() {
    let html: String = (0..20_000)
        .map(|n| format!("<p>t{n} <b>y</b> <a href=\"https://e.com\">l</a></p><li>i</li>"))
        .collect();
    let bound = 8 * html.len();
    on_small_stack(move || {
        assert_steps_at_most("wide page", steps_taken, bound, || {
            assert!(convert(&html).unwrap().contains("t19999"));
        });
    });
}

/// Every `tr` below a table is one of its rows and renders its cells' whole subtrees, so nested
/// tables repeat their content cubically. The budget fails the note instead.
#[test]
fn nested_tables_exceed_the_budget_instead_of_repeating_their_content() {
    let html = nested(
        "<table><tr><td>",
        "</td></tr></table>",
        30,
        &"x".repeat(10_000),
    );
    let budget = html.len() * STEPS_PER_INPUT_BYTE + BASE_STEPS;
    on_small_stack(move || {
        assert_steps_at_most("nested tables", steps_taken, budget + 1_000_000, || {
            assert_eq!(convert(&html), Err(HtmlMdError::TooComplex));
        });
    });
}

#[test]
fn files_and_images_over_their_caps_are_refused_before_they_are_read() {
    let dir = tempfile::tempdir().unwrap();
    let big_page = dir.path().join("big.html");
    sparse(&big_page, MAX_SOURCE_BYTES + 1);
    let big_enex = dir.path().join("big.enex");
    sparse(&big_enex, MAX_ENEX_BYTES + 1);
    sparse(&dir.path().join("big.png"), MAX_ASSET_BYTES as u64 + 1);
    let page = dir.path().join("page.html");
    fs::write(&page, r#"<img src="big.png">"#).unwrap();

    let (summary, calls) = run(&HtmlImporter::default(), &[&big_page, &page]);
    assert_eq!(summary.failed.len(), 1, "{summary:?}");
    assert_eq!(summary.failed[0].error, "File is larger than 100 MB");
    assert_eq!(ops(&calls, "saveAttachment"), 0, "{calls:?}");
    let reasons = serde_json::to_value(&summary.skipped_reasons).unwrap();
    assert_eq!(
        reasons,
        serde_json::json!([{ "reason": "too large", "count": 1 }])
    );

    let (summary, _) = run(&EvernoteImporter, &[&big_enex]);
    assert_eq!(summary.failed[0].error, "File is larger than 512 MB");
}

/// A non-image attachment becomes its file block when its resource is saved and nothing when
/// it is missing: the internal `memry-enex:` link never reaches the note.
#[test]
fn an_enex_attachment_link_never_reaches_the_note() {
    let dir = tempfile::tempdir().unwrap();
    let enex = dir.path().join("n.enex");
    let pdf = "JVBERi0xLjQK"; // "%PDF-1.4\n"
    fs::write(
        &enex,
        format!(
            concat!(
                "<en-export><note><title>t</title><content><![CDATA[<en-note>",
                r#"<en-media hash="5f2ba3e7a3a54ee8b8ed1d1c1b5a5d8b" type="application/pdf"/>"#,
                r#"<en-media hash="{hash}" type="application/pdf"/>"#,
                "</en-note>]]></content><resource><data>{data}</data>",
                "<mime>application/pdf</mime></resource></note></en-export>"
            ),
            hash = "6446a98080f5e51ab7f0abc0e8eda635",
            data = pdf
        ),
    )
    .unwrap();
    let (_, calls) = run(&EvernoteImporter, &[&enex]);
    let created = calls.iter().find(|c| c["op"] == "createNote").unwrap();
    let content = created["content"].as_str().unwrap();
    assert!(!content.contains("memry-enex:"), "{content}");
    assert!(content.starts_with("<!-- file:{"), "{content}");
}

#[test]
fn the_enex_scan_steps_over_each_byte_once_at_any_depth() {
    let hostile = [
        format!(
            "<en-export><note><title>{}</title></note></en-export>",
            nested("<a>", "", 200_000, "x")
        ),
        "<!--".repeat(100_000),
        "<![CDATA[".repeat(100_000),
        "<a b=\"".repeat(100_000),
        "<!x [".repeat(100_000),
        "<en-export>".to_owned() + &"<note><title>t</title></note>".repeat(50_000),
    ];
    on_small_stack(move || {
        for xml in hostile {
            assert_steps_at_most("enex scan", bytes_scanned, xml.len(), || {
                let notes = parse_enex(&xml).unwrap();
                assert!(notes.len() <= 50_000);
            });
        }
    });
}

#[test]
fn only_https_to_public_hosts_is_fetched() {
    for refused in [
        "http://example.com/a.png",
        "https://localhost/a.png",
        "https://a.localhost/a.png",
        "https://127.0.0.1/a.png",
        "https://2130706433/a.png",
        "https://10.1.2.3/a.png",
        "https://172.16.0.1/a.png",
        "https://192.168.1.1/a.png",
        "https://169.254.169.254/latest",
        "https://100.64.0.1/a.png",
        "https://0.0.0.0/a.png",
        "https://[::1]/a.png",
        "https://[::]/a.png",
        "https://[fe80::1]/a.png",
        "https://[fd00::1]/a.png",
        "https://[::ffff:127.0.0.1]/a.png",
        "https://198.18.0.1/a.png",
        "https://198.19.255.1/a.png",
        "https://[64:ff9b::7f00:1]/a.png",
        "https://[64:ff9b::808:808]/a.png",
        "https://[64:ff9b:1::a00:1]/a.png",
        "https://[2002:7f00:1::]/a.png",
        "https://[2002:c0a8:101::1]/a.png",
        "https://[100::1]/a.png",
        "file:///etc/passwd",
    ] {
        assert!(safe_remote_asset_url(refused).is_none(), "{refused}");
    }
    for allowed in [
        "https://example.com/a.png",
        "https://8.8.8.8/a.png",
        "https://[2606:4700::1]/a",
        "https://198.20.0.1/a.png",
        "https://[2002:808:808::1]/a.png",
        "https://[100:0:0:1::1]/a.png",
    ] {
        assert!(safe_remote_asset_url(allowed).is_some(), "{allowed}");
    }
}

/// Answers by the URL's path; records every URL it was asked for.
#[derive(Default)]
struct FakeRemote {
    asked: Mutex<Vec<String>>,
}

impl RemoteAssets for FakeRemote {
    fn fetch(&self, url: &Url, cap: usize) -> Result<Vec<u8>, RemoteError> {
        self.asked.lock().unwrap().push(url.to_string());
        assert_eq!(cap, MAX_ASSET_BYTES);
        match url.path() {
            "/ok.png" => Ok(b"png".to_vec()),
            "/big.png" => Err(RemoteError::TooLarge),
            "/down.png" => Err(RemoteError::Unreachable("fetch failed".to_owned())),
            _ => Err(RemoteError::Status(404)),
        }
    }
}

#[test]
fn remote_images_are_fetched_only_when_safe_and_each_failure_is_skipped() {
    let dir = tempfile::tempdir().unwrap();
    let page = dir.path().join("p.html");
    fs::write(
        &page,
        concat!(
            r#"<img src="https://e.com/ok.png"><img src="https://e.com/gone.png">"#,
            r#"<img src="https://e.com/big.png"><img src="https://e.com/down.png">"#,
            r#"<img src="https://127.0.0.1/ok.png"><img src="http://e.com/ok.png">"#
        ),
    )
    .unwrap();
    let remote = Arc::new(FakeRemote::default());
    let (summary, calls) = run(&HtmlImporter::new(remote.clone()), &[&page]);
    assert_eq!(
        *remote.asked.lock().unwrap(),
        [
            "https://e.com/ok.png",
            "https://e.com/gone.png",
            "https://e.com/big.png",
            "https://e.com/down.png"
        ]
    );
    assert_eq!(summary.attachments, 1);
    let reasons = serde_json::to_value(&summary.skipped_reasons).unwrap();
    assert_eq!(
        reasons,
        serde_json::json!([
            { "reason": "HTTP 404", "count": 1 },
            { "reason": "too large", "count": 1 },
            { "reason": "fetch failed", "count": 1 },
            { "reason": "unsafe URL", "count": 2 }
        ])
    );
    let created = calls.iter().find(|c| c["op"] == "createNote").unwrap();
    assert!(
        created["content"]
            .as_str()
            .unwrap()
            .starts_with("![](attachments/note-1/ok.png)"),
        "{created}"
    );
}

#[test]
fn spellings_of_one_local_image_save_it_once() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.png"), b"png").unwrap();
    let page = dir.path().join("p.html");
    fs::write(
        &page,
        r#"<img src="a.png"><img src="./a.png"><img src="x/../a.png">"#,
    )
    .unwrap();
    let (summary, calls) = run(&HtmlImporter::default(), &[&page]);
    assert_eq!(ops(&calls, "saveAttachment"), 1, "{calls:?}");
    assert_eq!(summary.attachments, 1);
    let created = calls.iter().find(|c| c["op"] == "createNote").unwrap();
    assert_eq!(
        created["content"],
        "![](attachments/note-1/a.png)\n\n![](attachments/note-1/a.png)\n\n![](attachments/note-1/a.png)"
    );
}

#[cfg(unix)]
#[test]
fn a_link_out_of_the_page_folder_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let site = dir.path().join("site");
    fs::create_dir(&site).unwrap();
    fs::write(dir.path().join("secret.png"), b"secret").unwrap();
    std::os::unix::fs::symlink(dir.path().join("secret.png"), site.join("in.png")).unwrap();
    let page = site.join("p.html");
    fs::write(&page, r#"<img src="in.png">"#).unwrap();
    let (summary, calls) = run(&HtmlImporter::default(), &[&page]);
    assert_eq!(ops(&calls, "saveAttachment"), 0, "{calls:?}");
    let reasons = serde_json::to_value(&summary.skipped_reasons).unwrap();
    assert_eq!(
        reasons,
        serde_json::json!([{ "reason": "unsafe path", "count": 1 }])
    );
}

proptest! {
    #![proptest_config(proptest_config(256))]

    #[test]
    fn html_conversion_stays_within_its_budget(
        html in r#"(<(/?)(div|ul|ol|li|table|tr|td|th|b|a href="x"|img src="y"|pre|code|blockquote|figure class="callout"|p|br|input type="checkbox" checked)>|[a-z \n&<>])*"#
    ) {
        if let Ok(md) = convert(&html) {
            prop_assert!(md.len() <= html.len() * STEPS_PER_INPUT_BYTE + BASE_STEPS);
        }
    }

    #[test]
    fn enex_parsing_and_journal_dates_never_panic(
        xml in r#"(<(/?)(en-export|note|title|content|tag|resource|data|mime|created)( a="1")?(/?)>|<!--|-->|<!\[CDATA\[|\]\]>|<!x \[|&amp;|&lt;|[a-z0-9 ,])*"#
    ) {
        let notes = parse_enex(&xml);
        if let Ok(notes) = notes {
            prop_assert!(notes.iter().all(|n| n.content_html.len() <= xml.len()));
        }
        let _ = parse_journal_date(&xml);
    }
}

#[test]
fn a_page_path_is_not_needed_for_the_title() {
    // `extractTitle` falls back to the file name without its extension.
    let dir = tempfile::tempdir().unwrap();
    let page = dir.path().join("No Title.HTM");
    fs::write(&page, "<p>x</p>").unwrap();
    let (_, calls) = run(&HtmlImporter::default(), &[Path::new(&page)]);
    let created = calls.iter().find(|c| c["op"] == "createNote").unwrap();
    assert_eq!(created["title"], "No Title");
}
