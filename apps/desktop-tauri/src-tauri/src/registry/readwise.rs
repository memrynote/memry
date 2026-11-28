//! The Readwise import commands and event.

macro_rules! readwise {
    (commands $($chain:tt)*) => {
        chain!(commands [
            // import (Readwise)
            crate::commands::readwise::import_readwise_ack_error_toast,
            crate::commands::readwise::import_readwise_cancel,
            crate::commands::readwise::import_readwise_connect,
            crate::commands::readwise::import_readwise_disconnect,
            crate::commands::readwise::import_readwise_set_options,
            crate::commands::readwise::import_readwise_status,
            crate::commands::readwise::import_readwise_sync_now,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            // import (Readwise)
            crate::events::ImportReadwiseStatusChangedEvent,
        ] $($chain)*)
    };
}
