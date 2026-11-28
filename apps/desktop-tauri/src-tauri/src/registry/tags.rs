//! The tag commands and events.

macro_rules! tags {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::tag_schema::tags_edit_schema,
            crate::commands::tag_schema::tags_get_linked_here,
            crate::commands::tag_schema::tags_get_schema_snapshot,
            crate::commands::tag_schema::tags_preview_impact,
            crate::commands::tag_schema::tags_search_objects,
            crate::commands::tags::tags_create_category,
            crate::commands::tags::tags_delete_category,
            crate::commands::tags::tags_get_all_with_counts,
            crate::commands::tags::tags_get_notes_by_tag,
            crate::commands::tags::tags_is_gone,
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
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::TagCategoriesChangedEvent,
            crate::events::TagColorUpdatedEvent,
            crate::events::TagDeletedEvent,
            crate::events::TagNotesChangedEvent,
            crate::events::TagRenamedEvent,
            crate::events::TagsProgressEvent,
        ] $($chain)*)
    };
}
