//! The canvas and canvas folder commands and events. `canvas_folders` sits apart from `canvas`
//! in the chain because its commands reach the bindings earlier.

macro_rules! canvas_folders {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::canvas_folders::canvas_folder_create::<Wry>,
            crate::commands::canvas_folders::canvas_folder_delete::<Wry>,
            crate::commands::canvas_folders::canvas_folder_list::<Wry>,
            crate::commands::canvas_folders::canvas_folder_move::<Wry>,
            crate::commands::canvas_folders::canvas_folder_rename::<Wry>,
            crate::commands::canvas_folders::canvas_folder_set_icon::<Wry>,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [] $($chain)*)
    };
}

macro_rules! canvas {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::canvas::canvas_can_upload_asset,
            crate::commands::canvas::canvas_create::<Wry>,
            crate::commands::canvas::canvas_delete::<Wry>,
            crate::commands::canvas::canvas_duplicate::<Wry>,
            crate::commands::canvas::canvas_get::<Wry>,
            crate::commands::canvas::canvas_get_asset::<Wry>,
            crate::commands::canvas::canvas_library_list::<Wry>,
            crate::commands::canvas::canvas_library_save::<Wry>,
            crate::commands::canvas::canvas_list::<Wry>,
            crate::commands::canvas::canvas_list_assets::<Wry>,
            crate::commands::canvas::canvas_live_closed::<Wry>,
            crate::commands::canvas::canvas_live_opened::<Wry>,
            crate::commands::canvas::canvas_open_external,
            crate::commands::canvas::canvas_reveal_in_finder,
            crate::commands::canvas::canvas_update::<Wry>,
            crate::commands::canvas::canvas_upload_asset::<Wry>,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::CanvasCreatedEvent,
            crate::events::CanvasDeletedEvent,
            crate::events::CanvasFolderCreatedEvent,
            crate::events::CanvasFolderDeletedEvent,
            crate::events::CanvasFolderUpdatedEvent,
            crate::events::CanvasTooLargeEvent,
            crate::events::CanvasUpdatedEvent,
        ] $($chain)*)
    };
}
