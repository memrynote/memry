//! Port of `packages/editor-schema/src/blocks/columns.ts`: the Multi-Column
//! Markdown (MCM) region on disk, read and written as `columnList` / `column`
//! blocks. Reading accepts every live MCM spelling and Pandoc fenced divs;
//! writing always produces the MCM form.
//!
//! `buildColumnListBlock` and `serializeColumnListBlock` take synchronous
//! closures where the TypeScript takes async callbacks. Neither touches a
//! Y.Doc, so the module is ported whole.

mod build;
mod regions;
mod settings;

pub use build::{
    build_column_list_block, column_region_id_for, serialize_column_list_block,
    serialize_column_region,
};
pub use regions::{ColumnContentSegment, split_markdown_by_column_regions};
pub use settings::{column_settings_for, column_widths_from_settings};

pub const COLUMN_REGION_START_PREFIX: &str = "--- start-multi-column:";
pub const COLUMN_BREAK_LINE: &str = "--- end-column ---";
pub const COLUMN_REGION_END_LINE: &str = "--- end-multi-column";

/// Columns the editor gives a new or unsized region: every one the same width.
pub const DEFAULT_COLUMN_WIDTH: f64 = 1.0;
