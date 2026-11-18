//! The Apple Journal importer: `apps/desktop/src/main/import/apple-journal/
//! apple-journal-importer.ts` and `packages/importers/src/apple-journal/{dates,metadata,
//! map-entries}.ts`.
//!
//! Each entry page of a Journal export becomes a note in `Apple Journal`, titled by the date in
//! its header. The body is its paragraphs, the reflection prompt a closing quote, and the asset
//! grid's labels become properties; photos and videos are not imported.

use std::path::Path;
use std::sync::LazyLock;

use memry_core::markdown::frontmatter::{YamlMap, YamlValue, js_trim};
use regex::Regex;

use super::html::stem;
use super::html_md::{
    NoHooks, has_class, html_to_markdown, parse_html, select, text_content, walk,
};
use super::messages::{ImportText, importing_item};
use super::{
    FileSpec, ImportContext, ImportError, ImportInput, ImportPhase, ImportSink, ImportedNote,
    Importer, ImporterMeta, base_name, read_source_text,
};
use crate::web::extract::dom::{Document, NodeId};

const FOLDER: &str = "Apple Journal";
const IGNORED_TYPES: [&str; 3] = ["photo", "live-photo", "video"];
const MAP_TYPES: [&str; 2] = ["generic-map", "multi-pin-map"];
const OVERLAY_CLASSES: [&str; 5] = [
    "gridItemOverlayHeader",
    "gridItemOverlayFooter",
    "gridItemOverlayText",
    "activityType",
    "mediaTitle",
];
const MONTHS: [&str; 12] = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

/// `DATE_RE`: an optional `Weekday, ` then `D Month YYYY`, with JavaScript's ASCII `\w` / `\d`.
static DATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:[A-Za-z0-9_]{1,20},\s+)?([0-9]{1,2})\s+([A-Za-z]+)\s+([0-9]{4})")
        .expect("valid regex")
});

/// `parseJournalDate`: `Sunday, 3 November 2024` as `2024-11-03`.
pub fn parse_journal_date(text: &str) -> Option<String> {
    let caps = DATE.captures(js_trim(text))?;
    let day: u32 = caps[1].parse().ok()?;
    let month = MONTHS.iter().position(|m| *m == caps[2].to_lowercase())? + 1;
    let year: u32 = caps[3].parse().ok()?;
    if !(1..=31).contains(&day) || !(1900..=2100).contains(&year) {
        return None;
    }
    Some(format!("{year}-{month:02}-{day:02}"))
}

/// `tokensToFrontmatter` assigned over `{ date }`: a map label sets `location`, any other label
/// becomes a `true` key. The map orders array-index keys first, as a JavaScript object does.
pub fn entry_properties(date: Option<&str>, tokens: &[String]) -> YamlMap {
    let mut properties = YamlMap::new();
    if let Some(date) = date {
        properties.insert("date".to_owned(), YamlValue::String(date.to_owned()));
    }
    for token in tokens {
        let token = js_trim(token);
        // `result['__proto__'] = true` sets the prototype, not a key.
        if token.is_empty() || IGNORED_TYPES.contains(&token) || token == "__proto__" {
            continue;
        }
        let key = if MAP_TYPES.contains(&token) {
            "location"
        } else {
            token
        };
        properties.insert(key.to_owned(), YamlValue::Bool(true));
    }
    properties
}

/// `mapEntry`'s body: the paragraphs, then the reflection as a quote.
pub fn entry_content(body: &str, reflection: Option<&str>) -> String {
    let mut parts = Vec::new();
    if !js_trim(body).is_empty() {
        parts.push(js_trim(body).to_owned());
    }
    if let Some(reflection) = reflection.map(js_trim).filter(|r| !r.is_empty()) {
        parts.push(format!("> {reflection}"));
    }
    parts.join("\n\n")
}

/// `querySelector('.name')`'s trimmed text.
fn class_text(doc: &Document, name: &str) -> Option<String> {
    select(doc, doc.root(), |n| has_class(doc, n, name))
        .first()
        .map(|&n| js_trim(&text_content(doc, n)).to_owned())
}

/// `collectTokens`: the overlay labels of every non-media item of the asset grid.
fn collect_tokens(doc: &Document) -> Vec<String> {
    let items: Vec<NodeId> = select(doc, doc.root(), |n| {
        has_class(doc, n, "gridItem") && has_ancestor_class(doc, n, "assetGrid")
    });
    let mut tokens = Vec::new();
    for item in items {
        let kind = select(doc, item, |n| has_class(doc, n, "activityType"))
            .first()
            .map(|&n| js_trim(&text_content(doc, n)).to_owned())
            .unwrap_or_default();
        if IGNORED_TYPES.contains(&kind.as_str()) {
            continue;
        }
        walk(doc, item, &mut |_| false, &mut |n| {
            if OVERLAY_CLASSES.iter().any(|c| has_class(doc, n, c)) {
                let text = js_trim(&text_content(doc, n)).to_owned();
                if !text.is_empty() {
                    tokens.push(text);
                }
            }
            false
        });
    }
    tokens
}

fn has_ancestor_class(doc: &Document, node: NodeId, name: &str) -> bool {
    let mut current = doc.parent_element(node);
    while let Some(ancestor) = current {
        if has_class(doc, ancestor, name) {
            return true;
        }
        current = doc.parent_element(ancestor);
    }
    false
}

pub struct AppleJournalImporter;

impl Importer for AppleJournalImporter {
    fn meta(&self) -> ImporterMeta {
        ImporterMeta {
            id: "apple-journal".to_owned(),
            name: "Apple Journal".to_owned(),
            description_key: "import.sources.apple-journal".to_owned(),
            file_spec: FileSpec {
                label: "Apple Journal export".to_owned(),
                extensions: vec!["html".to_owned(), "htm".to_owned()],
                allow_multiple: true,
                ..FileSpec::default()
            },
            supports_preview: false,
            account_based: false,
        }
    }

    fn run(
        &self,
        input: &ImportInput,
        ctx: &mut ImportContext,
        sink: &dyn ImportSink,
    ) -> Result<(), ImportError> {
        ctx.set_phase(ImportPhase::Importing);
        let total = input.source_paths.len();
        let mut done = 0;
        for source in &input.source_paths {
            if ctx.is_cancelled() {
                break;
            }
            let path = Path::new(source);
            let base = base_name(path);
            if base == "index.html" || base == "index.htm" {
                ctx.report_skipped(source, Some(ImportText::from("index file")));
            } else {
                ctx.status(importing_item(&base));
                match import_entry(path, sink) {
                    Ok(()) => ctx.report_imported(),
                    Err(error) => {
                        tracing::warn!(scope = "import", "apple journal entry import failed");
                        ctx.report_failed(source, &error);
                    }
                }
            }
            done += 1;
            ctx.report_progress(done, total);
        }
        ctx.set_phase(ImportPhase::Done);
        Ok(())
    }
}

fn import_entry(path: &Path, sink: &dyn ImportSink) -> Result<(), String> {
    let html = read_source_text(path).map_err(|e| e.to_string())?;
    let doc = parse_html(&html).map_err(|e| e.to_string())?;
    let date = parse_journal_date(&class_text(&doc, "pageHeader").unwrap_or_default());
    let reflection = class_text(&doc, "reflectionPrompt");
    // `.p2, .p3` in one pass, so the entry keeps its order: Apple assigns the classes by
    // paragraph style, not by position.
    let paragraphs = select(&doc, doc.root(), |n| {
        has_class(&doc, n, "p2") || has_class(&doc, n, "p3")
    });
    let body =
        html_to_markdown(&doc, &paragraphs, html.len(), &mut NoHooks).map_err(|e| e.to_string())?;
    let tokens = collect_tokens(&doc);
    sink.create_note(ImportedNote {
        id: None,
        title: date
            .clone()
            .unwrap_or_else(|| stem(&path.to_string_lossy())),
        content: entry_content(&body.markdown, reflection.as_deref()),
        folder: Some(FOLDER.to_owned()),
        tags: Vec::new(),
        properties: entry_properties(date.as_deref(), &tokens),
        created: date,
        modified: None,
    })
    .map_err(|e| e.0)
}
