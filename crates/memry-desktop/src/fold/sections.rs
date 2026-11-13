//! Markdown to sections and chunks (`engine.ts` `parseSections`, `buildSections`). Code,
//! tables, images, embeds, callouts and HTML-only lines never become paragraphs; each is
//! recorded in its section's `skipped` markers instead.

use std::sync::LazyLock;

use crate::web::extract::utils::js::{is_js_whitespace, trim as js_trim};
use regex::Regex;
use unicode_normalization::UnicodeNormalization as _;

use super::inline::{sentences_to_markdown, strip_inline};
use super::text::{estimate_tokens, sha256, split_sentences};
use super::{FoldSkipped, SkippedKind};

/// About this many tokens per chunk before a long section is split at a paragraph boundary.
pub const CHUNK_TOKEN_BUDGET: u32 = 600;

// `\s` and `.` as JavaScript reads them.
const WS: &str = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";
const DOT: &str = r"[^\n\r\x{2028}\x{2029}]";

fn regex(pattern: &str) -> Regex {
    Regex::new(&pattern.replace("\\s", WS).replace("DOT", DOT)).expect("fold section pattern")
}

static FRONTMATTER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\A\x{FEFF}?---\r?\n(?s:.*?)\r?\n---\r?\n?").expect("front"));
static FENCE: LazyLock<Regex> = LazyLock::new(|| regex(r"^\s*(```+|~~~+)"));
static HEADING: LazyLock<Regex> = LazyLock::new(|| regex(r"^#{1,6}\s+(DOT*?)\s*#*\s*$"));
static TABLE: LazyLock<Regex> = LazyLock::new(|| regex(r"^\s*\|"));
static IMAGE_LINE: LazyLock<Regex> = LazyLock::new(|| regex(r"^\s*!\[[^\]]*\]\([^)]*\)\s*$"));
static EMBED_LINE: LazyLock<Regex> = LazyLock::new(|| regex(r"^\s*!\[\[[^\]]*\]\]\s*$"));
static HTML_LINE: LazyLock<Regex> = LazyLock::new(|| regex(r"^\s*</?[A-Za-z][^>]*>\s*$"));
static CALLOUT: LazyLock<Regex> = LazyLock::new(|| regex(r"^\s*>\s*\[!"));
static LIST_MARKER: LazyLock<Regex> =
    LazyLock::new(|| regex(r"^\s*(?:[-*+]|[0-9]+[.)])\s+(?:\[[ xX]\]\s+)?"));
static QUOTE: LazyLock<Regex> = LazyLock::new(|| regex(r"^\s*>\s?"));
static SENTENCE_END: LazyLock<Regex> = LazyLock::new(|| regex(r#"[.!?…。！？:;]["'”’)\]*_`]*$"#));

#[derive(Clone)]
pub struct ParsedParagraph {
    pub hash: String,
    pub text: String,
    pub sentences: Vec<String>,
    /// Inline Markdown per sentence; never hashed.
    pub sentences_md: Vec<String>,
}

#[derive(Clone)]
pub struct ParsedChunk {
    /// Hash of the heading and the paragraph hashes: the cache key, with language and writer.
    pub hash: String,
    pub heading: Option<String>,
    pub paragraphs: Vec<ParsedParagraph>,
}

pub struct ParsedSection {
    pub heading: Option<String>,
    pub chunks: Vec<ParsedChunk>,
    pub skipped: Vec<FoldSkipped>,
}

struct RawParagraph {
    /// Plain text: what is hashed.
    text: String,
    /// The paragraph's Markdown with list and quote markers removed.
    md: String,
}

#[derive(Default)]
struct RawSection {
    heading: Option<String>,
    paragraphs: Vec<RawParagraph>,
    skipped: Vec<FoldSkipped>,
}

/// A list item is its own sentence: without a full stop the splitter would run every item of
/// the list into one.
fn end_sentence(item: &str) -> String {
    let trimmed = item.trim_end_matches(is_js_whitespace);
    if trimmed.is_empty() || SENTENCE_END.is_match(trimmed) {
        trimmed.to_owned()
    } else {
        format!("{trimmed}.")
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Run {
    Table,
    Other,
}

#[derive(Default)]
struct Parser {
    sections: Vec<RawSection>,
    current: RawSection,
    buffer: Vec<String>,
    skip_block: bool,
}

impl Parser {
    fn flush(&mut self) {
        if !self.buffer.is_empty() {
            let md = self.buffer.join(" ");
            let text = strip_inline(&md);
            if !text.is_empty() {
                self.current.paragraphs.push(RawParagraph { text, md });
            }
        }
        self.buffer.clear();
        self.skip_block = false;
    }

    fn close_section(&mut self) {
        let done = std::mem::take(&mut self.current);
        if done.heading.is_some() || !done.paragraphs.is_empty() {
            self.sections.push(done);
        }
    }

    fn start_section(&mut self, heading: String) {
        self.flush();
        self.close_section();
        self.current.heading = Some(heading);
    }

    fn skip(&mut self, kind: SkippedKind) {
        self.flush();
        let after_paragraph = self.current.paragraphs.len() as i32 - 1;
        match self.current.skipped.last_mut() {
            Some(last) if last.after_paragraph == after_paragraph && last.kind == kind => {
                last.count += 1;
            }
            _ => self.current.skipped.push(FoldSkipped {
                after_paragraph,
                kind,
                count: 1,
            }),
        }
    }
}

fn parse_sections(markdown: &str) -> Vec<RawSection> {
    let body = FRONTMATTER.replace(markdown, "");
    let mut p = Parser::default();
    let mut fence: Option<String> = None;
    // Table and HTML lines come in runs that count as one block.
    let mut run: Option<Run> = None;
    for raw in body.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        let line = raw.trim_end_matches(is_js_whitespace);
        let previous_run = run.take();
        let fence_match = FENCE.captures(line).map(|c| c[1].to_owned());
        if let Some(open) = &fence {
            if fence_match.is_some() && js_trim(line).starts_with(open.as_str()) {
                fence = None;
            }
            continue;
        }
        if let Some(open) = fence_match {
            p.skip(SkippedKind::Code);
            fence = Some(open);
            continue;
        }
        if js_trim(line).is_empty() {
            p.flush();
            continue;
        }
        if let Some(heading) = HEADING.captures(line) {
            p.start_section(strip_inline(&heading[1]));
            continue;
        }
        if TABLE.is_match(line) {
            if previous_run == Some(Run::Table) {
                p.flush();
            } else {
                p.skip(SkippedKind::Table);
            }
            run = Some(Run::Table);
            continue;
        }
        if IMAGE_LINE.is_match(line) {
            p.skip(SkippedKind::Image);
            continue;
        }
        if EMBED_LINE.is_match(line) {
            p.skip(SkippedKind::Embed);
            continue;
        }
        if HTML_LINE.is_match(line) {
            if previous_run == Some(Run::Other) {
                p.flush();
            } else {
                p.skip(SkippedKind::Other);
            }
            run = Some(Run::Other);
            continue;
        }
        if CALLOUT.is_match(line) {
            p.skip(SkippedKind::Callout);
            p.skip_block = true;
            continue;
        }
        if p.skip_block {
            continue;
        }
        let item = match LIST_MARKER.find(line) {
            Some(marker) => end_sentence(&line[marker.end()..]),
            None => QUOTE.replace(line, "").into_owned(),
        };
        p.buffer.push(item);
    }
    p.flush();
    p.close_section();
    p.sections
}

fn chunk_hash(heading: &str, paragraphs: &[ParsedParagraph]) -> String {
    let mut parts = vec![heading];
    parts.extend(paragraphs.iter().map(|p| p.hash.as_str()));
    sha256(&parts.join("\u{0}"))
}

/// Heading and paragraphs, split at paragraph boundaries past the token budget.
pub fn build_sections(markdown: &str, language: &str) -> Vec<ParsedSection> {
    parse_sections(markdown)
        .into_iter()
        .filter_map(|raw| {
            let mut groups: Vec<Vec<ParsedParagraph>> = Vec::new();
            let mut group = Vec::new();
            let mut tokens = 0;
            for RawParagraph { text, md } in raw.paragraphs {
                let t = estimate_tokens(&text, language);
                if !group.is_empty() && tokens + t > CHUNK_TOKEN_BUDGET {
                    groups.push(std::mem::take(&mut group));
                    tokens = 0;
                }
                let sentences = split_sentences(&text);
                group.push(ParsedParagraph {
                    hash: sha256(&text.nfc().collect::<String>()),
                    sentences_md: sentences_to_markdown(&md, &text, &sentences),
                    sentences,
                    text,
                });
                tokens += t;
            }
            if !group.is_empty() {
                groups.push(group);
            }
            let chunks: Vec<ParsedChunk> = groups
                .into_iter()
                .enumerate()
                .map(|(i, paragraphs)| {
                    let heading = if i == 0 { raw.heading.clone() } else { None };
                    ParsedChunk {
                        hash: chunk_hash(heading.as_deref().unwrap_or(""), &paragraphs),
                        heading,
                        paragraphs,
                    }
                })
                .collect();
            (!chunks.is_empty()).then_some(ParsedSection {
                heading: raw.heading,
                chunks,
                skipped: raw.skipped,
            })
        })
        .collect()
}
