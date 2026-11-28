//! The template commands and events.

macro_rules! templates {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::templates::templates_create,
            crate::commands::templates::templates_delete,
            crate::commands::templates::templates_duplicate,
            crate::commands::templates::templates_get,
            crate::commands::templates::templates_list,
            crate::commands::templates::templates_update,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::TemplateCreatedEvent,
            crate::events::TemplateDeletedEvent,
            crate::events::TemplateUpdatedEvent,
        ] $($chain)*)
    };
}
