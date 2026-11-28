//! The AI model, inline AI and structured AI commands and events.

macro_rules! ai {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::ai::ai_get_model_status::<Wry>,
            crate::commands::ai::ai_inline_get_settings::<Wry>,
            crate::commands::ai::ai_inline_list_models,
            crate::commands::ai::ai_inline_set_settings::<Wry>,
            crate::commands::ai::ai_inline_test_connection,
            crate::commands::ai::ai_load_model::<Wry>,
            crate::commands::ai::ai_provider_cancel::<Wry>,
            crate::commands::ai::ai_reindex_embeddings::<Wry>,
            crate::commands::ai_structured::tags_fill_fields::<Wry>,
            crate::commands::ai_structured::tags_fill_status::<Wry>,
            crate::commands::ai_structured::writing_generate_assist::<Wry>,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::AiEmbeddingProgressEvent,
            crate::events::AiInlineSettingsChangedEvent,
        ] $($chain)*)
    };
}
