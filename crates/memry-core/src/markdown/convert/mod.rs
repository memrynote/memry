//! The markdown-to-seed pipeline of the Electron converter
//! (`blocknote-converter.ts`: `prepareFragmentSeed`, `markdownToBlocks` and the
//! parse half of `parseContentWithMarkers`) and, in later stages, the
//! serializer, source restore and the Y.Doc write.

pub mod body;
pub mod seed;
pub mod serialize;

use serde_json::Value as Json;

use crate::markdown::bn::dom_parser::ParseError;

/// A conversion step the TypeScript would have thrown out of. `prepareFragmentSeed`
/// answers `null` to every one of them, and the caller keeps the file.
#[derive(Debug, thiserror::Error)]
pub enum ConvertError {
    #[error(transparent)]
    Parse(#[from] ParseError),
    #[error("block serializer failed: {0}")]
    Serialize(String),
}

/// Vault embed lookup (`resolveVaultEmbeds`): the `memry-file://` URL a
/// `![[target]]` image embed resolves to for the note at `note_path`, or `None`
/// to leave the embed as written. A closed vault or an unreadable index
/// resolves nothing.
pub trait EmbedResolver: Send + Sync {
    fn resolve(&self, target: &str, note_path: Option<&str>) -> Option<String>;
}

/// An [`EmbedResolver`] that resolves nothing.
pub struct NoEmbeds;

impl EmbedResolver for NoEmbeds {
    fn resolve(&self, _target: &str, _note_path: Option<&str>) -> Option<String> {
        None
    }
}

/// The blocks-to-markdown serializer the claim proofs of callouts and
/// structured quotes run through (`serializeBlocks` of the converter: inline
/// colours, plain-checkbox markers, HTML comment tokens, BlockNote's own
/// serializer, `normalizeSerializedMarkdown`): [`serialize::BlockNoteSerializer`].
pub trait BlockSerializer {
    fn serialize_blocks(&self, blocks: &[Json]) -> Result<String, ConvertError>;
}
