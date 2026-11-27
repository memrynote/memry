//! The bookmark and recents commands and events, appended to the task domain's lists by
//! `registry/projects.rs`: `with_bookmark_commands!(collect_commands![...])` hands
//! `collect_commands!` the list with these appended, and `with_bookmark_events!` does the same
//! for `collect_events!`.

macro_rules! with_bookmark_commands {
    ($collect:ident![$($commands:tt)*]) => {
        $collect![
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
        ]
    };
}

macro_rules! with_bookmark_events {
    ($collect:ident![$($events:tt)*]) => {
        $collect![
            $($events)*
            crate::events::BookmarkCreatedEvent,
            crate::events::BookmarkDeletedEvent,
            crate::events::BookmarksReorderedEvent,
        ]
    };
}
