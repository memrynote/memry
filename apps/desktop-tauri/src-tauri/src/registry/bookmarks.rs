//! The bookmark and recents commands and events.

macro_rules! bookmarks {
    (commands $($chain:tt)*) => {
        chain!(commands [
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
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::BookmarkCreatedEvent,
            crate::events::BookmarkDeletedEvent,
            crate::events::BookmarksReorderedEvent,
        ] $($chain)*)
    };
}
