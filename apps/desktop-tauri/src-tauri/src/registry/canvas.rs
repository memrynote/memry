//! The canvas and canvas folder commands and events.

macro_rules! canvas {
    (commands $($chain:tt)*) => {
        chain!(commands [
            // canvas (the asset and live-canvas commands are not ported yet)
            crate::commands::canvas::canvas_create::<Wry>,
            crate::commands::canvas::canvas_delete::<Wry>,
            crate::commands::canvas::canvas_duplicate::<Wry>,
            crate::commands::canvas::canvas_get::<Wry>,
            crate::commands::canvas::canvas_library_list::<Wry>,
            crate::commands::canvas::canvas_library_save::<Wry>,
            crate::commands::canvas::canvas_list::<Wry>,
            crate::commands::canvas::canvas_open_external,
            crate::commands::canvas::canvas_reveal_in_finder,
            crate::commands::canvas::canvas_update::<Wry>,
            crate::commands::canvas_folders::canvas_folder_create::<Wry>,
            crate::commands::canvas_folders::canvas_folder_delete::<Wry>,
            crate::commands::canvas_folders::canvas_folder_list::<Wry>,
            crate::commands::canvas_folders::canvas_folder_move::<Wry>,
            crate::commands::canvas_folders::canvas_folder_rename::<Wry>,
            crate::commands::canvas_folders::canvas_folder_set_icon::<Wry>,
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
