//! `readReadwiseOptions` (`apps/desktop/src/main/readwise/settings.ts`): the synced `readwise`
//! group read over its defaults. A value only a newer build knows reads as the default.

use serde_json::Value;

use super::types::{CategorySwitches, FolderLayout};

/// `READWISE_OPTIONS_DEFAULTS.rootFolder`.
pub const DEFAULT_ROOT: &str = "Readwise";

/// The options a run reads. The cadence is the scheduler's (33e).
#[derive(Debug, Clone, PartialEq)]
pub struct ReadwiseOptions {
    pub root_folder: String,
    pub folder_layout: FolderLayout,
    /// Only the switches the user set; the planner fills in the defaults.
    pub categories: CategorySwitches,
    pub reader_documents: bool,
    pub journal_highlights: bool,
}

impl ReadwiseOptions {
    /// `group` is the stored `readwise` object; any other value reads as `{}`.
    pub fn from_group(group: &Value) -> Self {
        let field = |name: &str| group.get(name);
        let flag = |name: &str| field(name).and_then(Value::as_bool).unwrap_or(false);
        let categories = field("categories");
        let category = |name: &str| categories.and_then(|c| c.get(name)).and_then(Value::as_bool);
        Self {
            root_folder: field("rootFolder")
                .and_then(Value::as_str)
                .filter(|root| !root.trim().is_empty())
                .unwrap_or(DEFAULT_ROOT)
                .to_owned(),
            folder_layout: match field("folderLayout").and_then(Value::as_str) {
                Some("flat") => FolderLayout::Flat,
                _ => FolderLayout::ByCategory,
            },
            categories: CategorySwitches {
                books: category("books"),
                articles: category("articles"),
                tweets: category("tweets"),
                podcasts: category("podcasts"),
                supplementals: category("supplementals"),
            },
            reader_documents: flag("readerDocuments"),
            journal_highlights: flag("journalHighlights"),
        }
    }
}
