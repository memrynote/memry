//! The folder view commands.

macro_rules! folder_view {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::folder_view::folder_view_available_properties,
            crate::commands::folder_view::folder_view_delete_view,
            crate::commands::folder_view::folder_view_folder_exists,
            crate::commands::folder_view::folder_view_get_config,
            crate::commands::folder_view::folder_view_get_views,
            crate::commands::folder_view::folder_view_list,
            crate::commands::folder_view::folder_view_set_config,
            crate::commands::folder_view::folder_view_set_view,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [] $($chain)*)
    };
}
