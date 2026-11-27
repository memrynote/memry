//! The graph commands (`graph_get_graph_data` and `graph_get_local_graph` are binary commands,
//! in `binary.rs`), appended to the task domain's lists by `registry/bookmarks.rs`:
//! `with_graph_commands!(collect_commands![...])` hands `collect_commands!` the list with these
//! appended. Kept out of `registry.rs` for its line ceiling.

macro_rules! with_graph_commands {
    ($collect:ident![$($commands:tt)*]) => {
        $collect![
            $($commands)*
            crate::commands::graph::graph_clear_layout::<Wry>,
            crate::commands::graph::graph_get_layout::<Wry>,
            crate::commands::graph::graph_save_layout::<Wry>,
        ]
    };
}

pub(super) use with_graph_commands;
