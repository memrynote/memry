//! Port of `packages/shared/src/footnotes.ts` `scanFootnotes`, over a mask whose
//! bytes line up with the source (`super::markdown::byte_mask`), so every offset
//! here is a byte offset into both.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;

use super::js_trim;

#[derive(Debug)]
pub(super) struct Reference {
    /// 1-based, in the order of each note's first reference.
    pub number: usize,
    pub start: usize,
    pub end: usize,
}

#[derive(Debug)]
pub(super) struct Definition {
    label: String,
    /// `None` for a definition nothing references, or a repeat of an earlier label.
    pub number: Option<usize>,
    pub start: usize,
    pub end: usize,
    /// The body without its marker, continuation lines dedented.
    pub text: String,
}

static DEFINITION_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^( {0,3})\[\^([^\s\[\]]+)\]:[ \t]*").expect("valid regex"));
static REFERENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\^([^\s\[\]]+)\]").expect("valid regex"));
static CONTINUATION_INDENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?: {1,4}|\t)").expect("valid regex"));

fn is_block_indented(line: &str) -> bool {
    line.starts_with("    ") || line.starts_with('\t')
}

/// Every footnote reference and definition outside code. A reference with no
/// definition is text. Labels match without regard to case.
pub(super) fn scan_footnotes(markdown: &str, masked: &str) -> (Vec<Reference>, Vec<Definition>) {
    if !markdown.contains("[^") {
        return (Vec::new(), Vec::new());
    }
    let mut definitions = scan_definitions(markdown, masked);
    let markers: HashSet<usize> = definitions.iter().map(|d| d.start).collect();
    let defined: HashSet<String> = definitions.iter().map(|d| d.label.to_lowercase()).collect();

    let mut numbers: HashMap<String, usize> = HashMap::new();
    let mut references = Vec::new();
    for found in REFERENCE.captures_iter(masked) {
        let whole = found.get(0).expect("group 0");
        let key = found[1].to_lowercase();
        if markers.contains(&whole.start()) || !defined.contains(&key) {
            continue;
        }
        let next = numbers.len() + 1;
        let number = *numbers.entry(key).or_insert(next);
        references.push(Reference {
            number,
            start: whole.start(),
            end: whole.end(),
        });
    }

    let mut seen = HashSet::new();
    for definition in &mut definitions {
        let key = definition.label.to_lowercase();
        definition.number = if seen.contains(&key) {
            None
        } else {
            numbers.get(&key).copied()
        };
        seen.insert(key);
    }
    (references, definitions)
}

struct Open {
    definition: Definition,
    lines: Vec<String>,
    blanks: usize,
}

fn scan_definitions(markdown: &str, masked: &str) -> Vec<Definition> {
    let mut definitions = Vec::new();
    let mut open: Option<Open> = None;
    let close = |open: &mut Option<Open>, definitions: &mut Vec<Definition>| {
        if let Some(mut done) = open.take() {
            done.definition.text = js_trim(&done.lines.join("\n")).to_owned();
            definitions.push(done.definition);
        }
    };

    let mut offset = 0;
    for raw_line in masked.split('\n') {
        let line_start = offset;
        offset += raw_line.len() + 1;
        let length = raw_line.strip_suffix('\r').unwrap_or(raw_line).len();
        let line = &raw_line[..length];
        let source = &markdown[line_start..line_start + length];

        if let Some(marker) = DEFINITION_LINE.captures(line) {
            close(&mut open, &mut definitions);
            let whole = marker.get(0).expect("group 0").end();
            open = Some(Open {
                definition: Definition {
                    label: marker[2].to_owned(),
                    number: None,
                    start: line_start + marker[1].len(),
                    end: line_start + length,
                    text: String::new(),
                },
                lines: vec![source[whole..].to_owned()],
                blanks: 0,
            });
            continue;
        }
        let Some(current) = open.as_mut() else {
            continue;
        };
        if js_trim(line).is_empty() {
            current.blanks += 1;
            continue;
        }
        if current.blanks > 0 && !is_block_indented(line) {
            close(&mut open, &mut definitions);
            continue;
        }
        for _ in 0..current.blanks {
            current.lines.push(String::new());
        }
        current.blanks = 0;
        current
            .lines
            .push(CONTINUATION_INDENT.replace(source, "").into_owned());
        current.definition.end = line_start + length;
    }
    close(&mut open, &mut definitions);
    definitions
}
