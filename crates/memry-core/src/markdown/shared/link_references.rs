//! Port of `packages/shared/src/link-references.ts`: reference-style links,
//! stripped before the parse and put back after it (#1909).
//!
//! Not ported: `writeLinkReferencesToYDoc` and `readLinkReferencesFromYDoc`, which
//! touch a Y.Doc (stage 6). Their array names are the constants below.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::markdown::frontmatter::js::{is_js_whitespace, js_trim};
use crate::markdown::shared::markdown_fences::FenceTracker;

pub const LINK_REFERENCE_DEFINITIONS_ARRAY: &str = "linkReferenceDefinitions";
pub const LINK_REFERENCE_USAGES_ARRAY: &str = "linkReferenceUsages";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkReferenceDefinition {
    /// Case-folded, whitespace-collapsed label: the key a usage matches on.
    pub label: String,
    /// Destination with any angle brackets removed, as the parsed link carries it.
    pub destination: String,
    /// The author's definition line, byte for byte, title and all.
    pub raw: String,
    /// Blank lines between the previous definition and this one when the two were
    /// adjacent. `None` when something else sat between them.
    pub gap_before: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkReferenceUsage {
    pub label: String,
    pub destination: String,
    /// The link text as written, which is what the serialized inline link carries.
    pub text: String,
    /// The author's reference span: `[docs][d]`, `[docs][]` or `[docs]`.
    pub raw: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrippedLinkReferences {
    /// The body with every definition line removed.
    pub markdown: String,
    pub definitions: Vec<LinkReferenceDefinition>,
    pub usages: Vec<LinkReferenceUsage>,
}

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `label.trim().replace(/\s+/g, ' ').toLowerCase()`.
pub fn normalize_link_reference_label(label: &str) -> String {
    let mut out = String::new();
    let mut in_space = false;
    for c in js_trim(label).chars() {
        if is_js_whitespace(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            in_space = false;
            out.push(c);
        }
    }
    out.to_lowercase()
}

/// The tail of `DEFINITION_LINE` after the destination:
/// `(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^()]*\)))?[ \t]*$`.
fn definition_tail_matches(rest: &str) -> bool {
    let blanks = |s: &str| s.trim_start_matches([' ', '\t']).len();
    let after_blanks = &rest[rest.len() - blanks(rest)..];
    if after_blanks.len() == rest.len() {
        return rest.is_empty();
    }
    if after_blanks.is_empty() {
        return true;
    }
    let title_end = match after_blanks.as_bytes()[0] {
        b'"' => after_blanks[1..].find('"'),
        b'\'' => after_blanks[1..].find('\''),
        b'(' => after_blanks[1..]
            .find(['(', ')'])
            .filter(|n| after_blanks.as_bytes()[n + 1] == b')'),
        _ => None,
    };
    title_end.is_some_and(|n| {
        let after_title = &after_blanks[n + 2..];
        after_title.trim_start_matches([' ', '\t']).is_empty()
    })
}

/// `DEFINITION_LINE`: `^ {0,3}\[(?!\^)((?:[^\\[\]]|\\.)+)\]:[ \t]*(<[^<>]*>|\S+)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^()]*\)))?[ \t]*$`.
/// Returns the label and the destination as written.
fn match_definition_line(line: &str) -> Option<(&str, &str)> {
    let spaces = line.bytes().take_while(|b| *b == b' ').count().min(3);
    let rest = line[spaces..].strip_prefix('[')?;
    if rest.starts_with('^') {
        return None;
    }
    let mut chars = rest.char_indices();
    let mut label_end = None;
    while let Some((at, c)) = chars.next() {
        match c {
            '\\' => {
                let (_, escaped) = chars.next()?;
                if is_line_terminator(escaped) {
                    return None;
                }
            }
            '[' => return None,
            ']' => {
                label_end = Some(at);
                break;
            }
            _ => {}
        }
    }
    let label_end = label_end?;
    if label_end == 0 {
        return None;
    }
    let label = &rest[..label_end];
    let after = rest[label_end + 1..].strip_prefix(':')?;
    let after = after.trim_start_matches([' ', '\t']);

    if after.starts_with('<')
        && let Some(close) = after[1..].find(['<', '>'])
        && after.as_bytes()[close + 1] == b'>'
    {
        let destination = &after[..close + 2];
        if definition_tail_matches(&after[close + 2..]) {
            return Some((label, destination));
        }
    }
    let end = after.find(is_js_whitespace).unwrap_or(after.len());
    if end == 0 || !definition_tail_matches(&after[end..]) {
        return None;
    }
    Some((label, &after[..end]))
}

fn count_blank_run(lines: &[&str], from: usize, to: usize) -> Option<usize> {
    if lines[from..to].iter().any(|line| !js_trim(line).is_empty()) {
        return None;
    }
    Some(to - from)
}

/// `stripLinkReferenceDefinitions`.
pub fn strip_link_reference_definitions(markdown: &str) -> StrippedLinkReferences {
    let unchanged = || StrippedLinkReferences {
        markdown: markdown.to_owned(),
        definitions: Vec::new(),
        usages: Vec::new(),
    };
    if !markdown.contains("]:") {
        return unchanged();
    }

    let lines: Vec<&str> = markdown.split('\n').collect();
    let mut fences = FenceTracker::new();
    let mut definitions: Vec<LinkReferenceDefinition> = Vec::new();
    let mut kept: Vec<&str> = Vec::new();
    // A definition has to start a block: a matching line in the middle of a
    // paragraph is a continuation line and stays the author's prose.
    let mut previous_line_opens_a_block = true;
    let mut previous_definition_line: Option<usize> = None;

    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        let in_fence = fences.consume(line);
        let found = if in_fence {
            None
        } else {
            match_definition_line(line)
        };

        let Some((label, destination)) = found.filter(|_| previous_line_opens_a_block) else {
            kept.push(line);
            previous_line_opens_a_block = !in_fence && js_trim(line).is_empty();
            index += 1;
            continue;
        };

        let blanks_since_previous =
            previous_definition_line.and_then(|prev| count_blank_run(&lines, prev + 1, index));
        definitions.push(LinkReferenceDefinition {
            label: normalize_link_reference_label(label),
            destination: strip_angle_brackets(destination),
            raw: line.to_owned(),
            gap_before: blanks_since_previous,
        });
        previous_definition_line = Some(index);

        // Drop the blank line the definition leaves behind, so removing it does not
        // grow the document by an empty paragraph the author never wrote.
        if kept.last().is_some_and(|last| js_trim(last).is_empty())
            && lines
                .get(index + 1)
                .is_some_and(|next| js_trim(next).is_empty())
        {
            index += 1;
        }
        previous_line_opens_a_block = true;
        index += 1;
    }

    if definitions.is_empty() {
        return unchanged();
    }
    let usages = collect_usages(&kept, &definitions);
    StrippedLinkReferences {
        markdown: kept.join("\n"),
        definitions,
        usages,
    }
}

/// `destination.replace(/^<|>$/g, '')`.
fn strip_angle_brackets(destination: &str) -> String {
    let inner = destination.strip_prefix('<').unwrap_or(destination);
    inner.strip_suffix('>').unwrap_or(inner).to_owned()
}

/// A destination is only bare if it can be read back as one. A space or an
/// unbalanced paren would end the link early, so those go in angle brackets.
fn wrap_destination(destination: &str) -> String {
    if destination
        .chars()
        .any(|c| is_js_whitespace(c) || c == '(' || c == ')')
    {
        format!("<{destination}>")
    } else {
        destination.to_owned()
    }
}

/// `inlineLinkReferences`: every reference usage as the inline link it means.
pub fn inline_link_references(markdown: &str, usages: &[LinkReferenceUsage]) -> String {
    if usages.is_empty() {
        return markdown.to_owned();
    }
    let mut body = markdown.to_owned();
    let mut search_from = 0;
    for usage in usages {
        let Some(at) = find_from(&body, &usage.raw, search_from) else {
            continue;
        };
        let inline = format!("[{}]({})", usage.text, wrap_destination(&usage.destination));
        body.replace_range(at..at + usage.raw.len(), &inline);
        search_from = at + inline.len();
    }
    body
}

/// `String#indexOf(needle, from)` with byte offsets; `from` past the end finds nothing.
fn find_from(haystack: &str, needle: &str, from: usize) -> Option<usize> {
    haystack.get(from..)?.find(needle).map(|n| from + n)
}

/// `restoreLinkReferences`: the author's spans back, then every definition at the end.
pub fn restore_link_references(
    markdown: &str,
    definitions: &[LinkReferenceDefinition],
    usages: &[LinkReferenceUsage],
) -> String {
    if definitions.is_empty() {
        return markdown.to_owned();
    }
    let mut body = markdown.to_owned();
    let mut search_from = 0;
    for usage in usages {
        for needle in [
            format!("[{}]({})", usage.text, usage.destination),
            format!("[{}](<{}>)", usage.text, usage.destination),
        ] {
            let Some(at) = find_from(&body, &needle, search_from) else {
                continue;
            };
            if at > 0 && body.as_bytes()[at - 1] == b'!' {
                continue;
            }
            body.replace_range(at..at + needle.len(), &usage.raw);
            search_from = at + usage.raw.len();
            break;
        }
    }

    let mut block = String::new();
    for (index, definition) in definitions.iter().enumerate() {
        if index > 0 {
            block.push_str(&"\n".repeat(definition.gap_before.unwrap_or(1) + 1));
        }
        block.push_str(&definition.raw);
    }

    let trimmed = body.trim_end_matches('\n');
    if trimmed.is_empty() {
        block
    } else {
        format!("{trimmed}\n\n{block}")
    }
}

fn collect_usages(
    lines: &[&str],
    definitions: &[LinkReferenceDefinition],
) -> Vec<LinkReferenceUsage> {
    // `new Map(...)`: a later definition of a label replaces an earlier one.
    let by_label: HashMap<&str, &LinkReferenceDefinition> = definitions
        .iter()
        .map(|definition| (definition.label.as_str(), definition))
        .collect();
    let mut fences = FenceTracker::new();
    let mut usages = Vec::new();

    for line in lines {
        if fences.consume(line) {
            continue;
        }
        let chars: Vec<char> = line.chars().collect();
        for span in find_reference_spans(&chars) {
            if span.image || span.tail.as_deref() == Some("(") {
                continue;
            }
            // `[[wiki]]` is not two shortcut references.
            if span.index > 0 && chars[span.index - 1] == '[' {
                continue;
            }
            if chars.get(span.index + span.raw.chars().count()) == Some(&']') {
                continue;
            }
            let from_reference =
                normalize_link_reference_label(span.reference.as_deref().unwrap_or(""));
            let label = if from_reference.is_empty() {
                normalize_link_reference_label(&span.text)
            } else {
                from_reference
            };
            let Some(definition) = by_label.get(label.as_str()) else {
                continue;
            };
            usages.push(LinkReferenceUsage {
                label,
                destination: definition.destination.clone(),
                text: span.text,
                raw: span.raw,
            });
        }
    }
    usages
}

struct ReferenceSpan {
    /// Offset of the whole span, `!` included, in the line (in characters).
    index: usize,
    raw: String,
    image: bool,
    text: String,
    reference: Option<String>,
    tail: Option<String>,
}

/// For every offset in the line, where `(?:[^\\[\]]|\\.)*` stops if it starts there.
fn bracket_run_ends(line: &[char]) -> Vec<usize> {
    let mut ends = vec![0; line.len() + 1];
    ends[line.len()] = line.len();
    for index in (0..line.len()).rev() {
        ends[index] = match line[index] {
            '[' | ']' => index,
            '\\' => match line.get(index + 1) {
                Some(next) if !is_line_terminator(*next) => ends[index + 2],
                _ => index,
            },
            _ => ends[index + 1],
        };
    }
    ends
}

fn slice(line: &[char], from: usize, to: usize) -> String {
    line[from..to].iter().collect()
}

/// Every `[…]` span in one line, left to right, non-overlapping.
fn find_reference_spans(line: &[char]) -> Vec<ReferenceSpan> {
    if !line.contains(&'[') {
        return Vec::new();
    }
    let run_ends = bracket_run_ends(line);
    let mut spans = Vec::new();
    let mut from = 0;

    while from < line.len() {
        let Some(open) = line[from..]
            .iter()
            .position(|c| *c == '[')
            .map(|n| from + n)
        else {
            break;
        };
        let text_end = run_ends[open + 1];
        if line.get(text_end) != Some(&']') {
            from = open + 1;
            continue;
        }

        let image = open > from && line[open - 1] == '!';
        let mut end = text_end + 1;
        let mut reference = None;
        let mut tail = None;

        match line.get(end) {
            Some('[') => {
                let label_end = run_ends[end + 1];
                if line.get(label_end) == Some(&']') {
                    reference = Some(slice(line, end + 1, label_end));
                    tail = Some(slice(line, end, label_end + 1));
                    end = label_end + 1;
                }
            }
            Some('(') => {
                tail = Some("(".to_owned());
                end += 1;
            }
            _ => {}
        }

        let index = if image { open - 1 } else { open };
        spans.push(ReferenceSpan {
            index,
            raw: slice(line, index, end),
            image,
            text: slice(line, open + 1, text_end),
            reference,
            tail,
        });
        from = end;
    }
    spans
}
