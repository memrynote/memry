//! Regenerate `src/generated/bindings.ts` from Rust command signatures
//! and domain struct derives. Run via `pnpm bindings:generate`.
//!
//! The Phase F surface is a stress test: every `db/*` struct that derives
//! `specta::Type` is registered here so a typo or missing rename_all in any
//! domain module surfaces in the generated TS file. The 3 Tauri commands
//! exposed today (`settings_get`/`settings_set`/`settings_list`) are
//! collected via `collect_commands!`; subsequent milestones extend both
//! lists as their Rust implementations land.

use memry_desktop_tauri_lib::commands;
use memry_desktop_tauri_lib::db;
use memry_desktop_tauri_lib::error::AppError;
use specta_typescript::Typescript;
use tauri_specta::{collect_commands, Builder};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let builder = Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::settings::settings_list,
        ])
        .typ::<AppError>()
        .typ::<db::bookmarks::Bookmark>()
        .typ::<db::calendar_bindings::CalendarBinding>()
        .typ::<db::calendar_events::CalendarEvent>()
        .typ::<db::calendar_external_events::CalendarExternalEvent>()
        .typ::<db::calendar_sources::CalendarSource>()
        .typ::<db::folder_configs::FolderConfig>()
        .typ::<db::inbox::InboxItem>()
        .typ::<db::note_metadata::NoteMetadata>()
        .typ::<db::note_positions::NotePosition>()
        .typ::<db::notes_cache::PropertyDefinition>()
        .typ::<db::projects::Project>()
        .typ::<db::reminders::Reminder>()
        .typ::<db::saved_filters::SavedFilter>()
        .typ::<db::search_reasons::SearchReason>()
        .typ::<db::settings::Setting>()
        .typ::<db::statuses::Status>()
        .typ::<db::sync_devices::SyncDevice>()
        .typ::<db::sync_history::SyncHistoryEntry>()
        .typ::<db::sync_queue::SyncQueueItem>()
        .typ::<db::sync_state::SyncState>()
        .typ::<db::tag_definitions::TagDefinition>()
        .typ::<db::tasks::Task>();

    builder.export(Typescript::default(), "../src/generated/bindings.ts")?;

    Ok(())
}
