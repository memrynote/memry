//! The group table: each group's defaults and the fields that sync.

use serde_json::Value;

use super::{defaults, syncable};

/// A synced object field that carries one clock per entry, so two devices
/// editing different entries both keep their edit. A `null` entry is the
/// delete marker (chapter 13 §13.4).
pub(super) struct MapField {
    pub name: &'static str,
    pub entry_ok: fn(&str) -> bool,
    /// Whether `get_group` shows the field. `editor.calloutTypes` is read
    /// through its own path, as it is a separate setting on desktop.
    pub in_group: bool,
}

pub(super) struct Group {
    pub name: &'static str,
    pub defaults: fn() -> Value,
    /// Scalar (or whole-list) fields that sync, one clock each.
    pub syncable: &'static [&'static str],
    pub maps: &'static [MapField],
}

impl Group {
    pub fn is_syncable(&self, field: &str) -> bool {
        self.syncable.contains(&field)
    }

    pub fn map(&self, field: &str) -> Option<&MapField> {
        self.maps.iter().find(|map| map.name == field)
    }
}

const fn local(name: &'static str, defaults: fn() -> Value) -> Group {
    Group {
        name,
        defaults,
        syncable: &[],
        maps: &[],
    }
}

pub(super) const GROUPS: &[Group] = &[
    Group {
        name: "general",
        defaults: defaults::general,
        syncable: syncable::GENERAL,
        maps: &[],
    },
    Group {
        name: "editor",
        defaults: defaults::editor,
        syncable: syncable::EDITOR,
        maps: &[MapField {
            name: "calloutTypes",
            entry_ok: syncable::is_callout_name,
            in_group: false,
        }],
    },
    local("tasks", defaults::tasks),
    local("keyboard", defaults::keyboard),
    local("sync", defaults::sync),
    local("backup", defaults::backup),
    local("calendar", defaults::calendar),
    Group {
        name: "features",
        defaults: defaults::features,
        syncable: syncable::FEATURES,
        maps: &[],
    },
    Group {
        name: "inbox",
        defaults: defaults::inbox,
        syncable: syncable::INBOX,
        maps: &[],
    },
    local("sticky", defaults::sticky),
    local("graph", defaults::graph),
    local("voiceTranscription", defaults::voice_transcription),
    local("ai-inline", defaults::ai_inline),
    Group {
        name: "journal",
        defaults: defaults::journal,
        syncable: syncable::JOURNAL,
        maps: &[MapField {
            name: "weekdayTemplates",
            entry_ok: syncable::is_weekday_key,
            in_group: true,
        }],
    },
    local("tabs", defaults::tabs),
    local("noteEditor", defaults::note_editor),
    Group {
        name: "sidebar",
        defaults: defaults::sidebar,
        syncable: syncable::SIDEBAR,
        maps: &[MapField {
            name: "sortModes",
            entry_ok: syncable::is_sort_surface,
            in_group: true,
        }],
    },
];

pub(super) fn find(name: &str) -> Option<&'static Group> {
    GROUPS.iter().find(|group| group.name == name)
}

/// `(min, max)` of a numeric field. Pinned to the TypeScript constants by the
/// vector (`FONT_SIZE_PX_*`, `ZOOM_FACTOR_*`).
pub(super) fn range(group: &str, field: &str) -> Option<(f64, f64)> {
    match (group, field) {
        ("general", "fontSizePx") => Some((12.0, 24.0)),
        ("general", "zoomFactor") => Some((0.5, 2.0)),
        _ => None,
    }
}
