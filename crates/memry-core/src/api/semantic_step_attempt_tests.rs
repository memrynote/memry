use super::*;

#[tokio::test]
async fn a_note_whose_window_dies_with_the_process_is_skipped_until_it_changes() {
    let mut s = setup().await;
    let (open, gate) = channel();
    let (entered, inside) = channel();
    s.semantic = s.build(Some((Arc::new(Mutex::new(gate)), entered)));
    s.write("a", "Alpha", "the window that takes the process down");
    s.write("b", "Beta", "the note behind it");

    tokio::select! {
        outcome = s.step() => panic!("the window returned: {outcome:?}"),
        _ = tokio::task::spawn_blocking(move || inside.recv().unwrap()) => {}
    }
    open.send(()).unwrap();

    s.relaunch();
    assert_eq!(s.finish().await, (1, 2), "b embedded behind a");
    let ids: Vec<String> = s.states().into_iter().map(|state| state.note_id).collect();
    assert_eq!(ids, ["b"], "a died mid-window and writes no state row");

    s.relaunch();
    assert_eq!(s.finish().await, (1, 2), "a second relaunch still skips a");

    s.edit_body("a", 2, "an edit appended to the body");
    assert_eq!(s.finish().await, (2, 2), "the edit retries a");
}

#[tokio::test]
async fn a_poisoned_session_stops_the_step_and_does_not_skip_the_note() {
    let s = setup().await;
    s.write("a", "Alpha", "an innocent note body");
    s.step().await;
    s.write("b", "Beta", "the note that meets the broken session");
    s.poisoned.store(true, Ordering::SeqCst);

    let poisoned = s.semantic.embed_step(s.vault.clone(), COOL).await;
    assert!(
        matches!(poisoned, Err(SemanticError::Poisoned)),
        "{poisoned:?}"
    );
    assert_eq!(s.finish().await, (2, 2), "b embedded on a fresh session");
    assert_eq!(
        s.loads.load(Ordering::SeqCst),
        2,
        "the session was reloaded"
    );
}
