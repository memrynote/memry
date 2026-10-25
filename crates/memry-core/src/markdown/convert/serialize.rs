//! `serializeBlocks` of `blocknote-converter.ts`: the one funnel every
//! blocks-to-markdown serialization goes through, so list markers, list
//! tightness and soft breaks stay byte-friendly against vault files.

use serde_json::Value as Json;

use super::{BlockSerializer, ConvertError};
use crate::markdown::bn::export::export_blocks_html;
use crate::markdown::bn::html_to_md::clean_html_to_markdown;
use crate::markdown::schema::html_comment::write_html_comment_tokens;
use crate::markdown::shared::empty_lines::normalize_serialized_markdown;
use crate::markdown::shared::inline_colors::{
    extract_inline_color_runs, restore_inline_color_tokens,
};
use crate::markdown::shared::plain_checkbox::with_plain_checkbox_markers;

/// Not the vault write path: it serializes one flat run of blocks. The walk that
/// owns toggles, structured quotes, callouts with children, columns, task
/// blocks, nesting markers and blank-line gaps (`blocksToMarkdownPreserving`)
/// lands in stage 6 and calls this per content group; nothing outside the
/// `markdown` feature reaches it until then.
///
/// `serializeBlocks`: plain-checkbox markers, inline colour tokens, HTML
/// comment and emphasis tokens, BlockNote's `blocksToMarkdownLossy`,
/// `normalizeSerializedMarkdown`, then the colour tokens back as spans.
pub fn serialize_blocks(blocks: &[Json]) -> Result<String, ConvertError> {
    let mut marked = blocks.to_vec();
    with_plain_checkbox_markers(&mut marked);
    let (wrapped, replacements) = extract_inline_color_runs(&marked);
    let markdown = write_html_comment_tokens(&wrapped, |tokened| {
        let html = export_blocks_html(tokened)?;
        Ok(clean_html_to_markdown(&html))
    })?;
    Ok(restore_inline_color_tokens(
        &normalize_serialized_markdown(&markdown),
        &replacements,
    ))
}

/// The [`BlockSerializer`] the callout and quote claim proofs run through.
pub struct BlockNoteSerializer;

impl BlockSerializer for BlockNoteSerializer {
    fn serialize_blocks(&self, blocks: &[Json]) -> Result<String, ConvertError> {
        serialize_blocks(blocks)
    }
}
