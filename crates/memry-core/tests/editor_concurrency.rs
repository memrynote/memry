//! The editor host under a concurrent reader (Step 14a review): a window's sync
//! handshake reading a document while another window types into it refuses no
//! edit, so no later edit waits on a missing one.

#![cfg(feature = "markdown")]

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use crate::editor_support::{Replica, fixture};

#[test]
fn a_reader_beside_three_thousand_edits_refuses_none_and_the_body_survives_a_relaunch() {
    let f = fixture();
    let note = f.note();
    let window = Replica::from_state(1, &f.editor.open(&note, "main").expect("open").state);
    let stop = Arc::new(AtomicBool::new(false));
    let reader = {
        let editor = Arc::clone(&f.editor);
        let note = note.clone();
        let stop = Arc::clone(&stop);
        thread::spawn(move || {
            let mut reads = 0usize;
            let mut seen = vec![0];
            while !stop.load(Ordering::Relaxed) {
                // A handshake as a second window runs it: what is new since
                // the state vector it last saw.
                editor.state_diff(&note, &seen).expect("a diff");
                seen = editor.state_vector(&note).expect("a state vector");
                reads += 1;
                thread::yield_now();
            }
            reads
        })
    };

    for n in 0..3000 {
        let update = window.type_text("x");
        if let Err(error) = f.editor.apply_update(&note, &update, "main") {
            stop.store(true, Ordering::Relaxed);
            panic!("edit {n} was refused: {error}");
        }
    }
    stop.store(true, Ordering::Relaxed);
    assert!(reader.join().expect("the reader never failed") > 0);

    let typed = window.text();
    let f = f.relaunch();
    let reopened = Replica::from_state(2, &f.editor.open(&note, "main").expect("reopen").state);
    assert_eq!(reopened.text(), typed);
}
