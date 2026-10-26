//! The fields of each group that sync, and the map fields that sync one clock
//! per entry. Pinned to desktop by `settings-groups.json`: the lists come from
//! `packages/contracts/src/settings-schemas.ts` (`*_SYNCABLE_FIELDS`), and the
//! wire path of a field is always `<group>.<field>` (map entry:
//! `<group>.<field>.<entry>`), which is what `syncSettingsFieldUpdate` sends.

/// Desktop's `GENERAL_SYNCABLE_FIELDS`. `startOnBoot` and `zoomFactor` are
/// deliberately absent: they describe this machine.
pub(super) const GENERAL: &[&str] = &[
    "theme",
    "fontSize",
    "fontSizePx",
    "fontFamily",
    "customFontFamily",
    "accentColor",
    "colorTheme",
    "useThemeAccent",
    "backgroundLight",
    "foregroundLight",
    "backgroundDark",
    "foregroundDark",
    "language",
    "createInSelectedFolder",
    "openPagesInNewTab",
    "minimizeToTray",
];

pub(super) const INBOX: &[&str] = &["reviewReminderEnabled", "reviewReminderTime"];

pub(super) const EDITOR: &[&str] = &[
    "convertChecklistsToTasks",
    "convertAgentChecklistsToTasks",
    "pdfDisplayMode",
];

/// Every flag of the `features` group follows the user across devices.
pub(super) const FEATURES: &[&str] = &[
    "home",
    "inbox",
    "journal",
    "tasks",
    "calendar",
    "graph",
    "spatialCanvas",
];

pub(super) const JOURNAL: &[&str] = &["defaultTemplate"];

pub(super) const SIDEBAR: &[&str] = &[
    "sectionOrder",
    "railOrder",
    "navCollapsed",
    "notesFirst",
    "showFiles",
];

pub(super) const SIDEBAR_SORT_SURFACES: &[&str] =
    &["collections", "projects", "bookmarks", "canvases", "tags"];

/// `journal.weekdayTemplates.<day>`: JS `getDay()`, `"0"` to `"6"`.
pub(super) fn is_weekday_key(key: &str) -> bool {
    matches!(key.as_bytes(), [b'0'..=b'6'])
}

/// `editor.calloutTypes.<name>`: `CALLOUT_TYPE_NAME_REGEX`, `^[a-z][a-z0-9_-]{0,31}$`.
pub(super) fn is_callout_name(key: &str) -> bool {
    let bytes = key.as_bytes();
    bytes.len() <= 32
        && bytes.first().is_some_and(u8::is_ascii_lowercase)
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-'))
}

pub(super) fn is_sort_surface(key: &str) -> bool {
    SIDEBAR_SORT_SURFACES.contains(&key)
}
