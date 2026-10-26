//! Port of `packages/editor-schema/src/parse-markdown.ts`: markdown to blocks
//! with BlockNote 0.51+'s markdown regressions repaired. Each repair is a mask
//! applied before the parse and undone after it; the masks themselves live in
//! the modules of `shared/` and `schema/` this file composes.

use serde_json::{Map, Value as Json};

use crate::markdown::bn::dom_parser::ParseError;
use crate::markdown::bn::html_to_blocks::html_to_blocks_raw;
use crate::markdown::bn::md_to_html::markdown_to_html;
use crate::markdown::frontmatter::js::is_js_whitespace;
use crate::markdown::schema::blocks::toggle::restore_details_markup;
use crate::markdown::schema::cell_code_spaces::{mask_cell_code_spaces, restore_cell_code_spaces};
use crate::markdown::schema::lift_images::lift_images_out_of_text_blocks;
use crate::markdown::schema::link_code_spans::link_code_as_text;
use crate::markdown::schema::link_destinations::{
    mask_link_destinations, restore_link_destinations,
};
use crate::markdown::schema::token_masking::{mask_inline_tokens, restore_inline_tokens};
use crate::markdown::shared::empty_lines::{
    escape_wiki_link_pipes_in_table_rows, fence_indented_code_blocks,
};
use crate::markdown::shared::hard_breaks::{
    mask_hard_breaks, restore_hard_break_spelling, unmask_hard_breaks,
};
use crate::markdown::shared::html_comments::{
    HtmlCommentPart, decode_html_comment_tokens, has_html_comment_token, mask_html_comments,
    split_html_comment_tokens,
};

/// The spellings each mask replaced, by placeholder index.
struct Masks {
    breaks: Vec<String>,
    tokens: Vec<String>,
    spaces: Vec<String>,
    destinations: Vec<String>,
}

/// JS `/\n[^\S\n]/g` replaced by `\n`: a newline followed by one non-newline
/// whitespace character loses that character.
fn strip_break_artifact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        out.push(c);
        if c == '\n'
            && let Some(&next) = chars.peek()
            && next != '\n'
            && is_js_whitespace(next)
        {
            chars.next();
        }
    }
    out
}

/// JS `/^[^\S\n]/` replaced by nothing.
fn strip_leading_break_artifact(text: &str) -> &str {
    match text.chars().next() {
        Some(c) if c != '\n' && is_js_whitespace(c) => &text[c.len_utf8()..],
        _ => text,
    }
}

fn str_field<'a>(run: &'a Json, key: &str) -> Option<&'a str> {
    run.get(key).and_then(Json::as_str)
}

fn is_type(run: &Json, ty: &str) -> bool {
    str_field(run, "type") == Some(ty)
}

/// True when `run` ends its line: a link's soft break lands inside its text.
fn ends_line(run: Option<&Json>) -> bool {
    let Some(run) = run else { return false };
    if is_type(run, "link")
        && let Some(content) = run.get("content").and_then(Json::as_array)
    {
        return ends_line(content.last());
    }
    str_field(run, "text").is_some_and(|t| t.ends_with('\n'))
}

fn unmask_run(text: &str, code: bool, breaks: &[String]) -> String {
    if breaks.is_empty() {
        return text.to_string();
    }
    if code {
        restore_hard_break_spelling(text, breaks)
    } else {
        unmask_hard_breaks(text)
    }
}

fn repair_runs(runs: &mut Vec<Json>, code: bool, masks: &Masks, starts_line: bool) {
    let mut emptied = vec![false; runs.len()];
    for index in 0..runs.len() {
        // Link text is prose too, and a hard break in it carries a token.
        if is_type(&runs[index], "link") {
            if let Some(href) = str_field(&runs[index], "href")
                && !href.is_empty()
            {
                let restored = restore_link_destinations(href, &masks.destinations);
                runs[index]["href"] = Json::String(restored);
            }
            if let Some(Json::Array(inner)) = runs[index].get_mut("content") {
                repair_runs(inner, code, masks, false);
            }
        }
        if !is_type(&runs[index], "text") {
            continue;
        }
        let Some(original) = str_field(&runs[index], "text").map(str::to_string) else {
            continue;
        };
        let code_span = runs[index]
            .get("styles")
            .and_then(|s| s.get("code"))
            .is_some_and(|c| c == &Json::Bool(true));
        let opens_line = (index == 0 && starts_line)
            || (!code_span && ends_line(index.checked_sub(1).map(|i| &runs[i])));
        let mut stripped = original.clone();
        if !code {
            stripped = strip_break_artifact(&stripped);
            if opens_line {
                stripped = strip_leading_break_artifact(&stripped).to_string();
            }
        }
        let unmasked = unmask_run(&stripped, code, &masks.breaks);
        let restored = restore_link_destinations(
            &restore_cell_code_spaces(
                &restore_inline_tokens(&restore_details_markup(&unmasked), &masks.tokens),
                &masks.spaces,
            ),
            &masks.destinations,
        );
        runs[index]["text"] = Json::String(restored);
        if stripped.is_empty() && !original.is_empty() {
            emptied[index] = true;
        }
    }
    // A run that held only the artifact would split the marks around it.
    let mut keep = emptied.into_iter().map(|e| !e);
    runs.retain(|_| keep.next().unwrap_or(true));
}

/// Each HTML comment token turned into an `htmlComment` node. Literal text
/// cannot hold a node, and neither can a link's label, so a token there
/// becomes the comment's own text again.
fn with_html_comment_nodes(runs: Vec<Json>, code: bool) -> Vec<Json> {
    let has_token =
        |run: &Json| has_html_comment_token(&serde_json::to_string(run).unwrap_or_default());
    if !runs.iter().any(has_token) {
        return runs;
    }
    let mut out = Vec::with_capacity(runs.len());
    for mut run in runs {
        if is_type(&run, "link")
            && let Some(Json::Array(inner)) = run.get_mut("content")
        {
            for item in inner.iter_mut() {
                if let Some(text) = str_field(item, "text") {
                    item["text"] = Json::String(decode_html_comment_tokens(text));
                }
            }
            out.push(run);
            continue;
        }
        let text = match (is_type(&run, "text"), str_field(&run, "text")) {
            (true, Some(text)) if has_html_comment_token(text) => text.to_string(),
            _ => {
                out.push(run);
                continue;
            }
        };
        if code {
            run["text"] = Json::String(decode_html_comment_tokens(&text));
            out.push(run);
            continue;
        }
        for part in split_html_comment_tokens(&text) {
            match part {
                HtmlCommentPart::Text { text } => {
                    let mut copy = run.clone();
                    copy["text"] = Json::String(text);
                    out.push(copy);
                }
                HtmlCommentPart::Comment { source } => {
                    let mut props = Map::new();
                    props.insert("source".into(), Json::String(source));
                    let mut node = Map::new();
                    node.insert("type".into(), Json::String("htmlComment".into()));
                    node.insert("props".into(), Json::Object(props));
                    out.push(Json::Object(node));
                }
            }
        }
    }
    out
}

/// BlockNote's `content: 'plain'` kinds: literal text, where a newline followed
/// by a space is the author's indentation.
fn is_literal_text_block(block: &Json) -> bool {
    matches!(str_field(block, "type"), Some("codeBlock" | "diagram"))
}

/// A table cell is a bare run array in the legacy shape and a
/// `{type: 'tableCell', content}` object in BlockNote 0.47+.
fn cell_runs(cell: &mut Json) -> Option<&mut Vec<Json>> {
    match cell {
        Json::Array(runs) => Some(runs),
        Json::Object(map) => match map.get_mut("content") {
            Some(Json::Array(runs)) => Some(runs),
            _ => None,
        },
        _ => None,
    }
}

fn repair_blocks(blocks: &mut [Json], masks: &Masks) {
    for block in blocks {
        let code = is_literal_text_block(block);
        // An image's alt text is a prop, not a run: it gets the author's spelling back.
        if !masks.breaks.is_empty()
            && let Some(Json::Object(props)) = block.get_mut("props")
        {
            for value in props.values_mut() {
                if let Json::String(text) = value {
                    *text = restore_hard_break_spelling(text, &masks.breaks);
                }
            }
        }
        match block.get_mut("content") {
            Some(Json::Array(runs)) => {
                repair_runs(runs, code, masks, true);
                let taken = std::mem::take(runs);
                *runs = with_html_comment_nodes(taken, code);
            }
            Some(Json::Object(table)) => {
                // A table: its runs live two levels down, in the cells.
                if let Some(Json::Array(rows)) = table.get_mut("rows") {
                    for row in rows {
                        let Some(Json::Array(cells)) = row.get_mut("cells") else {
                            continue;
                        };
                        for cell in cells {
                            let Some(runs) = cell_runs(cell) else {
                                continue;
                            };
                            repair_runs(runs, false, masks, true);
                            let taken = std::mem::take(runs);
                            *runs = with_html_comment_nodes(taken, false);
                        }
                    }
                }
            }
            _ => {}
        }
        if let Some(Json::Array(children)) = block.get_mut("children") {
            repair_blocks(children, masks);
        }
    }
}

/// `/!\[|<img\b/i`.
fn has_image_syntax(text: &str) -> bool {
    if text.contains("![") {
        return true;
    }
    has_tag_start(text, "<img")
}

/// `<tag\b` case-insensitively: the tag name followed by a non-word character.
fn has_tag_start(text: &str, tag: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    let mut from = 0;
    while let Some(at) = lower[from..].find(tag) {
        let end = from + at + tag.len();
        match lower[end..].chars().next() {
            Some(c) if c.is_ascii_alphanumeric() || c == '_' => from = end,
            _ => return true,
        }
    }
    false
}

/// `parseMarkdownToBlocksRepaired`. `html_comments: false` parses as builds
/// before #2741 did, dropping every comment.
pub fn parse_markdown_to_blocks_repaired(
    markdown: &str,
    html_comments: bool,
) -> Result<Vec<Json>, ParseError> {
    let comments_masked = if html_comments {
        mask_html_comments(markdown)
    } else {
        markdown.to_string()
    };
    let source =
        fence_indented_code_blocks(&escape_wiki_link_pipes_in_table_rows(&comments_masked));
    let hard = mask_hard_breaks(&source);
    let dest = mask_link_destinations(&hard.markdown);
    let tokens = mask_inline_tokens(&dest.markdown);
    let cells = mask_cell_code_spaces(&tokens.markdown);
    let masked = cells.markdown;

    let link_code = masked.contains('`') && (masked.contains(']') || has_tag_start(&masked, "<a"));
    let images = has_image_syntax(&masked);
    // BlockNote parses markdown by way of this same HTML, so the detour changes
    // nothing but the lifted images and the code in link text.
    let parse_html = if link_code || images {
        let html = markdown_to_html(&masked).ok_or(ParseError::TooDeep)?;
        let lifted = if images {
            lift_images_out_of_text_blocks(&html).unwrap_or(html)
        } else {
            html
        };
        link_code_as_text(&lifted)
    } else {
        markdown_to_html(&masked).ok_or(ParseError::TooDeep)?
    };
    let mut parsed = html_to_blocks_raw(&parse_html)?;
    let masks = Masks {
        breaks: hard.breaks,
        tokens: tokens.tokens,
        spaces: cells.spaces,
        destinations: dest.destinations,
    };
    repair_blocks(&mut parsed, &masks);
    Ok(parsed)
}
