//! Port of `packages/shared/src/writing-tools/markdown.ts`: writing tools in
//! the note's markdown file. `yjs.ts` touches a Y.Doc and belongs to stage 6.
//!
//! CriticMarkup offsets handled here are UTF-16 code units, as in the TypeScript.

mod encode;
mod frontmatter;
mod markers;
mod types;

pub use encode::{encode_writing_body, without_writing_sentinels};
pub use frontmatter::{
    is_writing_frontmatter_value, read_writing_frontmatter, to_writing_frontmatter_value,
    writing_frontmatter_of,
};
pub use markers::{
    DecodedWritingMarkers, create_sentinel_allocator, decode_writing_markers,
    is_writing_alternative_id, marker_comment, new_writing_alternative_id, strip_writing_sentinels,
};
pub use types::*;
