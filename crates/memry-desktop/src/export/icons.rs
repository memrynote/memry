//! HugeIcons glyphs for a note exported with a library icon (`icon:<Name>`).
//! `apps/desktop-tauri/scripts/generate-export-icons.mjs` writes the table from
//! `@hugeicons/core-free-icons`; it is inflated on the first export that needs it.

use std::collections::HashMap;
use std::io::Read as _;
use std::sync::LazyLock;

use flate2::read::GzDecoder;
use serde::Deserialize;

/// One SVG child element: its tag and its attributes in order.
pub type IconPart = (String, Vec<(String, String)>);

const TABLE: &[u8] = include_bytes!("../../resources/export-icons.json.gz");

#[derive(Deserialize)]
struct Table {
    glyphs: Vec<Vec<IconPart>>,
    names: HashMap<String, usize>,
}

static ICONS: LazyLock<Option<Table>> = LazyLock::new(|| {
    let mut json = String::new();
    let read = GzDecoder::new(TABLE).read_to_string(&mut json);
    match read
        .map_err(|error| error.to_string())
        .and_then(|_| serde_json::from_str(&json).map_err(|error| error.to_string()))
    {
        Ok(table) => Some(table),
        Err(error) => {
            tracing::error!(%error, "export icon table is unreadable; library icons are left out");
            None
        }
    }
});

/// The glyph exported as `name`, or `None` for an unknown name.
pub fn library_icon(name: &str) -> Option<&'static [IconPart]> {
    let table = ICONS.as_ref()?;
    let index = *table.names.get(name)?;
    table.glyphs.get(index).map(Vec::as_slice)
}
