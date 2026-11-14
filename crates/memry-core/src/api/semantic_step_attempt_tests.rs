use super::*;

impl Setup {
    /// Leaves a window of the next due note running when the process dies.
    async fn kill_mid_window(&mut self) {
        let (open, gate) = channel();
        let (entered, inside) = channel();
        self.semantic = self.build(Some((Arc::new(Mutex::new(gate)), entered)));
        tokio::select! {
            outcome = self.step() => panic!("the window returned: {outcome:?}"),
            _ = tokio::task::spawn_blocking(move || inside.recv().unwrap()) => {}
        }
        open.send(()).unwrap();
        self.relaunch();
    }

    fn attempted(&self) -> Vec<String> {
        vector_db::open(&self.vault.directory().join("vectors.db"), true)
            .unwrap()
            .unwrap()
            .call_blocking(|conn| VectorStore::new(conn).attempts())
            .unwrap()
            .into_iter()
            .map(|attempt| attempt.note_id)
            .collect()
    }
}

#[tokio::test]
async fn one_death_mid_window_retries_the_note_after_a_relaunch() {
    let mut s = setup().await;
    s.write("a", "Alpha", "the window an expiry interrupts");
    s.write("b", "Beta", "the note behind it");

    s.kill_mid_window().await;

    assert_eq!(s.finish().await, (2, 2), "a is retried once");
    assert!(
        s.attempted().is_empty(),
        "the commit clears a's attempt row"
    );
}

#[tokio::test]
async fn a_second_death_on_the_same_source_key_skips_the_note_until_it_changes() {
    let mut s = setup().await;
    s.write("a", "Alpha", "the window that takes the process down");
    s.write("b", "Beta", "the note behind it");

    s.kill_mid_window().await;
    s.kill_mid_window().await;

    assert_eq!(s.finish().await, (1, 2), "b embedded behind a");
    let ids: Vec<String> = s.states().into_iter().map(|state| state.note_id).collect();
    assert_eq!(ids, ["b"], "a died mid-window and writes no state row");
    s.relaunch();
    assert_eq!(s.finish().await, (1, 2), "a later relaunch still skips a");

    s.edit_body("a", 2, "an edit appended to the body");
    assert_eq!(s.finish().await, (2, 2), "the edit retries a");
}

#[tokio::test]
async fn an_edit_resets_the_count_of_deaths() {
    let mut s = setup().await;
    s.write("a", "Alpha", "the window an expiry interrupts");

    s.kill_mid_window().await;
    s.edit_body("a", 2, "an edit appended to the body");
    s.kill_mid_window().await;

    assert_eq!(
        s.finish().await,
        (1, 1),
        "one death per source key retries a"
    );
}

#[tokio::test]
async fn a_deleted_note_leaves_no_attempt_row() {
    let mut s = setup().await;
    s.write("a", "Alpha", "the window that takes the process down");
    s.write("b", "Beta", "the note behind it");
    s.kill_mid_window().await;
    s.kill_mid_window().await;
    assert_eq!(s.attempted(), ["a"]);

    s.with_data(|conn| {
        notes::delete(conn, "a", DEVICE, NOW).unwrap();
    });

    assert_eq!(s.finish().await, (1, 1));
    assert!(
        s.attempted().is_empty(),
        "the prune removes a's attempt row"
    );
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
