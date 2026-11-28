//! The agent commands and event.

macro_rules! agent {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::agent::agent_edit_vault_trust_list::<Wry>,
            crate::commands::agent::agent_get_local_provider_settings::<Wry>,
            crate::commands::agent::agent_get_tool_call::<Wry>,
            crate::commands::agent::agent_get_tool_grants::<Wry>,
            crate::commands::agent::agent_list_local_models::<Wry>,
            crate::commands::agent::agent_probe_local_provider::<Wry>,
            crate::commands::agent::agent_set_local_provider_settings::<Wry>,
            crate::commands::agent::agent_test_local_provider::<Wry>,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::AgentEventEmittedEvent,
        ] $($chain)*)
    };
}
