//! The single command list. Add a domain's commands under its comment, one fully qualified path
//! per line, domains in alphabetical order, and its module under `src/commands/`.

use tauri::ipc::Invoke;
use tauri::{Runtime, Wry};
use tauri_specta::{Builder, ErrorHandlingMode, collect_commands, collect_events};

use crate::binary;
use crate::startup::StartupState;

pub fn builder() -> Builder<Wry> {
    Builder::<Wry>::new()
        // A rejected command throws the serialized `CommandError`, which `extractErrorMessage`
        // reads; no `{ status }` result wrapper in the renderer.
        .error_handling(ErrorHandlingMode::Throw)
        // Every `i64` that crosses IPC is an epoch-millisecond timestamp, a count or a size,
        // which the Electron renderer already holds as a JavaScript number. Ids and hashes
        // travel as strings.
        .dangerously_cast_bigints_to_number()
        // One type per struct: the renderer reads `StartupState` and never writes it.
        .disable_serde_phases()
        .commands(collect_commands![
            // agent
            crate::commands::agent::agent_get_local_provider_settings::<Wry>,
            crate::commands::agent::agent_list_local_models::<Wry>,
            crate::commands::agent::agent_probe_local_provider::<Wry>,
            crate::commands::agent::agent_set_local_provider_settings::<Wry>,
            crate::commands::agent::agent_test_local_provider::<Wry>,
            // ai
            crate::commands::ai::ai_inline_get_settings::<Wry>,
            crate::commands::ai::ai_inline_list_models,
            crate::commands::ai::ai_inline_set_settings::<Wry>,
            crate::commands::ai::ai_inline_test_connection,
            crate::commands::ai::ai_provider_cancel::<Wry>,
            crate::commands::ai_structured::tags_fill_fields::<Wry>,
            crate::commands::ai_structured::tags_fill_status::<Wry>,
            crate::commands::ai_structured::writing_generate_assist::<Wry>,
            // app
            crate::commands::app::app_info,
            // crdt (`crdt_open_doc`, `crdt_apply_update` and the sync steps are binary commands)
            crate::commands::editor::crdt_close_doc::<Wry>,
            crate::commands::editor::crdt_get_health::<Wry>,
            crate::commands::editor::crdt_typing_sent::<Wry>,
            // custom icons (`custom_icons_add` is a binary command)
            crate::commands::custom_icons::custom_icons_add_from_url,
            crate::commands::custom_icons::custom_icons_delete,
            crate::commands::custom_icons::custom_icons_list,
            crate::commands::custom_icons::custom_icons_rename,
            // diagnostics
            crate::commands::diagnostics::diagnostics_preview_report,
            crate::commands::diagnostics::diagnostics_send_report,
            // drop staging
            crate::commands::drop_stage::drop_os_drag_uris,
            crate::commands::drop_stage::drop_stage_begin,
            crate::commands::drop_stage::drop_stage_finish,
            crate::commands::drop_stage::drop_stage_os_files,
            crate::commands::drop_stage::drop_stage_release,
            // feedback
            crate::commands::telemetry::feedback_submit,
            // badge
            crate::commands::shell_integrations::badge_set,
            // flush
            crate::commands::shell_integrations::flush_done,
            crate::commands::shell_integrations::flush_ready,
            // fold
            crate::commands::fold::fold_get_agent_status::<Wry>,
            crate::commands::fold::fold_run::<Wry>,
            // ios beta
            crate::commands::ios_beta::ios_beta_join,
            // journal
            crate::commands::journal::journal_create_entry::<Wry>,
            crate::commands::journal::journal_cross_into_notes::<Wry>,
            crate::commands::journal::journal_delete_entry::<Wry>,
            crate::commands::journal::journal_get_day_context::<Wry>,
            crate::commands::journal::journal_get_entry::<Wry>,
            crate::commands::journal::journal_get_heatmap::<Wry>,
            crate::commands::journal::journal_get_month_entries::<Wry>,
            crate::commands::journal::journal_get_property_rows::<Wry>,
            crate::commands::journal::journal_get_same_day_entries::<Wry>,
            crate::commands::journal::journal_get_streak::<Wry>,
            crate::commands::journal::journal_get_year_stats::<Wry>,
            crate::commands::journal::journal_update_entry::<Wry>,
            // locale
            crate::commands::locale::locale_get,
            crate::commands::locale::locale_list,
            crate::commands::locale::locale_set,
            // notes (`notes_upload_attachment` and `notes_upload_attachment_chunk` are binary
            // commands)
            crate::commands::attachment_sources::notes_download_attachment_from_url::<Wry>,
            crate::commands::attachment_sources::notes_insert_existing_attachment::<Wry>,
            crate::commands::attachment_sources::notes_list_vault_attachments::<Wry>,
            crate::commands::attachments::notes_attachment_open_external,
            crate::commands::attachments::notes_attachment_rename::<Wry>,
            crate::commands::attachments::notes_attachment_resolve::<Wry>,
            crate::commands::attachments::notes_attachment_reveal_in_finder,
            crate::commands::attachments::notes_delete_attachment::<Wry>,
            crate::commands::attachments::notes_list_attachments::<Wry>,
            crate::commands::attachments::notes_upload_attachment_abort::<Wry>,
            crate::commands::attachments::notes_upload_attachment_begin::<Wry>,
            crate::commands::folders::notes_create_folder::<Wry>,
            crate::commands::folders::notes_delete_folder::<Wry>,
            crate::commands::folders::notes_get_folder_config::<Wry>,
            crate::commands::folders::notes_get_folder_template::<Wry>,
            crate::commands::folders::notes_get_folders::<Wry>,
            crate::commands::folders::notes_rename_folder::<Wry>,
            crate::commands::folders::notes_reveal_folder_in_finder,
            crate::commands::folders::notes_set_folder_config::<Wry>,
            crate::commands::notes::notes_create::<Wry>,
            crate::commands::notes::notes_delete,
            crate::commands::notes::notes_edit_aliases::<Wry>,
            crate::commands::notes::notes_exists,
            crate::commands::notes::notes_get,
            crate::commands::notes::notes_get_all_positions::<Wry>,
            crate::commands::notes::notes_get_by_path,
            crate::commands::notes::notes_get_file,
            crate::commands::notes::notes_get_links,
            crate::commands::notes::notes_get_local_only_count,
            crate::commands::notes::notes_get_unlinked_mentions,
            crate::commands::notes::notes_link_mention::<Wry>,
            crate::commands::notes::notes_list::<Wry>,
            crate::commands::notes::notes_open_external,
            crate::commands::notes::notes_preview_by_title,
            crate::commands::notes::notes_move::<Wry>,
            crate::commands::notes::notes_rename::<Wry>,
            crate::commands::notes::notes_update::<Wry>,
            crate::commands::notes::notes_apply_template::<Wry>,
            crate::commands::notes::notes_append_blocks::<Wry>,
            crate::commands::notes::notes_undo_tag_template::<Wry>,
            crate::commands::notes::notes_reorder::<Wry>,
            crate::commands::notes::notes_resolve_by_title,
            crate::commands::notes::notes_resolve_titles,
            crate::commands::notes::notes_resolve_wiki_target,
            crate::commands::notes::notes_reveal_in_finder,
            crate::commands::notes::notes_set_local_only,
            // notes: large files
            crate::commands::large_file::notes_large_file_close,
            crate::commands::large_file::notes_large_file_open,
            crate::commands::large_file::notes_large_file_read_lines,
            crate::commands::large_file::notes_large_file_search,
            // notes: property definitions
            crate::commands::property_definitions::notes_add_property_option,
            crate::commands::property_definitions::notes_add_status_option,
            crate::commands::property_definitions::notes_create_property_definition,
            crate::commands::property_definitions::notes_delete_property_definition,
            crate::commands::property_definitions::notes_ensure_property_definition,
            crate::commands::property_definitions::notes_get_calendar_property_names,
            crate::commands::property_definitions::notes_get_property_definitions,
            crate::commands::property_definitions::notes_get_property_usage,
            crate::commands::property_definitions::notes_list_notes_with_property,
            crate::commands::property_definitions::notes_remove_property_option,
            crate::commands::property_definitions::notes_rename_property_option,
            crate::commands::property_definitions::notes_set_calendar_property_visibility,
            crate::commands::property_definitions::notes_update_option_color,
            crate::commands::property_definitions::notes_update_property_definition,
            crate::commands::unsplash::notes_download_unsplash_photo,
            // notes: versions
            crate::commands::notes_versions::notes_delete_version,
            crate::commands::notes_versions::notes_get_version,
            crate::commands::notes_versions::notes_get_versions,
            crate::commands::notes_versions::notes_restore_version,
            // notification
            crate::commands::shell_integrations::notification_permission,
            crate::commands::shell_integrations::notification_show,
            crate::commands::shell_integrations::notification_supported,
            // portals
            crate::commands::portals::portals_get_usage::<Wry>,
            crate::commands::portals::portals_search::<Wry>,
            crate::commands::portals::portals_stamp_anchor::<Wry>,
            // properties
            crate::commands::properties::properties_get::<Wry>,
            crate::commands::properties::properties_merge::<Wry>,
            crate::commands::properties::properties_rename::<Wry>,
            crate::commands::properties::properties_resolve_refs::<Wry>,
            crate::commands::properties::properties_set::<Wry>,
            // shortcut
            crate::commands::shortcuts::shortcut_register_global_capture,
            crate::commands::shortcuts::shortcut_set_global_capture,
            // spell
            crate::commands::spell::spell_check_word,
            crate::commands::spell::spell_add_word,
            crate::commands::spell::spell_add_words,
            // fonts
            crate::fonts::system_fonts_list,
            // log
            crate::commands::logging::log_write,
            // menu
            crate::commands::shell::menu_hide_alt,
            crate::commands::shell::menu_toggle_alt,
            // settings
            crate::commands::settings::app_set_zoom_factor,
            crate::commands::settings::settings_get_ai,
            crate::commands::settings::settings_get_group,
            crate::commands::settings::settings_get_local,
            crate::commands::settings::settings_get_path,
            crate::commands::settings::settings_reset_keyboard,
            crate::commands::settings::settings_set_ai,
            crate::commands::settings::settings_set_group,
            crate::commands::settings::settings_set_local,
            // shell
            crate::commands::shell::shell_clipboard_read_text,
            crate::commands::shell::shell_first_paint,
            crate::commands::shell::shell_heartbeat,
            crate::commands::shell::shell_show_context_menu,
            crate::commands::shell::shell_open_external,
            crate::commands::shell::shell_open_link,
            crate::commands::shell::shell_open_path,
            crate::commands::shell::shell_reveal_path,
            crate::commands::shell::shell_take_crash_reload,
            // tags
            crate::commands::tag_schema::tags_edit_schema,
            crate::commands::tag_schema::tags_get_linked_here,
            crate::commands::tag_schema::tags_get_schema_snapshot,
            crate::commands::tag_schema::tags_preview_impact,
            crate::commands::tag_schema::tags_search_objects,
            crate::commands::tags::tags_create_category,
            crate::commands::tags::tags_delete_category,
            crate::commands::tags::tags_get_all_with_counts,
            crate::commands::tags::tags_get_notes_by_tag,
            crate::commands::tags::tags_list_categories,
            crate::commands::tags::tags_pin_note_to_tag::<Wry>,
            crate::commands::tags::tags_rename::<Wry>,
            crate::commands::tags::tags_rename_abandon::<Wry>,
            crate::commands::tags::tags_rename_unfinished::<Wry>,
            crate::commands::tags::tags_rename_category,
            crate::commands::tags_retag::tags_delete::<Wry>,
            crate::commands::tags_retag::tags_merge::<Wry>,
            crate::commands::tags_retag::tags_remove_from_note::<Wry>,
            crate::commands::tags::tags_reorder,
            crate::commands::tags::tags_unpin_note_from_tag::<Wry>,
            crate::commands::tags::tags_update_color,
            crate::commands::tags::tags_update_icon,
            // telemetry
            crate::commands::telemetry::telemetry_flush,
            crate::commands::telemetry::telemetry_get_settings,
            crate::commands::telemetry::telemetry_set_auto_send_diagnostics,
            crate::commands::telemetry::telemetry_set_enabled,
            crate::commands::telemetry::telemetry_track,
            // templates
            crate::commands::templates::templates_create,
            crate::commands::templates::templates_delete,
            crate::commands::templates::templates_duplicate,
            crate::commands::templates::templates_get,
            crate::commands::templates::templates_list,
            crate::commands::templates::templates_update,
            // unsplash
            crate::commands::unsplash::unsplash_search,
            // updater
            crate::commands::updater::updater_check_for_updates,
            crate::commands::updater::updater_download_update,
            crate::commands::updater::updater_get_state,
            crate::commands::updater::updater_quit_and_install,
            crate::commands::updater::updater_set_auto_check,
            crate::commands::updater::updater_set_auto_download,
            crate::commands::updater::updater_skip_version,
            // vault
            crate::commands::vault::vault_close,
            crate::commands::vault::vault_create,
            crate::commands::vault::vault_get_config::<Wry>,
            crate::commands::vault::vault_get_default_parent,
            crate::commands::vault::vault_get_status,
            crate::commands::vault::vault_list,
            crate::commands::vault::vault_remove,
            crate::commands::vault::vault_reveal,
            crate::commands::vault::vault_select,
            crate::commands::vault::vault_set_default,
            crate::commands::vault::vault_set_icon,
            crate::commands::vault::vault_switch,
            crate::commands::vault::vault_update_config::<Wry>,
            // vault activity
            crate::commands::vault_activity::vault_activity_clear,
            crate::commands::vault_activity::vault_activity_list,
            crate::commands::vault_activity::vault_activity_reveal,
            crate::commands::vault_activity::vault_activity_set_retention,
            // vault index
            crate::commands::vault_index::vault_reindex,
            // vault files
            crate::commands::vault_files::vault_resolve_embeds,
            // vault locks
            crate::commands::vault_locks::vault_locks_list::<Wry>,
            crate::commands::vault_locks::vault_locks_set::<Wry>,
            // vault notices
            crate::commands::vault_notices::vault_notices_delete_kept,
            crate::commands::vault_notices::vault_notices_list,
            crate::commands::vault_notices::vault_notices_restore_kept,
            // window
            crate::commands::shell::window_close,
            crate::commands::shell::window_minimize,
            crate::commands::shell::window_set_caption_rects,
            crate::commands::shell::window_toggle_maximize,
        ])
        .events(collect_events![
            // ai
            crate::events::AiInlineSettingsChangedEvent,
            // app
            crate::events::AppNavigationRequestedEvent,
            // crdt
            crate::events::CrdtProviderReadyEvent,
            crate::events::CrdtProviderResetEvent,
            crate::events::CrdtWriteBackFailedEvent,
            // custom icons
            crate::events::CustomIconsUpdatedEvent,
            // flush
            crate::events::FlushRequestedEvent,
            // inbox
            crate::events::InboxOpenItemEvent,
            // journal
            crate::events::JournalEntryCreatedEvent,
            crate::events::JournalEntryDeletedEvent,
            crate::events::JournalEntryUpdatedEvent,
            crate::events::JournalEventsDroppedEvent,
            crate::events::JournalExternalChangeEvent,
            // locale
            crate::events::LocaleChangedEvent,
            // settings
            crate::events::SettingsChangedEvent,
            crate::events::SettingsOpenSectionEvent,
            // menu
            crate::events::MenuCommandInvokedEvent,
            // templates
            crate::events::TemplateCreatedEvent,
            crate::events::TemplateDeletedEvent,
            crate::events::TemplateUpdatedEvent,
            // updater
            crate::events::UpdaterStateChangedEvent,
            // notes
            crate::events::FolderConfigUpdatedEvent,
            crate::events::NoteCreatedEvent,
            crate::events::NoteDeletedEvent,
            crate::events::NoteEventsDroppedEvent,
            crate::events::NoteLinksChangedEvent,
            crate::events::NoteMovedEvent,
            crate::events::NoteOutsideEditKeptEvent,
            crate::events::NoteRenamedEvent,
            crate::events::NoteTagsChangedEvent,
            crate::events::NoteUpdatedEvent,
            crate::events::PropertyDefinitionChangedEvent,
            // portals
            crate::events::PortalsUsageChangedEvent,
            // tags
            crate::events::TagCategoriesChangedEvent,
            crate::events::TagColorUpdatedEvent,
            crate::events::TagDeletedEvent,
            crate::events::TagNotesChangedEvent,
            crate::events::TagRenamedEvent,
            crate::events::TagsProgressEvent,
            // vault
            crate::events::VaultActivityChangedEvent,
            crate::events::VaultConfigChangedEvent,
            crate::events::VaultErrorEvent,
            crate::events::VaultIndexProgressEvent,
            crate::events::VaultIndexRecoveredEvent,
            crate::events::VaultListChangedEvent,
            crate::events::VaultNoticesChangedEvent,
            crate::events::VaultStatusChangedEvent,
            // vault locks
            crate::events::VaultLocksChangedEvent,
            crate::events::VaultLocksExternalEditRestoredEvent,
            // window
            crate::events::WindowCaptionHoverChangedEvent,
            crate::events::WindowCaptionPressedChangedEvent,
            crate::events::WindowChromeStateChangedEvent,
        ])
        .typ::<StartupState>()
        // `ai_provider_request` is a binary command; its argument and answer still get types.
        .typ::<memry_desktop::ai::proxy::AiProviderRequest>()
        .typ::<memry_desktop::ai::proxy::AiProviderHead>()
}

/// Sends a call to the binary handler when `command` is one of `binary_commands` and to the
/// specta handler otherwise. Step 03 (#3520) wraps this closure with its `e2e_` dispatcher.
pub fn dispatcher<R: Runtime>(
    binary_commands: &'static [&'static str],
    binary_handler: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
    typed_handler: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        if binary_commands.contains(&invoke.message.command()) {
            binary_handler(invoke)
        } else {
            typed_handler(invoke)
        }
    }
}

pub fn invoke_handler(
    builder: &Builder<Wry>,
) -> impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static {
    dispatcher(
        binary::COMMANDS,
        binary::handler(),
        builder.invoke_handler(),
    )
}
