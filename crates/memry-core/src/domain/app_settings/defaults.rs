//! The default object of each group, as desktop's `*_SETTINGS_DEFAULTS` spell
//! it. `settings-groups.json` compares every one of them, so a drift in either
//! side fails the parity test. Numbers that are whole in TypeScript are
//! integers here: `serde_json` does not equal `1` to `1.0`.

use serde_json::{Value, json};

pub(super) fn general() -> Value {
    json!({
        "theme": "white",
        "fontSize": "medium",
        "fontSizePx": 16,
        "fontFamily": "system",
        "customFontFamily": "",
        "accentColor": "#f97316",
        "colorTheme": "memrynote",
        "useThemeAccent": true,
        "backgroundLight": "",
        "foregroundLight": "",
        "backgroundDark": "",
        "foregroundDark": "",
        "reduceMotion": "system",
        "pointerCursors": false,
        "fontSmoothing": false,
        "startOnBoot": false,
        "language": "en",
        "onboardingCompleted": false,
        "createInSelectedFolder": true,
        "openPagesInNewTab": false,
        "minimizeToTray": false,
        "clockFormat": "12h",
        "dateFormat": "DD.MM.YYYY",
        "zoomFactor": 1
    })
}

pub(super) fn editor() -> Value {
    json!({
        "width": "normal",
        "toolbarMode": "floating",
        "spellCheck": false,
        "pdfAdaptToTheme": false,
        "pdfDisplayMode": "embed",
        "convertChecklistsToTasks": true,
        "convertAgentChecklistsToTasks": false
    })
}

pub(super) fn tasks() -> Value {
    json!({
        "defaultProjectId": null,
        "defaultSortOrder": "manual",
        "defaultView": "all",
        "staleInboxDays": 7,
        "nestedSubtasks": true
    })
}

pub(super) fn keyboard() -> Value {
    json!({
        "overrides": {},
        "globalCapture": null,
        "folderNoteShortcuts": [],
        "stickyShortcut": { "key": "M", "modifiers": { "meta": true, "shift": true } }
    })
}

pub(super) fn sync() -> Value {
    json!({ "enabled": true, "autoSync": true, "attachmentAutoDownload": true })
}

pub(super) fn backup() -> Value {
    json!({
        "autoBackup": false,
        "frequencyHours": 24,
        "maxBackups": 5,
        "lastBackupAt": null
    })
}

/// The base group only. The provider sub-groups and their synced paths belong
/// to the calendar settings step.
pub(super) fn calendar() -> Value {
    json!({
        "dayCellClickBehavior": "journal",
        "calendarPageClickOverride": "calendar",
        "weekStartDay": "monday",
        "showNotesOnCalendar": false
    })
}

pub(super) fn features() -> Value {
    json!({
        "home": true,
        "inbox": true,
        "journal": true,
        "tasks": true,
        "calendar": true,
        "graph": true,
        "spatialCanvas": true
    })
}

pub(super) fn inbox() -> Value {
    json!({
        "reviewReminderEnabled": false,
        "reviewReminderTime": "18:00",
        "imageFilingMode": "embed",
        "imageFilingModeRemembered": false
    })
}

pub(super) fn sticky() -> Value {
    json!({ "defaultKind": "last", "lastKind": "note", "tuckEdge": "right" })
}

pub(super) fn graph() -> Value {
    json!({
        "layout": "forceatlas2",
        "showLabels": false,
        "showEdgeLabels": false,
        "animateLayout": true,
        "showTagEdges": false
    })
}

pub(super) fn voice_transcription() -> Value {
    json!({ "provider": "local", "memoNameMode": "transcript" })
}

pub(super) fn ai_inline() -> Value {
    json!({
        "enabled": true,
        "provider": "ollama",
        "model": "llama3.2",
        "apiKey": "",
        "baseUrl": "http://localhost:11434/v1"
    })
}

pub(super) fn journal() -> Value {
    json!({
        "defaultTemplate": null,
        "weekdayTemplates": {},
        "showSchedule": true,
        "showTasks": true,
        "showAIConnections": true,
        "showStatsFooter": false
    })
}

pub(super) fn tabs() -> Value {
    json!({ "restoreSessionOnStart": true, "tabCloseButton": "hover" })
}

pub(super) fn note_editor() -> Value {
    json!({ "toolbarMode": "floating" })
}

pub(super) fn sidebar() -> Value {
    json!({
        "sortModes": {},
        "sectionOrder": null,
        "railOrder": null,
        "navCollapsed": false,
        "notesFirst": false,
        "showFiles": true
    })
}
