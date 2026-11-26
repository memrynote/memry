//! The bookmark and recents commands and events, kept out of `registry.rs`'s single list by a
//! callback: `with_bookmark_commands!(with_task_commands!(collect_commands![...]))` hands the
//! next macro the list with these appended, and `with_bookmark_events!` does the same for events.

macro_rules! with_bookmark_commands {
    ($next:ident!($collect:ident![$($commands:tt)*])) => {
        $next!($collect![
            $($commands)*
            crate::commands::bookmarks::bookmarks_bulk_create::<Wry>,
            crate::commands::bookmarks::bookmarks_bulk_delete::<Wry>,
            crate::commands::bookmarks::bookmarks_create::<Wry>,
            crate::commands::bookmarks::bookmarks_delete::<Wry>,
            crate::commands::bookmarks::bookmarks_get::<Wry>,
            crate::commands::bookmarks::bookmarks_get_by_item::<Wry>,
            crate::commands::bookmarks::bookmarks_is_bookmarked::<Wry>,
            crate::commands::bookmarks::bookmarks_list::<Wry>,
            crate::commands::bookmarks::bookmarks_list_by_type::<Wry>,
            crate::commands::bookmarks::bookmarks_reorder::<Wry>,
            crate::commands::bookmarks::bookmarks_toggle::<Wry>,
            crate::commands::recents::recents_list::<Wry>,
            crate::commands::recents::recents_record::<Wry>,
        ])
    };
}

macro_rules! with_bookmark_events {
    ($next:ident!($collect:ident![$($events:tt)*])) => {
        $next!($collect![
            $($events)*
            crate::events::BookmarkCreatedEvent,
            crate::events::BookmarkDeletedEvent,
            crate::events::BookmarksReorderedEvent,
        ])
    };
}
