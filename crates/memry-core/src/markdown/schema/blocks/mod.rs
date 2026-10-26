//! Port of `packages/editor-schema/src/blocks/markdown.ts`: the on-disk form of
//! every custom block, split by block kind. The TypeScript module is one file;
//! here callout, math, toggle, file and the image-embed markers each have one.
//!
//! Where the TypeScript takes async `parseMarkdown` / `serializeBlocks`
//! callbacks (BlockNote's parser and the block serializer), these ports take
//! synchronous closures that may fail.

use serde_json::Value;

pub mod callout;
pub mod embeds;
pub mod file;
pub mod math;
pub mod toggle;

/// `ParsedBlockShape`: a parsed block, as BlockNote block JSON.
pub type ParsedBlock = Value;

/// The parse callback: markdown to blocks.
pub type ParseMarkdown<'a> = &'a mut dyn FnMut(&str) -> Result<Vec<ParsedBlock>, String>;

/// The serialize callback: blocks to markdown.
pub type SerializeBlocks<'a> = &'a mut dyn FnMut(&[ParsedBlock]) -> Result<String, String>;
