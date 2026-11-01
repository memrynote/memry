//! Port of `packages/app-core/src/markdown.ts`: parse a note into frontmatter
//! and body, serialize it back keeping every unedited byte, and write new files.

use super::js::{is_js_whitespace, js_trim};
use super::split::split_frontmatter_block;
use super::value::{YamlMap, YamlValue};
use super::yaml_dump::safe_dump;
use super::yaml_load::{YamlError, safe_load};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Eol {
    Lf,
    CrLf,
}

impl Eol {
    fn as_str(self) -> &'static str {
        match self {
            Eol::Lf => "\n",
            Eol::CrLf => "\r\n",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedMarkdownNote {
    /// What gray-matter's `data` holds: a map for every note a person writes, and
    /// the loaded value itself when the YAML top level is a list or a scalar. No
    /// document, `null` and `~` all become an empty map (gray-matter's
    /// `file.data == null` rule).
    pub frontmatter: YamlValue,
    /// Raw body substring, never trimmed: `raw_frontmatter_block + content` is the file.
    pub content: String,
    pub raw_frontmatter_block: Option<String>,
    pub eol: Eol,
    pub had_trailing_newline: bool,
}

/// `file.matter.replace(/^\s*#[^\n]+/gm, '').trim() === ''`: nothing but
/// comment lines and whitespace.
fn matter_is_blank(matter: &str) -> bool {
    let chars: Vec<char> = matter.chars().collect();
    let mut kept = String::new();
    let mut i = 0;
    while i < chars.len() {
        if i == 0 || chars[i - 1] == '\n' {
            let mut j = i;
            while j < chars.len() && is_js_whitespace(chars[j]) {
                j += 1;
            }
            if chars.get(j) == Some(&'#') && chars.get(j + 1).is_some_and(|c| *c != '\n') {
                let mut end = j + 1;
                while end < chars.len() && chars[end] != '\n' {
                    end += 1;
                }
                i = end;
                continue;
            }
        }
        kept.push(chars[i]);
        i += 1;
    }
    js_trim(&kept).is_empty()
}

/// gray-matter's split of a text (`parseMatter`), after a leading byte-order mark: the raw
/// frontmatter (`file.matter`) and the text after its closing delimiter (`file.content`), or
/// `None` when the text does not open with a frontmatter delimiter. An unclosed block runs to
/// the end of the text and leaves no content.
pub fn gray_matter_parts(text: &str) -> Option<(&str, &str)> {
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    let after_open = text.strip_prefix("---")?;
    if after_open.starts_with('-') {
        return None;
    }
    let Some(close) = after_open.find("\n---") else {
        return Some((after_open, ""));
    };
    // The rest of the closing line is content, less one line break.
    let content = &after_open[close + "\n---".len()..];
    let content = content.strip_prefix('\r').unwrap_or(content);
    let content = content.strip_prefix('\n').unwrap_or(content);
    Some((&after_open[..close], content))
}

/// `matter(text, {}).data`, for a block the splitter produced or for a whole file read with
/// gray-matter directly: an unclosed block runs to the end of the text, as in gray-matter.
pub fn gray_matter_data(block: &str) -> Result<YamlValue, YamlError> {
    let empty = || YamlValue::map(YamlMap::new());
    let Some((matter, _)) = gray_matter_parts(block) else {
        return Ok(empty());
    };
    if matter_is_blank(matter) {
        return Ok(empty());
    }
    Ok(match safe_load(matter)? {
        None | Some(YamlValue::Null) => empty(),
        Some(value) => value,
    })
}

pub fn parse_markdown_note(raw: &str) -> Result<ParsedMarkdownNote, YamlError> {
    let split = split_frontmatter_block(raw);
    let frontmatter = match split.block {
        Some(block) => gray_matter_data(block)?,
        None => YamlValue::map(YamlMap::new()),
    };
    Ok(ParsedMarkdownNote {
        frontmatter,
        content: split.body.to_owned(),
        raw_frontmatter_block: split.block.map(str::to_owned),
        eol: if raw.contains("\r\n") {
            Eol::CrLf
        } else {
            Eol::Lf
        },
        had_trailing_newline: raw.ends_with('\n'),
    })
}

/// Linear-time trailing-newline strip.
fn strip_trailing_newlines(value: &str) -> &str {
    let bytes = value.as_bytes();
    let mut end = bytes.len();
    while end > 0 && bytes[end - 1] == b'\n' {
        end -= 1;
        if end > 0 && bytes[end - 1] == b'\r' {
            end -= 1;
        }
    }
    &value[..end]
}

/// `/^(?:\r?\n)*/` length.
fn leading_newlines(value: &str) -> usize {
    let bytes = value.as_bytes();
    let mut at = 0;
    loop {
        if bytes.get(at) == Some(&b'\n') {
            at += 1;
        } else if bytes.get(at) == Some(&b'\r') && bytes.get(at + 1) == Some(&b'\n') {
            at += 2;
        } else {
            return at;
        }
    }
}

/// `content.replace(/\r?\n/g, eol)`.
fn convert_newlines(content: &str, eol: Eol) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(at) = rest.find('\n') {
        let line = &rest[..at];
        out.push_str(line.strip_suffix('\r').unwrap_or(line));
        out.push_str(eol.as_str());
        rest = &rest[at + 1..];
    }
    out.push_str(rest);
    out
}

/// `Object.entries(value)` as a map, for the edited path.
pub(super) fn entries_of(value: &YamlValue) -> YamlMap {
    match value {
        YamlValue::Map(map) => (**map).clone(),
        YamlValue::Seq(items) => {
            let mut map = YamlMap::new();
            for (index, item) in items.iter().enumerate() {
                map.insert(index.to_string(), item.clone());
            }
            map
        }
        YamlValue::String(text) => {
            let mut map = YamlMap::new();
            for (index, c) in text.encode_utf16().enumerate() {
                map.insert(
                    index.to_string(),
                    YamlValue::String(String::from_utf16_lossy(&[c])),
                );
            }
            map
        }
        _ => YamlMap::new(),
    }
}

/// Serialize an existing note back to file content. Unedited parts stay
/// byte-identical; see the TypeScript for the edited-body rules. A block that
/// ends the file takes the file's line end before a body (`join`).
pub fn serialize_parsed_markdown_note(
    parsed: &ParsedMarkdownNote,
    content: &str,
    frontmatter_edited: bool,
) -> Result<String, YamlError> {
    let block = if frontmatter_edited {
        stringify_frontmatter_block(&entries_of(&parsed.frontmatter), parsed.eol)?
    } else {
        parsed.raw_frontmatter_block.clone().unwrap_or_default()
    };
    if content == parsed.content {
        return Ok(join(block, content, parsed.eol));
    }
    let mut body = strip_trailing_newlines(&convert_newlines(content, parsed.eol)).to_owned();
    if parsed.had_trailing_newline {
        body.push_str(parsed.eol.as_str());
    }
    if block.is_empty() {
        return Ok(body);
    }
    let separator = &parsed.content[..leading_newlines(&parsed.content)];
    let trimmed = &body[leading_newlines(&body)..];
    Ok(join(block, &format!("{separator}{trimmed}"), parsed.eol))
}

/// The block, then the body. A block that ended its file has no line end after its closing
/// fence; the file's line end goes there before a body, or the fence runs into the body and
/// the whole block reads back as body text (#3800).
fn join(mut block: String, body: &str, eol: Eol) -> String {
    if !block.is_empty() && !body.is_empty() && !block.ends_with('\n') {
        // A fence line that ends in a lone `\r` takes the `\n` that makes it a line end.
        block.push_str(if block.ends_with('\r') {
            "\n"
        } else {
            eol.as_str()
        });
    }
    block.push_str(body);
    block
}

/// Obsidian-style emitter for the EDITED-frontmatter path. No keys, no block.
/// Quoting, line width and scalar spelling are whatever js-yaml defaults
/// produce; only the unedited path carries a byte guarantee.
pub fn stringify_frontmatter_block(frontmatter: &YamlMap, eol: Eol) -> Result<String, YamlError> {
    if frontmatter.is_empty() {
        return Ok(String::new());
    }
    let matter = safe_dump(&YamlValue::map(frontmatter.clone()))?;
    let matter = js_trim(&matter);
    let newline = |text: &str| {
        if text.ends_with('\n') {
            text.to_owned()
        } else {
            format!("{text}\n")
        }
    };
    // gray-matter: `---\n<yaml>\n---\n` plus `newline('')` for the empty body.
    let block = if matter == "{}" {
        "\n".to_owned()
    } else {
        format!("{}{}{}\n", newline("---"), newline(matter), newline("---"))
    };
    let converted = match eol {
        Eol::Lf => block,
        Eol::CrLf => block.replace('\n', "\r\n"),
    };
    Ok(format!(
        "{}{}",
        strip_trailing_newlines(&converted),
        eol.as_str()
    ))
}

/// Serialize a NEW file: LF endings, one trailing newline.
pub fn write_markdown_note(frontmatter: &YamlMap, content: &str) -> Result<String, YamlError> {
    let body = strip_trailing_newlines(content);
    let block = stringify_frontmatter_block(frontmatter, Eol::Lf)?;
    if block.is_empty() {
        return Ok(if body.is_empty() {
            String::new()
        } else {
            format!("{body}\n")
        });
    }
    if body.is_empty() {
        Ok(block)
    } else {
        Ok(format!("{block}{body}\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The verbatim path joins as the edited-body path does (the `block-at-eof-*` cases of
    /// `markdown-convert/frontmatter.json`), for a block that ends without a line end ahead of
    /// a body no parse of a file gives it (#3800).
    #[test]
    fn the_verbatim_path_puts_a_line_end_after_the_fence() {
        let parsed = ParsedMarkdownNote {
            frontmatter: YamlValue::map(YamlMap::new()),
            content: "kept\n".to_owned(),
            raw_frontmatter_block: Some("---\r\nmood: ok\r\n---".to_owned()),
            eol: Eol::CrLf,
            had_trailing_newline: true,
        };
        assert_eq!(
            serialize_parsed_markdown_note(&parsed, "kept\n", false).unwrap(),
            "---\r\nmood: ok\r\n---\r\nkept\n"
        );
    }
}
