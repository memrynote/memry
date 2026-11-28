//! Reproduces `packages/contracts/test-vectors/export.json`, written by
//! Electron's export renderer (`apps/desktop/scripts/export-oracle`), byte for
//! byte: the stylesheet, the file names and every exported document. A case in
//! [`DEPARTURES`] differs on purpose and is held to the same DOM instead: both
//! bodies are parsed, whitespace-only text outside `pre` is dropped, attributes
//! are sorted and void elements are written one way.
//!
//! Every document departs in one line: the Content-Security-Policy `<meta>`
//! Electron's export lacks ([`CONTENT_SECURITY_POLICY`]). It is taken out, once,
//! before the comparison.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::{DateTime, NaiveDate};
use memry_desktop::export::{
    CONTENT_SECURITY_POLICY, CustomIcon, ImageSource, NoteExport, RenderOptions, embedded_styles,
    inline_export_images, render_note_as_html, sanitize_filename,
};
use memry_desktop::web::extract::dom::{Document, NodeId, NodeKind};
use serde_json::Value;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn vectors() -> Value {
    let path = repo_root().join("packages/contracts/test-vectors/export.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("export.json")).expect("json")
}

fn date(value: &Value) -> NaiveDate {
    DateTime::parse_from_rfc3339(value.as_str().expect("date"))
        .expect("rfc3339")
        .date_naive()
}

const VOID: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track",
    "wbr",
];

fn canonical(doc: &Document, id: NodeId, in_pre: bool, out: &mut String) {
    match &doc.node(id).kind {
        NodeKind::Element(element) => {
            let name = element.name.to_lowercase();
            let mut attrs: Vec<_> = element
                .attrs
                .iter()
                .map(|a| (a.name.to_lowercase(), a.value.clone()))
                .collect();
            attrs.sort();
            out.push('<');
            out.push_str(&name);
            for (attr, value) in attrs {
                out.push_str(&format!(" {attr}={value:?}"));
            }
            out.push('>');
            if VOID.contains(&name.as_str()) {
                return;
            }
            write_children(doc, id, in_pre || name == "pre", out);
            out.push_str(&format!("</{name}>"));
        }
        NodeKind::Text(_) => unreachable!("written by write_children"),
        NodeKind::Comment(text) => out.push_str(&format!("<!--{text}-->")),
        _ => write_children(doc, id, in_pre, out),
    }
}

const BLOCK: &[&str] = &[
    "blockquote",
    "div",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "li",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul",
];

fn is_block(doc: &Document, id: Option<NodeId>) -> bool {
    match id.map(|id| &doc.node(id).kind) {
        Some(NodeKind::Element(element)) => BLOCK.contains(&element.name.to_lowercase().as_str()),
        _ => true,
    }
}

/// Adjacent text nodes are one text (the parser splits text at entities).
/// Outside `pre`, whitespace next to a block boundary is not rendered, so it
/// is trimmed, and text left empty is dropped.
fn write_children(doc: &Document, id: NodeId, in_pre: bool, out: &mut String) {
    let children = doc.child_nodes(id);
    let mut i = 0;
    while i < children.len() {
        let NodeKind::Text(_) = doc.node(children[i]).kind else {
            canonical(doc, children[i], in_pre, out);
            i += 1;
            continue;
        };
        let first = i;
        let mut text = String::new();
        while let Some(NodeKind::Text(part)) = children.get(i).map(|c| &doc.node(*c).kind) {
            text.push_str(part);
            i += 1;
        }
        let mut text = text.as_str();
        if !in_pre {
            let ascii_space = |c: char| c.is_ascii_whitespace();
            if is_block(doc, first.checked_sub(1).map(|p| children[p])) {
                text = text.trim_start_matches(ascii_space);
            }
            if is_block(doc, children.get(i).copied()) {
                text = text.trim_end_matches(ascii_space);
            }
        }
        if !text.is_empty() {
            out.push_str(&format!("{text:?}"));
        }
    }
}

fn canonical_html(html: &str) -> String {
    let doc = Document::parse_html(html).expect("parse");
    let mut out = String::new();
    write_children(&doc, doc.root(), false, &mut out);
    out
}

/// Cases whose bytes differ from Electron's on purpose, with the reason.
const DEPARTURES: &[(&str, &str)] = &[(
    "entities",
    "comrak decodes an entity reference to its character; marked writes it as spelled",
)];

const OPEN: &str = "<main class=\"note-content\">";
const CLOSE: &str = "</main>";

fn split(html: &str) -> (&str, &str, &str) {
    let start = html.find(OPEN).expect("content open") + OPEN.len();
    let end = html.rfind(CLOSE).expect("content close");
    (&html[..start], &html[start..end], &html[end..])
}

#[test]
fn stylesheet_and_file_names_match_electron() {
    let vectors = vectors();
    assert_eq!(
        embedded_styles(),
        vectors["styles"].as_str().expect("styles")
    );
    for case in vectors["filenames"].as_array().expect("filenames") {
        let input = case["input"].as_str().expect("input");
        assert_eq!(
            sanitize_filename(input),
            case["output"],
            "sanitizeFilename({input:?})"
        );
    }
}

#[test]
fn exported_html_matches_electron() {
    let vectors = vectors();
    let custom: HashMap<String, CustomIcon> = vectors["meta"]["customIcons"]
        .as_object()
        .expect("customIcons")
        .iter()
        .map(|(id, icon)| {
            let field = |name: &str| icon[name].as_str().expect("icon field").to_owned();
            (
                id.clone(),
                CustomIcon {
                    ext: field("ext"),
                    data: field("data"),
                },
            )
        })
        .collect();
    let find_custom_icon = |id: &str| custom.get(id).cloned();
    let vault = repo_root().join(vectors["meta"]["vault"].as_str().expect("vault"));

    let cases = vectors["cases"].as_array().expect("cases");
    assert!(cases.len() >= 60, "corpus shrank to {}", cases.len());
    for (departure, _) in DEPARTURES {
        assert!(
            cases.iter().any(|case| case["name"] == *departure),
            "DEPARTURES names {departure:?}, which is not a case"
        );
    }
    let mut failures = Vec::new();
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let note = &case["note"];
        let tags: Vec<String> = note["tags"]
            .as_array()
            .expect("tags")
            .iter()
            .map(|tag| tag.as_str().expect("tag").to_owned())
            .collect();
        let export = NoteExport {
            title: note["title"].as_str().expect("title"),
            content: note["content"].as_str().expect("content"),
            icon: note["emoji"].as_str(),
            tags: &tags,
            created: date(&note["created"]),
            modified: date(&note["modified"]),
        };
        let options = RenderOptions {
            include_metadata: case["options"]["includeMetadata"]
                .as_bool()
                .expect("metadata"),
            include_task_markers: case["options"]["includeTaskMarkers"]
                .as_bool()
                .expect("task markers"),
            find_custom_icon: &find_custom_icon,
        };
        let rendered = render_note_as_html(&export, &options);
        let inlined = inline_export_images(
            &rendered,
            ImageSource {
                note_path: note["path"].as_str(),
                vault_path: Some(&vault),
                app_data: None,
            },
        );
        let head = &inlined[..inlined.find("<body>").expect("body")];
        assert_eq!(
            head.matches(CONTENT_SECURITY_POLICY).count(),
            1,
            "{name}: the head carries the policy once"
        );
        let actual = inlined.replacen(CONTENT_SECURITY_POLICY, "", 1);
        let expected = case["html"].as_str().expect("html");

        let departure = DEPARTURES.iter().any(|(case, _)| *case == name);
        if actual == expected {
            if departure {
                failures.push(format!(
                    "{name}: matches Electron now; drop it from DEPARTURES"
                ));
            }
            continue;
        }
        if !departure {
            failures.push(format!(
                "{name}: bytes differ\n--- electron\n{expected}\n--- rust\n{actual}"
            ));
            continue;
        }
        let (want_head, want_body, want_tail) = split(expected);
        let (got_head, got_body, got_tail) = split(&actual);
        if got_head != want_head || got_tail != want_tail {
            failures.push(format!(
                "{name}: document outside the body differs\n--- electron\n{want_head}\n--- rust\n{got_head}"
            ));
            continue;
        }
        let (want, got) = (canonical_html(want_body), canonical_html(got_body));
        if want != got {
            failures.push(format!(
                "{name}: body differs\n--- electron\n{want_body}\n--- rust\n{got_body}\n--- canonical electron\n{want}\n--- canonical rust\n{got}"
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n\n")
    );
}
