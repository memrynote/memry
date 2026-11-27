//! Which writes ask the user: the port of Electron's `runtime/permission-gate.ts`, the preview
//! table of `mcp/tools/preview-kinds.ts` and the in-page review tools of `ipc-agent.ts:706`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent::mcp::{ToolClass, catalog};

/// `AgentToolApprovalModeSchema` (`ipc-agent.ts:201`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolApprovalMode {
    AlwaysAccept,
    /// Absent means nobody has chosen, and the safe reading of that is to ask.
    #[default]
    Ask,
}

/// `ChangePreviewKindSchema` (`ipc-agent.ts:618`): the picture the approval card draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum PreviewKind {
    None,
    Fields,
    Body,
    Loss,
}

/// `AgentReviewTargetSchema` (`ipc-agent.ts:694`): the page that reviews a body edit in place.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReviewTarget {
    Note { id: String },
    Journal { date: String },
}

/// Body edits the user reviews inside the note or journal. A standing approval never skips them.
pub const IN_PAGE_REVIEW_TOOLS: [&str; 2] = ["vault_update_note", "vault_update_journal_entry"];

pub fn is_in_page_review_tool(tool: &str) -> bool {
    IN_PAGE_REVIEW_TOOLS.contains(&tool)
}

/// `WRITE_TOOL_PREVIEW_KINDS`. Archiving is `fields`: it is reversible and visible in the archive.
const PREVIEW_KINDS: [(&str, PreviewKind); 53] = {
    use PreviewKind::{Body, Fields, Loss};
    [
        ("vault_create_note", Body),
        ("vault_rename_note", Fields),
        ("vault_delete_note", Loss),
        ("vault_create_folder", Fields),
        ("vault_rename_folder", Fields),
        ("vault_delete_folder", Loss),
        ("vault_create_task", Fields),
        ("vault_delete_task", Loss),
        ("vault_complete_task", Fields),
        ("vault_uncomplete_task", Fields),
        ("vault_archive_task", Fields),
        ("vault_unarchive_task", Fields),
        ("vault_move_task", Fields),
        ("vault_reorder_tasks", Fields),
        ("vault_duplicate_task", Fields),
        ("vault_convert_task_to_subtask", Fields),
        ("vault_convert_subtask_to_task", Fields),
        ("vault_create_project", Fields),
        ("vault_update_project", Fields),
        ("vault_delete_project", Loss),
        ("vault_archive_project", Fields),
        ("vault_reorder_projects", Fields),
        ("vault_create_status", Fields),
        ("vault_update_status", Fields),
        ("vault_delete_status", Loss),
        ("vault_reorder_statuses", Fields),
        ("vault_create_journal_entry", Body),
        ("vault_update_journal_entry", Body),
        ("vault_delete_journal_entry", Loss),
        ("vault_add_to_inbox", Body),
        ("vault_update_inbox_item", Fields),
        ("vault_snooze_inbox_item", Fields),
        ("vault_archive_inbox_item", Fields),
        ("vault_unarchive_inbox_item", Fields),
        ("vault_delete_inbox_item", Loss),
        ("vault_add_inbox_tag", Fields),
        ("vault_remove_inbox_tag", Fields),
        ("vault_update_note", Body),
        ("vault_add_html_artifact", Fields),
        ("vault_update_task", Fields),
        ("vault_add_tag", Fields),
        ("vault_remove_tag", Fields),
        ("vault_move_to_folder", Fields),
        ("vault_bulk_tag_notes", Fields),
        ("vault_bulk_move_notes", Fields),
        ("vault_copy_notes", Fields),
        ("vault_insert_at_cursor", Fields),
        ("vault_add_canvas_item", Fields),
        ("vault_remove_canvas_item", Fields),
        ("vault_create_canvas", Fields),
        ("vault_draw_on_canvas", Fields),
        ("vault_edit_canvas_elements", Fields),
        ("vault_desktop_write", Fields),
    ]
};

pub fn preview_kind_for_tool(tool: &str) -> PreviewKind {
    PREVIEW_KINDS
        .iter()
        .find(|(name, _)| *name == tool)
        .map_or(PreviewKind::None, |(_, kind)| *kind)
}

/// What each `vault_desktop_write` operation does, so neither "always allow" on the tool nor
/// auto-accept covers a delete. `Loss` destroys something the app offers no way back to (no
/// archive, no version). Everything else is `Fields`: creates, updates, moves, archives,
/// toggles, settings writes, exports, tag and link removal (as `vault_remove_tag`), and
/// `notes.restoreVersion`, which snapshots the current body first. Electron classifies the
/// whole tool as `fields`; this split is a Tauri-only departure (#5143).
const DESKTOP_WRITE_KINDS: [(&str, PreviewKind); 165] = {
    use PreviewKind::{Fields, Loss};
    [
        ("notes.create", Fields),
        ("notes.update", Fields),
        ("notes.rename", Fields),
        ("notes.move", Fields),
        ("notes.delete", Loss), // the note file
        ("notes.createFolder", Fields),
        ("notes.renameFolder", Fields),
        ("notes.deleteFolder", Loss), // the folder and every note in it
        ("notes.createPropertyDefinition", Fields),
        ("notes.updatePropertyDefinition", Fields),
        ("notes.ensurePropertyDefinition", Fields),
        ("notes.addPropertyOption", Fields),
        ("notes.addStatusOption", Fields),
        ("notes.removePropertyOption", Loss), // the option, from every note that uses it
        ("notes.renamePropertyOption", Fields),
        ("notes.updateOptionColor", Fields),
        ("notes.deletePropertyDefinition", Loss), // the property and its values
        ("notes.uploadAttachment", Fields),
        ("notes.deleteAttachment", Loss), // the file
        ("notes.setFolderConfig", Fields),
        ("notes.restoreVersion", Fields),
        ("notes.deleteVersion", Loss), // the snapshot
        ("notes.reorder", Fields),
        ("notes.importFiles", Fields),
        ("notes.setLocalOnly", Fields),
        ("notes.setCalendarPropertyVisibility", Fields),
        ("notes.applyTemplate", Fields),
        ("notes.exportPdf", Fields),
        ("notes.exportHtml", Fields),
        ("tasks.create", Fields),
        ("tasks.update", Fields),
        ("tasks.delete", Loss), // the task
        ("tasks.complete", Fields),
        ("tasks.uncomplete", Fields),
        ("tasks.archive", Fields),
        ("tasks.unarchive", Fields),
        ("tasks.move", Fields),
        ("tasks.reorder", Fields),
        ("tasks.duplicate", Fields),
        ("tasks.convertToSubtask", Fields),
        ("tasks.convertToTask", Fields),
        ("tasks.createProject", Fields),
        ("tasks.updateProject", Fields),
        ("tasks.deleteProject", Loss), // the project
        ("tasks.archiveProject", Fields),
        ("tasks.reorderProjects", Fields),
        ("tasks.linkProjectItem", Fields),
        ("tasks.unlinkProjectItem", Fields),
        ("tasks.setProjectLinkPinned", Fields),
        ("tasks.setProjectHomeNote", Fields),
        ("tasks.captureUrlToProject", Fields),
        ("tasks.importFilesToProject", Fields),
        ("tasks.createStatus", Fields),
        ("tasks.updateStatus", Fields),
        ("tasks.deleteStatus", Loss), // the status
        ("tasks.reorderStatuses", Fields),
        ("tasks.bulkComplete", Fields),
        ("tasks.bulkDelete", Loss), // every listed task
        ("tasks.bulkMove", Fields),
        ("tasks.bulkArchive", Fields),
        ("inbox.captureText", Fields),
        ("inbox.captureLink", Fields),
        ("inbox.captureImage", Fields),
        ("inbox.captureVoice", Fields),
        ("inbox.captureClip", Fields),
        ("inbox.capturePdf", Fields),
        ("inbox.update", Fields),
        ("inbox.archive", Fields),
        ("inbox.file", Fields),
        ("inbox.trackSuggestion", Fields),
        ("inbox.convertToNote", Fields),
        ("inbox.convertToTask", Fields),
        ("inbox.convertToEvent", Fields),
        ("inbox.convertToReminder", Fields),
        ("inbox.linkToNote", Fields),
        ("inbox.addTag", Fields),
        ("inbox.removeTag", Fields),
        ("inbox.snooze", Fields),
        ("inbox.unsnooze", Fields),
        ("inbox.markViewed", Fields),
        ("inbox.bulkFile", Fields),
        ("inbox.bulkArchive", Fields),
        ("inbox.bulkTag", Fields),
        ("inbox.bulkSnooze", Fields),
        ("inbox.fileAllStale", Fields),
        ("inbox.retryTranscription", Fields),
        ("inbox.retryMetadata", Fields),
        ("inbox.setStaleThreshold", Fields),
        ("inbox.unarchive", Fields),
        ("inbox.deletePermanent", Loss), // the item, with no archive
        ("inbox.undoFile", Fields),
        ("inbox.undoArchive", Fields),
        ("journal.createEntry", Fields),
        ("journal.updateEntry", Fields),
        ("journal.deleteEntry", Loss), // the entry
        ("properties.set", Fields),
        ("properties.rename", Fields),
        ("templates.create", Fields),
        ("templates.update", Fields),
        ("templates.delete", Loss), // the template
        ("templates.duplicate", Fields),
        ("savedFilters.create", Fields),
        ("savedFilters.update", Fields),
        ("savedFilters.delete", Loss), // the filter
        ("savedFilters.reorder", Fields),
        ("bookmarks.create", Fields),
        ("bookmarks.delete", Loss), // the bookmark
        ("bookmarks.toggle", Loss), // deletes the bookmark when it exists
        ("bookmarks.reorder", Fields),
        ("bookmarks.bulkDelete", Loss), // every listed bookmark
        ("bookmarks.bulkCreate", Fields),
        ("tags.pinNoteToTag", Fields),
        ("tags.unpinNoteFromTag", Fields),
        ("tags.renameTag", Fields),
        ("tags.updateTagColor", Fields),
        ("tags.deleteTag", Loss), // the tag, from every note
        ("tags.removeTagFromNote", Fields),
        ("tags.mergeTag", Loss), // the source tag; a merge cannot be split again
        ("tags.updateTagIcon", Fields),
        ("tags.createCategory", Fields),
        ("tags.renameCategory", Fields),
        ("tags.deleteCategory", Loss), // the category
        ("tags.reorder", Fields),
        ("folderView.setConfig", Fields),
        ("folderView.setView", Fields),
        ("folderView.deleteView", Loss), // the view
        ("reminders.create", Fields),
        ("reminders.update", Fields),
        ("reminders.delete", Loss), // the reminder
        ("reminders.dismiss", Fields),
        ("reminders.snooze", Fields),
        ("reminders.bulkDismiss", Fields),
        ("calendar.createEvent", Fields),
        ("calendar.updateEvent", Fields),
        ("calendar.deleteEvent", Loss), // the event
        ("settings.set", Fields),
        ("settings.setJournalSettings", Fields),
        ("settings.setAISettings", Fields),
        ("settings.setVoiceTranscriptionSettings", Fields),
        ("settings.setTabSettings", Fields),
        ("settings.setNoteEditorSettings", Fields),
        ("settings.setGeneralSettings", Fields),
        ("settings.setEditorSettings", Fields),
        ("settings.setTaskSettings", Fields),
        ("settings.setKeyboardSettings", Fields),
        ("settings.resetKeyboardSettings", Loss), // every custom shortcut
        ("settings.setSyncSettings", Fields),
        ("settings.setBackupSettings", Fields),
        ("settings.setGraphSettings", Fields),
        ("settings.setCalendarSettings", Fields),
        ("settings.setFeaturesSettings", Fields),
        ("settings.setInboxSettings", Fields),
        ("search.rebuildIndex", Fields),
        ("search.addReason", Fields),
        ("search.clearReasons", Loss), // the whole search history
        ("homePages.create", Fields),
        ("homePages.update", Fields),
        ("homePages.delete", Loss), // the home page
        ("homePages.reorder", Fields),
        ("vault.switch", Fields),
        ("vault.reindex", Fields),
        ("vault.updateConfig", Fields),
        ("vault.downloadRemote", Fields),
        ("canvas.create", Fields),
        ("canvas.delete", Loss), // the canvas
    ]
};

/// A decimal count, at compile time.
const fn parse_count(digits: &str) -> usize {
    let digits = digits.as_bytes();
    let (mut at, mut count) = (0, 0);
    while at < digits.len() {
        count = count * 10 + (digits[at] - b'0') as usize;
        at += 1;
    }
    count
}

// build.rs counts the write operations of `desktop-ops.json`: a new one fails the build until it
// is classified above. `agent_write_gate` checks the names match.
const _: () = assert!(
    parse_count(env!("MEMRY_DESKTOP_WRITE_OPERATIONS")) == DESKTOP_WRITE_KINDS.len(),
    "classify every vault_desktop_write operation in DESKTOP_WRITE_KINDS"
);

/// The preview kind of one call: a desktop write by its operation, any other tool by name. An
/// operation the table does not know is a loss, so it can never be trusted.
pub fn preview_kind_for_call(tool: &str, args: &Value) -> PreviewKind {
    if tool != "vault_desktop_write" {
        return preview_kind_for_tool(tool);
    }
    let operation = args["operation"].as_str();
    DESKTOP_WRITE_KINDS
        .iter()
        .find(|(name, _)| Some(*name) == operation)
        .map_or(PreviewKind::Loss, |(_, kind)| *kind)
}

/// The operations [`DESKTOP_WRITE_KINDS`] classifies, for the drift test against the vectors.
pub fn classified_desktop_writes() -> impl Iterator<Item = &'static str> {
    DESKTOP_WRITE_KINDS.iter().map(|(name, _)| *name)
}

/// The tools the preview table describes, for the drift test against the catalogue.
pub fn previewed_tools() -> impl Iterator<Item = &'static str> {
    PREVIEW_KINDS.iter().map(|(name, _)| *name)
}

pub struct GateInput<'a> {
    pub tool: &'a str,
    pub args: &'a Value,
    /// Standing approvals that die with the conversation.
    pub trust_list: &'a [String],
    /// Standing approvals that outlive it, revocable in Settings.
    pub vault_trust_list: &'a [String],
    pub mode: ToolApprovalMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    AutoApprove,
    AwaitUser {
        requires_diff: bool,
        preview_kind: PreviewKind,
    },
}

/// `decideToolGate` without `pendingDecision`, which Electron's gate always passes as null.
pub fn decide_tool_gate(input: &GateInput<'_>) -> Gate {
    let preview_kind = preview_kind_for_call(input.tool, input.args);
    // Tauri-only (#5143): a delete through the desktop API asks even in auto-accept mode.
    let desktop_delete = input.tool == "vault_desktop_write" && preview_kind == PreviewKind::Loss;
    if input.mode == ToolApprovalMode::AlwaysAccept && !desktop_delete {
        return Gate::AutoApprove;
    }
    if catalog().get(input.tool).map(|spec| spec.class) == Some(ToolClass::Read) {
        return Gate::AutoApprove;
    }
    let await_user = Gate::AwaitUser {
        requires_diff: preview_kind != PreviewKind::None,
        preview_kind,
    };
    // A delete is never trustable, and a rewrite of the user's own note or journal is reviewed
    // in the page every time.
    if preview_kind == PreviewKind::Loss || is_in_page_review_tool(input.tool) {
        return await_user;
    }
    let trusted = |list: &[String]| list.iter().any(|tool| tool == input.tool);
    if trusted(input.trust_list) || trusted(input.vault_trust_list) {
        return Gate::AutoApprove;
    }
    // Creates, updates and anything unrecognised ask; an unknown name asks without a preview.
    await_user
}

/// `reviewTargetForTool`: a journal update without a body stays in the agent pane.
pub fn review_target_for_tool(tool: &str, args: &Value) -> Option<ReviewTarget> {
    match tool {
        "vault_update_note" => args["id"]
            .as_str()
            .map(|id| ReviewTarget::Note { id: id.to_owned() }),
        "vault_update_journal_entry" if args["content_markdown"].is_string() => {
            args["date"].as_str().map(|date| ReviewTarget::Journal {
                date: date.to_owned(),
            })
        }
        _ => None,
    }
}
