//! `prepareFragmentSeed`: everything a fragment seed needs to write, parsed
//! without touching a Y.Doc.

use serde_json::Value as Json;

use super::body::BodyParser;
use super::{BlockSerializer, ConvertError, EmbedResolver};
use crate::markdown::schema::callout_types::CalloutTypes;
use crate::markdown::shared::critic_markup::{CriticMarkupMark, parse_critic_markup};
use crate::markdown::shared::link_references::{
    LinkReferenceDefinition, LinkReferenceUsage, inline_link_references,
    strip_link_reference_definitions,
};
use crate::markdown::shared::plain_checkbox::normalize_plain_checkboxes;
use crate::markdown::shared::task_block::normalize_task_blocks;
use crate::markdown::shared::writing_tools::{
    WritingFrontmatter, WritingSentinelMap, decode_writing_markers, without_writing_sentinels,
};

/// What `PreparedFragmentSeed` holds.
#[derive(Debug, Clone)]
pub struct PreparedSeed {
    pub blocks: Vec<Json>,
    pub marks: Vec<CriticMarkupMark>,
    pub definitions: Vec<LinkReferenceDefinition>,
    pub usages: Vec<LinkReferenceUsage>,
    /// The body with CriticMarkup and writing tools markers removed.
    pub plain_text: String,
    /// Writing tools markers, as the sentinels the blocks now carry.
    pub writing_sentinels: WritingSentinelMap,
    pub writing: Option<WritingFrontmatter>,
}

/// The collaborators of a seed parse.
pub struct SeedEnv<'a> {
    pub callout_types: &'a CalloutTypes,
    pub embeds: &'a dyn EmbedResolver,
    pub serializer: &'a dyn BlockSerializer,
    /// False parses as builds before #2741 did, dropping every HTML comment.
    pub html_comments: bool,
}

/// `withLfLineEndings`: the parse reads a `\r` as a space, so a CRLF file
/// seeded as it is would put a trailing space on every line.
fn with_lf_line_endings(markdown: &str) -> String {
    markdown.replace("\r\n", "\n").replace('\r', "\n")
}

/// `prepareFragmentSeed(markdown, notePath, writing)`.
pub fn prepare_fragment_seed(
    env: &SeedEnv,
    markdown: &str,
    note_path: Option<&str>,
    writing: Option<WritingFrontmatter>,
) -> Result<PreparedSeed, ConvertError> {
    // Writing tools markers first, as sentinels that ride the parse into the
    // blocks. CriticMarkup offsets are then moved onto the text every
    // CriticMarkup reader counts in.
    let decoded = decode_writing_markers(&with_lf_line_endings(markdown));
    let parsed = parse_critic_markup(&decoded.text);
    let critic = without_writing_sentinels(&parsed, &decoded.sentinels);
    // Definitions stripped and usages resolved to inline links before the
    // editor sees the text.
    let references = strip_link_reference_definitions(&parsed.plain_text);
    let source = inline_link_references(&references.markdown, &references.usages);
    let parser = BodyParser {
        callout_types: env.callout_types,
        embeds: env.embeds,
        serializer: env.serializer,
        html_comments: env.html_comments,
    };
    let blocks = parser.markdown_to_blocks(&source, note_path)?;
    // Upgrade `- [ ] … {task:id}` checkboxes into taskBlock nodes, and lines
    // ending in the plain-checkbox marker into checkboxes with `plain: true`.
    let (mut normalized, _) = normalize_task_blocks(&blocks, Some(&source));
    normalize_plain_checkboxes(&mut normalized);
    Ok(PreparedSeed {
        blocks: normalized,
        marks: critic.marks,
        definitions: references.definitions,
        usages: references.usages,
        plain_text: critic.plain_text,
        writing_sentinels: decoded.sentinels,
        writing,
    })
}
