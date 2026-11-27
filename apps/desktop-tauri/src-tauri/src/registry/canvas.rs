//! The canvas commands (the canvas folder ones stay in `registry.rs`), appended to the task
//! domain's lists by `registry/graph.rs`: `with_canvas_commands!(collect_commands![...])` hands
//! `collect_commands!` the list with these appended. Kept out of `registry.rs` for its line
//! ceiling.

macro_rules! with_canvas_commands {
    ($collect:ident![$($commands:tt)*]) => {
        $collect![
            $($commands)*
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
        ]
    };
}

pub(super) use with_canvas_commands;
