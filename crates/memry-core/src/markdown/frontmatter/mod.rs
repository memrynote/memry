//! Frontmatter: the byte-exact split, the edited-frontmatter YAML bytes
//! (gray-matter 4.0.3 over js-yaml 3.15.1) and the note read and write rules of
//! `packages/app-core/src/markdown.ts`. Specified in
//! `docs/protocol/12-note-body-format.md` section 12.4.

mod edit;
pub(crate) mod js;
mod json;
mod note;
mod scalar;
mod split;
mod value;
mod yaml_dump;
mod yaml_load;

#[doc(hidden)]
pub use edit::equal_visits;
pub use edit::{deep_strict_equal, edit_frontmatter_block, serialize_updated_note};
pub use json::{json_to_yaml, yaml_to_json};
pub use note::{
    Eol, ParsedMarkdownNote, gray_matter_data, gray_matter_parts, parse_markdown_note,
    serialize_parsed_markdown_note, stringify_frontmatter_block, write_markdown_note,
};
pub use split::{FrontmatterSplit, split_frontmatter_block};
pub use value::{YamlMap, YamlValue};
#[doc(hidden)]
pub use value::{depth_visits, entries_scanned};
pub use yaml_dump::safe_dump;
pub use yaml_load::{YamlError, safe_load};
