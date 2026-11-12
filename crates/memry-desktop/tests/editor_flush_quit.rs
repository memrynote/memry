//! The quit of an app whose windows were just typing (#3531): twenty notes edited through the
//! editor host, as the `crdt_*` commands edit them, then the quit as the app runs it. The vault's
//! quit steps (`VaultTier::quit_steps`: `flush-writebacks`, `flush-activity-log`,
//! `close-snapshots`) and the shell's `close-vault` run in one five-second budget, without
//! waiting out the write-back's debounce. Every file holds its note's last edit, and every note
//! has a `close` version of that file.
//!
//! ```text
//! cargo test -p memry-desktop --test editor_flush_quit
//! ```

mod device_key;
mod editor_window;
mod vault_env;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use editor_window::Window;
use memry_desktop::editor::versions;
use memry_desktop::editor::{EditorHost, HostEvent, Subscriber};
use memry_desktop::shell::shutdown::{
    SequenceStatus, ShutdownContext, ShutdownCore, ShutdownReason, StepFn, run_shutdown_sequence,
};
use vault_env::{creates, env, indexed};

const NOTES: usize = 20;
const EDITS: usize = 3;
const WINDOW: &str = "main";
const BUDGET: Duration = Duration::from_secs(5);

fn file(n: usize) -> String {
    format!("note-{n:02}.md")
}

/// The first line of note `n` after its `EDITS` edits, each typed at the start of the line.
fn last_edit(n: usize) -> String {
    let typed: String = (1..=EDITS).rev().map(|e| format!("edit {e} ")).collect();
    format!("{typed}Note {n}")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_quit_right_after_typing_writes_every_last_edit_and_keeps_a_close_version() {
    let store = Mutex::new(None);
    let mut e = env(|s| {
        *store.lock().unwrap() = Some(s.clone());
        Some(creates(s))
    });
    let store = store.into_inner().unwrap().unwrap();
    // As the shell builds it (`vault_boot::register_editor`): a stored window edit schedules the
    // note's write-back.
    let tier = e.tier.clone();
    let host = EditorHost::new(store, move |event| {
        if let HostEvent::Edited { note_id } = event {
            tier.schedule(&note_id);
        }
    });
    host.register(&e.session);
    e.tier.set_editor_host(&host);
    for n in 0..NOTES {
        e.write(&file(n), &format!("Note {n}\n"));
    }
    e.open();
    while e.rows().len() < NOTES {
        e.facts_until(indexed);
    }
    let notes: Vec<(String, String)> = e.rows().into_iter().map(|(id, p)| (p, id)).collect();

    for n in 0..NOTES {
        let id = &notes.iter().find(|(p, _)| *p == file(n)).unwrap().1;
        let subscriber = Subscriber {
            window_label: WINDOW.to_owned(),
            channel: Arc::new(|_| true),
        };
        let opened = host.open(id, Some(&e.vault), subscriber).unwrap();
        let window = Window::from_state(&opened.state);
        for edit in 1..=EDITS {
            let update = window.type_text(&format!("edit {edit} "));
            host.apply_update(id, &update, WINDOW).unwrap();
        }
    }

    let core = ShutdownCore::default();
    for (name, step) in e.tier.quit_steps(&e.session) {
        core.registry.register(name, step).unwrap();
    }
    // The shell's `close-vault` (`memry-tauri` `shutdown::steps`): the session closes.
    let session = e.session.clone();
    let close_vault: StepFn = Arc::new(move |_, _| {
        let session = session.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || session.close())
                .await
                .map_err(|error| error.to_string())
        })
    });
    core.registry.register("close-vault", close_vault).unwrap();
    let ctx = ShutdownContext {
        installing_update: false,
        reason: ShutdownReason::Quit,
    };
    let outcome = run_shutdown_sequence(&core.registry.steps(), ctx, BUDGET, &|_| {})
        .await
        .unwrap();
    assert_eq!(outcome.status, SequenceStatus::Complete, "{outcome:?}");

    // The quit closed the vault: the versions are read from a reopen, as the next launch does.
    e.core = None;
    e.open();
    let open = e.session.current().unwrap();
    for (path, id) in &notes {
        let n: usize = path["note-".len()..][..2].parse().unwrap();
        let written = e.read(path);
        assert!(
            written.contains(&format!("{}\n", last_edit(n))),
            "{path} lost its last edit: {written:?}"
        );
        let close: Vec<String> = versions::list(&open, id)
            .unwrap()
            .into_iter()
            .filter(|v| v.reason == "close")
            .map(|v| open.vault.versions().get(&v.id).unwrap().unwrap().content)
            .collect();
        assert_eq!(close, [written], "{path}: the close versions");
    }
}
