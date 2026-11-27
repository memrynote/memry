//! The command and event lists. A new command or event goes in `registry/<area>.rs`; a new area
//! adds its module below and its name to `areas!`.

use tauri::Wry;
use tauri_specta::{Builder, ErrorHandlingMode, collect_commands, collect_events};

use crate::startup::StartupState;

/// `chain!(kind [entries] collect [list] area...)` appends an area's `entries` to `list` and
/// hands the result to the next area's macro (`area!(kind collect [list] area...)`), and to
/// `collect![list]` after the last one. Each `registry/<area>.rs` macro answers `commands` and
/// `events` with its own entries, so an area's change edits only its own file.
macro_rules! chain {
    ($kind:ident [$($entries:tt)*] $collect:ident [$($list:tt)*]) => {
        $collect![$($list)* $($entries)*]
    };
    ($kind:ident [$($entries:tt)*] $collect:ident [$($list:tt)*] $area:ident $($areas:ident)*) => {
        $area!($kind $collect [$($list)* $($entries)*] $($areas)*)
    };
}

/// Every area. The order is the order of the commands in `bindings.ts`; put a new area beside a
/// related one rather than at the end, where every new area would edit the same line.
macro_rules! areas {
    ($kind:ident $collect:ident) => {
        chain!(
            $kind [] $collect []
            account
            agent
            ai
            app
            billing
            calendar_sources
            canvas
            editor
            custom_icons
            devices
            diagnostics
            drop_stage
            feedback
            shell_integrations
            fold
            folder_view
            home_pages
            readwise
            ios_beta
            journal
            launch
            locale
            linking
            notes
            notification
            ocr_languages
            onboarding
            portals
            properties
            shortcuts
            spell
            fonts
            logging
            menu
            search
            settings
            shell
            sync
            sync_account
            tags
            telemetry
            templates
            terminal_command
            unsplash
            updater
            vault
            voice
            window
            calendar
            inbox
            tasks
            projects
            bookmarks
            reminders
            stickies
            graph
        )
    };
}

#[macro_use]
mod account;
#[macro_use]
mod agent;
#[macro_use]
mod ai;
#[macro_use]
mod app;
#[macro_use]
mod billing;
#[macro_use]
mod bookmarks;
#[macro_use]
mod calendar;
#[macro_use]
mod canvas;
#[macro_use]
mod custom_icons;
#[macro_use]
mod devices;
#[macro_use]
mod diagnostics;
#[macro_use]
mod drop_stage;
#[macro_use]
mod editor;
#[macro_use]
mod feedback;
#[macro_use]
mod fold;
#[macro_use]
mod folder_view;
#[macro_use]
mod fonts;
#[macro_use]
mod graph;
#[macro_use]
mod home_pages;
#[macro_use]
mod inbox;
#[macro_use]
mod ios_beta;
#[macro_use]
mod journal;
#[macro_use]
mod launch;
#[macro_use]
mod linking;
#[macro_use]
mod locale;
#[macro_use]
mod logging;
#[macro_use]
mod menu;
#[macro_use]
mod notes;
#[macro_use]
mod notification;
#[macro_use]
mod ocr_languages;
#[macro_use]
mod onboarding;
#[macro_use]
mod portals;
#[macro_use]
mod projects;
#[macro_use]
mod properties;
#[macro_use]
mod readwise;
#[macro_use]
mod reminders;
#[macro_use]
mod search;
#[macro_use]
mod settings;
#[macro_use]
mod shell;
#[macro_use]
mod shell_integrations;
#[macro_use]
mod shortcuts;
#[macro_use]
mod spell;
#[macro_use]
mod stickies;
#[macro_use]
mod sync;
#[macro_use]
mod sync_account;
#[macro_use]
mod tags;
#[macro_use]
mod tasks;
#[macro_use]
mod telemetry;
#[macro_use]
mod templates;
#[macro_use]
mod terminal_command;
#[macro_use]
mod unsplash;
#[macro_use]
mod updater;
#[macro_use]
mod vault;
#[macro_use]
mod voice;
#[macro_use]
mod window;
mod dispatch;
mod permission;

pub use dispatch::{dispatcher, invoke_handler};
pub use permission::app_all_permission;

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
        .commands(areas!(commands collect_commands))
        .events(areas!(events collect_events))
        .typ::<StartupState>()
        // `ai_provider_request` is a binary command; its argument and answer still get types.
        .typ::<memry_desktop::ai::proxy::AiProviderRequest>()
        .typ::<memry_desktop::ai::proxy::AiProviderHead>()
}
