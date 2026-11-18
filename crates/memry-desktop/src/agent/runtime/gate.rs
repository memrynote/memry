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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewKind {
    None,
    Fields,
    Body,
    Loss,
}

/// `AgentReviewTargetSchema` (`ipc-agent.ts:694`): the page that reviews a body edit in place.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

/// The tools the preview table describes, for the drift test against the catalogue.
pub fn previewed_tools() -> impl Iterator<Item = &'static str> {
    PREVIEW_KINDS.iter().map(|(name, _)| *name)
}

pub struct GateInput<'a> {
    pub tool: &'a str,
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
    if input.mode == ToolApprovalMode::AlwaysAccept {
        return Gate::AutoApprove;
    }
    if catalog().get(input.tool).map(|spec| spec.class) == Some(ToolClass::Read) {
        return Gate::AutoApprove;
    }
    let preview_kind = preview_kind_for_tool(input.tool);
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
