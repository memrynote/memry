//! The graph commands (`graph_get_graph_data` and `graph_get_local_graph` are binary
//! commands, in `binary.rs`).

macro_rules! graph {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::graph::graph_clear_layout::<Wry>,
            crate::commands::graph::graph_get_layout::<Wry>,
            crate::commands::graph::graph_save_layout::<Wry>,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [] $($chain)*)
    };
}
