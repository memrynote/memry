//! The block-level layers of `markdownToBlocks` in `blocknote-converter.ts`:
//! column and toggle regions, blank-line gaps, marker lines, nesting markers
//! and the callout, math and quote claims, down to BlockNote's own parse.

use serde_json::{Map, Value as Json, json};
use url::Url;

use super::{BlockSerializer, ConvertError, EmbedResolver};
use crate::markdown::frontmatter::js::js_trim;
use crate::markdown::schema::blocks::callout::{read_callout_run, resolve_callout_run};
use crate::markdown::schema::blocks::embeds::{
    bookmark_line_url, parse_whiteboard_line, parse_youtube_embed_line,
};
use crate::markdown::schema::blocks::file::{is_file_block_line, parse_file_block_marker};
use crate::markdown::schema::blocks::math::read_math_run;
use crate::markdown::schema::blocks::toggle::{ToggleContentSegment, split_markdown_by_toggles};
use crate::markdown::schema::callout_types::CalloutTypes;
use crate::markdown::schema::columns::{
    ColumnContentSegment, build_column_list_block, split_markdown_by_column_regions,
};
use crate::markdown::schema::parse_markdown::parse_markdown_to_blocks_repaired;
use crate::markdown::schema::quote::{
    content_or_empty, read_structured_quote_run, resolve_quote_run,
};
use crate::markdown::shared::block_colors::parse_block_colors_marker;
use crate::markdown::shared::block_markers::{SidecarPatch, parse_sidecar_marker_line};
use crate::markdown::shared::block_nesting::{
    fold_block_nesting_markers, is_block_nesting_marker, parse_markdown_with_nesting_markers,
};
use crate::markdown::shared::empty_lines::{
    MarkdownSegment, extract_wiki_image_embed_refs, rewrite_wiki_image_embeds,
    separate_block_images, split_markdown_preserving_blanks,
};
use crate::markdown::shared::html_comments::mask_html_comments;
use crate::markdown::shared::inline_colors::{apply_inline_color_tokens, mask_inline_color_spans};
use crate::markdown::shared::markdown_fences::FenceTracker;

/// Everything `markdownToBlocks` reads besides the markdown.
pub struct BodyParser<'a> {
    pub callout_types: &'a CalloutTypes,
    pub embeds: &'a dyn EmbedResolver,
    pub serializer: &'a dyn BlockSerializer,
    /// False parses as builds before #2741 did, dropping every HTML comment
    /// (`parsesHtmlComments()`).
    pub html_comments: bool,
}

fn empty_paragraph() -> Json {
    json!({"type": "paragraph", "content": [], "children": [], "props": {}})
}

fn push_gap(blocks: &mut Vec<Json>, extra_lines: usize) {
    blocks.extend((0..extra_lines).map(|_| empty_paragraph()));
}

fn block_of(kind: &str, props: Json, content: Option<Json>, children: Option<Vec<Json>>) -> Json {
    let mut block = Map::new();
    block.insert("type".into(), json!(kind));
    block.insert("props".into(), props);
    if let Some(content) = content {
        block.insert("content".into(), content);
    }
    if let Some(children) = children {
        block.insert("children".into(), Json::Array(children));
    }
    Json::Object(block)
}

/// `parseHttpUrl(url)?.hostname` for http and https URLs.
fn http_hostname(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    matches!(parsed.scheme(), "http" | "https").then_some(())?;
    Some(parsed.host_str().unwrap_or("").to_owned())
}

/// `parseCustomBlockMarkerLine`: the custom blocks whose on-disk form is one
/// marker line. `file` matches on the trimmed line, the image markers on the raw one.
fn parse_custom_block_marker_line(line: &str) -> Option<Json> {
    let trimmed = js_trim(line);
    if is_file_block_line(trimmed)
        && let Some(props) = parse_file_block_marker(trimmed)
    {
        return Some(block_of("file", props, None, None));
    }
    if let Some(embed) = parse_youtube_embed_line(line) {
        let props =
            json!({"videoId": embed.video_id, "videoUrl": embed.video_url, "alt": embed.alt});
        return Some(block_of("youtubeEmbed", props, None, None));
    }
    if let Some(url) = bookmark_line_url(line)
        && let Some(host) = http_hostname(url)
    {
        let domain = host.strip_prefix("www.").unwrap_or(&host);
        return Some(block_of(
            "bookmark",
            json!({"url": url, "domain": domain}),
            None,
            None,
        ));
    }
    if let Some(canvas_id) = parse_whiteboard_line(line).filter(|id| !id.is_empty()) {
        return Some(block_of(
            "whiteboard",
            json!({"canvasId": canvas_id}),
            None,
            None,
        ));
    }
    None
}

impl BodyParser<'_> {
    /// `parseMarkdownToBlocks(editor, md)`.
    fn parse_md(&self, markdown: &str) -> Result<Vec<Json>, ConvertError> {
        Ok(parse_markdown_to_blocks_repaired(
            markdown,
            self.html_comments,
        )?)
    }

    /// `resolveWikiImageEmbedsInMarkdown`.
    fn resolve_embeds(&self, markdown: &str, note_path: Option<&str>) -> String {
        if extract_wiki_image_embed_refs(markdown).is_empty() {
            return markdown.to_owned();
        }
        rewrite_wiki_image_embeds(markdown, &mut |target| {
            self.embeds.resolve(target, note_path)
        })
    }

    /// `markdownToBlocks`: `None` for the whole note is an `Err`.
    pub fn markdown_to_blocks(
        &self,
        markdown: &str,
        note_path: Option<&str>,
    ) -> Result<Vec<Json>, ConvertError> {
        // HTML comments come off before anything splits the note into lines, so a
        // multi-line comment holding blank lines or a fence stays one comment.
        let masked = if self.html_comments {
            mask_html_comments(markdown)
        } else {
            markdown.to_owned()
        };
        let with_embeds = self.resolve_embeds(&masked, note_path);
        let colored = mask_inline_color_spans(&separate_block_images(&with_embeds));
        let blocks = self.parse_masked_markdown(&colored.text, false)?;
        Ok(apply_inline_color_tokens(&blocks, &colored.spans))
    }

    fn parse_masked_markdown(
        &self,
        markdown: &str,
        inside_column: bool,
    ) -> Result<Vec<Json>, ConvertError> {
        if inside_column {
            return self.parse_markdown_with_toggles(markdown);
        }
        let mut blocks = Vec::new();
        for segment in split_markdown_by_column_regions(markdown) {
            match &segment {
                ColumnContentSegment::Columns { .. } => {
                    let block = build_column_list_block(
                        &segment,
                        &mut |body| {
                            self.parse_masked_markdown(body, true)
                                .map_err(|e| e.to_string())
                        },
                        &mut empty_paragraph,
                        None,
                    )
                    .map_err(ConvertError::Serialize)?;
                    blocks.push(block);
                }
                ColumnContentSegment::Gap { extra_lines } => push_gap(&mut blocks, *extra_lines),
                ColumnContentSegment::Markdown { text } => {
                    blocks.extend(self.parse_markdown_with_toggles(text)?);
                }
            }
        }
        Ok(blocks)
    }

    fn parse_markdown_with_toggles(&self, markdown: &str) -> Result<Vec<Json>, ConvertError> {
        let mut blocks = Vec::new();
        for segment in split_markdown_by_toggles(markdown) {
            match segment {
                ToggleContentSegment::Toggle {
                    summary,
                    body,
                    open,
                    colors_marker,
                } => {
                    blocks.push(self.parse_toggle_segment(&summary, &body, open, colors_marker)?)
                }
                ToggleContentSegment::Gap { extra_lines } => push_gap(&mut blocks, extra_lines),
                ToggleContentSegment::Markdown { text } => {
                    blocks.extend(self.parse_markdown_without_toggles(&text)?);
                }
            }
        }
        Ok(blocks)
    }

    fn parse_toggle_segment(
        &self,
        summary: &str,
        body: &str,
        open: bool,
        colors_marker: Option<String>,
    ) -> Result<Json, ConvertError> {
        let parsed_summary = self.parse_md(summary)?;
        let colors = colors_marker.as_deref().and_then(parse_block_colors_marker);
        let mut props = match colors {
            Some(Json::Object(map)) => map,
            _ => Map::new(),
        };
        props.insert("open".into(), Json::Bool(open));
        let content = parsed_summary
            .first()
            .map_or_else(|| json!([]), content_or_empty);
        let children = if body.is_empty() {
            Vec::new()
        } else {
            self.parse_masked_markdown(body, false)?
        };
        Ok(block_of(
            "toggleListItem",
            Json::Object(props),
            Some(content),
            Some(children),
        ))
    }

    fn parse_markdown_without_toggles(&self, markdown: &str) -> Result<Vec<Json>, ConvertError> {
        let mut blocks = Vec::new();
        for segment in split_markdown_preserving_blanks(markdown) {
            match segment {
                MarkdownSegment::Content { text } => {
                    blocks.extend(self.parse_content_with_markers(&text)?);
                }
                MarkdownSegment::Gap { extra_lines } => {
                    push_gap(&mut blocks, usize::try_from(extra_lines).unwrap_or(0));
                }
            }
        }
        // A nesting marker can sit between blocks different parsers claim, so
        // levels apply to the whole run.
        Ok(fold_block_nesting_markers(&blocks))
    }

    fn parse_content_with_markers(&self, text: &str) -> Result<Vec<Json>, ConvertError> {
        let mut blocks: Vec<Json> = Vec::new();
        let mut buffer: Vec<&str> = Vec::new();
        let mut pending: Vec<SidecarPatch> = Vec::new();
        let mut fence = FenceTracker::new();
        let lines: Vec<String> = text.split('\n').map(str::to_owned).collect();

        let apply_pending = |pending: &mut Vec<SidecarPatch>, block: Option<&mut Json>| {
            if let Some(block) = block {
                for patch in pending.iter() {
                    patch.apply(block);
                }
            }
            pending.clear();
        };
        let flush = |buffer: &mut Vec<&str>,
                     pending: &mut Vec<SidecarPatch>,
                     blocks: &mut Vec<Json>|
         -> Result<(), ConvertError> {
            if buffer.is_empty() {
                return Ok(());
            }
            let mut failure = None;
            let mut parsed = parse_markdown_with_nesting_markers(&buffer.join("\n"), &mut |md| {
                self.parse_md(md).unwrap_or_else(|e| {
                    failure.get_or_insert(e);
                    Vec::new()
                })
            });
            if let Some(e) = failure {
                return Err(e);
            }
            let first = parsed.iter().position(|b| !is_block_nesting_marker(b));
            apply_pending(pending, first.map(|i| &mut parsed[i]));
            blocks.extend(parsed);
            buffer.clear();
            Ok(())
        };

        let mut i = 0;
        while i < lines.len() {
            let line = lines[i].as_str();
            let trimmed = js_trim(line);
            // A marker inside a code fence is the author's text, not a marker.
            let inside_fence = fence.consume(line);
            if !inside_fence {
                let after_sidecar = buffer.is_empty() && !pending.is_empty();
                let at_paragraph_start =
                    i == 0 || js_trim(&lines[i - 1]).is_empty() || after_sidecar;
                if let Some(run) =
                    read_callout_run(&lines, i, at_paragraph_start, self.callout_types)
                    && let Some(claimed) = resolve_callout_run(
                        &run,
                        self.callout_types,
                        &mut |md| self.parse_md(md).map_err(|e| e.to_string()),
                        &mut |blocks| {
                            self.serializer
                                .serialize_blocks(blocks)
                                .map_err(|e| e.to_string())
                        },
                    )
                    .map_err(ConvertError::Serialize)?
                {
                    flush(&mut buffer, &mut pending, &mut blocks)?;
                    let props =
                        json!({"type": claimed.callout_type, "fold": claimed.fold.as_str()});
                    let mut callout = block_of(
                        "callout",
                        props,
                        Some(claimed.content),
                        Some(claimed.children),
                    );
                    apply_pending(&mut pending, Some(&mut callout));
                    blocks.push(callout);
                    for consumed in lines.iter().take(run.end).skip(i + 1) {
                        fence.consume(consumed);
                    }
                    i = run.end;
                    continue;
                }
                if let Some(math) = read_math_run(&lines, i, at_paragraph_start) {
                    flush(&mut buffer, &mut pending, &mut blocks)?;
                    let mut block = block_of("mathBlock", json!({"latex": math.latex}), None, None);
                    apply_pending(&mut pending, Some(&mut block));
                    blocks.push(block);
                    for consumed in lines.iter().take(math.end).skip(i + 1) {
                        fence.consume(consumed);
                    }
                    i = math.end;
                    continue;
                }
                if at_paragraph_start
                    && let Some(run) = read_structured_quote_run(&lines, i)
                    && let Some(claimed) = resolve_quote_run(
                        &run,
                        &mut |md| self.parse_md(md).map_err(|e| e.to_string()),
                        &mut |blocks| {
                            self.serializer
                                .serialize_blocks(blocks)
                                .map_err(|e| e.to_string())
                        },
                    )
                    .map_err(ConvertError::Serialize)?
                {
                    flush(&mut buffer, &mut pending, &mut blocks)?;
                    let mut quote = block_of(
                        "quote",
                        json!({}),
                        Some(claimed.content),
                        Some(claimed.children),
                    );
                    apply_pending(&mut pending, Some(&mut quote));
                    blocks.push(quote);
                    for consumed in lines.iter().take(run.end).skip(i + 1) {
                        fence.consume(consumed);
                    }
                    i = run.end;
                    continue;
                }
            }
            // Deliberately not fence-guarded: the sidecar branch predates custom
            // block parsing, and guarding it would drop a marker after a fence
            // this tracker read differently.
            if let Some(patch) = parse_sidecar_marker_line(trimmed) {
                flush(&mut buffer, &mut pending, &mut blocks)?;
                pending.push(patch);
                i += 1;
                continue;
            }
            let marker = if inside_fence {
                None
            } else {
                parse_custom_block_marker_line(line)
            };
            if let Some(marker) = marker {
                flush(&mut buffer, &mut pending, &mut blocks)?;
                pending.clear();
                blocks.push(marker);
                i += 1;
                continue;
            }
            buffer.push(line);
            i += 1;
        }
        flush(&mut buffer, &mut pending, &mut blocks)?;
        Ok(blocks)
    }
}
