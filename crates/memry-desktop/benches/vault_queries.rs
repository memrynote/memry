//! Query latency over a large vault, replacing `apps/desktop/scripts/sqlite-memory-benchmark.ts`
//! (Step 40, #3557): 15,000 notes, 5,000 tasks and 2,000 inbox items written through a session
//! wired as the app wires it (vault tier, notes identity, note index), then the grouped
//! full-text search, the Tasks page's `all` view and the inbox list, each with its p50 and p95.
//!
//! `cargo bench -p memry-desktop --bench vault_queries` (root: `pnpm bench:queries`). The vector
//! query is not measured: `Searcher::semantic_hits` needs a loaded text model, which a bench run
//! does not have.

#[path = "../tests/device_key/mod.rs"]
mod device_key;

use std::hint::black_box;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use criterion::Criterion;
use memry_core::api::projects::ProjectDraft;
use memry_core::api::tasks::TaskViewQuery;
use memry_core::api::tasks_write::NewTaskInput;
use memry_core::domain::search::SearchFilter;
use memry_core::domain::search::grouped::GroupedQuery;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::session::{OpenSource, OpenVault, Session};
use memry_desktop::vault::consumer::{Applied, VaultTier};
use tokio::sync::broadcast::error::TryRecvError;

type Query<'a> = Box<dyn Fn() + 'a>;

const NOTES: usize = 15_000;
const TASKS: usize = 5_000;
const INBOX: usize = 2_000;
const BUILD_DEADLINE: Duration = Duration::from_secs(30 * 60);

const TOPICS: [&str; 5] = ["design", "engineering", "research", "ops", "writing"];

/// About 1 KB of markdown with tags, properties, headings, a list and a wiki link.
fn note_text(i: usize) -> String {
    let topic = TOPICS[i % TOPICS.len()];
    let mut text = format!(
        "---\ntags:\n  - {topic}\n  - area{}\nstatus: active\npriority: low\n---\n# {topic} note {i}\n\n",
        i % 12
    );
    for paragraph in 0..4 {
        text.push_str(&format!(
            "Paragraph {paragraph} of note {i} about {topic}: the quarterly review covers \
             roadmap planning, customer interviews and the release checklist for milestone {}.\n\n",
            i % 40
        ));
    }
    text.push_str(&format!(
        "## Actions\n\n- follow up with team {}\n- see [[{} note {}]]\n",
        i % 9,
        TOPICS[(i + 1) % TOPICS.len()],
        (i + 1) % NOTES
    ));
    text
}

/// Fields drop in order: the session and its handles close before the folder is removed.
struct Vault {
    open: OpenVault,
    tasks: Arc<memry_core::api::tasks::Tasks>,
    inbox: Arc<memry_core::api::inbox::Inbox>,
    _session: Session,
    _dir: tempfile::TempDir,
}

fn wait(what: &str, started: Instant, mut done: impl FnMut() -> bool) {
    while !done() {
        assert!(
            started.elapsed() < BUILD_DEADLINE,
            "still waiting for {what}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn build() -> Vault {
    let started = Instant::now();
    let dir = tempfile::tempdir().expect("temp dir");
    let root = dir.path().join("vault");
    for i in 0..NOTES {
        let path = root.join(format!("f{}/Note {i}.md", i % 10));
        std::fs::create_dir_all(path.parent().expect("folder")).expect("folder");
        std::fs::write(&path, note_text(i)).expect("note file");
    }
    std::fs::create_dir_all(dir.path().join("app")).expect("app dir");

    let store = device_key::with_device_key();
    let registry = VaultRegistry::new(Arc::new(AppConfig::load(
        dir.path().join("app/memry-config.json"),
    )));
    let session = Session::new(registry);
    let tier = VaultTier::new(store.clone());
    tier.set_identity(NotesIdentity::new(store.clone()));
    tier.register(&session);
    let index = NoteIndex::new(tier.clone(), |_| {}, |_| {}, |_| {});
    index.register(&session);
    let mut facts = tier.subscribe();

    let open = open_vault(&session, &root);
    // Every fact queued since the last poll: one per adopted file, so 15,000 before the walk ends.
    wait("the open walk", started, || {
        loop {
            match facts.try_recv() {
                Ok(Applied::Indexed { complete: true }) => return true,
                // Hit its caps or did not finish clean: fewer notes than the header prints.
                Ok(Applied::Indexed { complete: false }) => {
                    panic!("the open walk did not complete")
                }
                Ok(_) | Err(TryRecvError::Lagged(_)) => {}
                Err(_) => return false,
            }
        }
    });
    wait("the note index", started, || {
        index.indexing().is_none()
            && open
                .search
                .unindexed_notes(false)
                .is_ok_and(|left| left.is_empty())
    });
    eprintln!(
        "{NOTES} notes adopted and indexed in {:.1} s",
        started.elapsed().as_secs_f64()
    );

    let tasks = open.vault.tasks(store.clone()).expect("tasks");
    let project = tasks
        .create_project(ProjectDraft {
            name: "Bench".into(),
            description: None,
            color: None,
            icon: None,
            statuses: None,
        })
        .expect("project");
    for i in 0..TASKS {
        tasks
            .create(NewTaskInput {
                title: format!("Review {} item {i}", TOPICS[i % TOPICS.len()]),
                project_id: project.clone(),
                status_id: None,
                parent_id: None,
                priority: (i % 4) as i64,
                description: None,
                due_date: (i % 3 == 0).then(|| format!("2026-12-{:02}", 1 + i % 28)),
                due_time: None,
                start_date: None,
                repeat: None,
                repeat_from: None,
                tags: vec![TOPICS[i % TOPICS.len()].to_owned()],
                linked_note_ids: Vec::new(),
                linked_canvas_ids: Vec::new(),
                source_note_id: None,
                position: None,
            })
            .expect("task");
    }
    let inbox = open.vault.inbox(store).expect("inbox");
    for i in 0..INBOX {
        inbox
            .capture_text(
                format!("Captured thought {i} on {}", TOPICS[i % TOPICS.len()]),
                None,
                None,
                true,
            )
            .expect("capture");
    }
    eprintln!(
        "{TASKS} tasks and {INBOX} inbox items written; vault built in {:.1} s",
        started.elapsed().as_secs_f64()
    );
    Vault {
        open,
        tasks,
        inbox,
        _session: session,
        _dir: dir,
    }
}

fn open_vault(session: &Session, root: &Path) -> OpenVault {
    session
        .open(root, OpenSource::Select)
        .expect("open the vault")
        .vault
}

/// The p50 and p95 of `samples`, nearest rank.
fn percentiles(mut samples: Vec<Duration>) -> (Duration, Duration) {
    samples.sort_unstable();
    let at = |pct: usize| samples[(samples.len() * pct).div_ceil(100).max(1) - 1];
    (at(50), at(95))
}

fn main() {
    let vault = build();
    let search = |text: &str| GroupedQuery {
        text: text.to_owned(),
        filter: SearchFilter {
            types: Vec::new(),
            modified: None,
            tags: Vec::new(),
        },
        project_id: None,
        folder_path: None,
        note_file_types: Vec::new(),
        limit: 20,
    };
    let (word, phrase) = (search("engineering"), search("release checklist"));
    let all_tasks = TaskViewQuery {
        tab: "all".into(),
        project_id: None,
        filters_json: None,
        sort_json: None,
        now: "2026-12-01T09:00:00".into(),
        week_starts_on: 1,
    };
    let queries: [(&str, Query); 4] = [
        (
            "search: one word",
            Box::new(|| {
                drop(black_box(
                    vault.open.search.grouped(&word, &[]).expect("search"),
                ))
            }),
        ),
        (
            "search: two words",
            Box::new(|| {
                drop(black_box(
                    vault.open.search.grouped(&phrase, &[]).expect("search"),
                ))
            }),
        ),
        (
            "tasks: all view",
            Box::new(|| {
                drop(black_box(
                    vault.tasks.view(all_tasks.clone()).expect("tasks"),
                ))
            }),
        ),
        (
            "inbox: list",
            Box::new(|| drop(black_box(vault.inbox.list(false).expect("inbox")))),
        ),
    ];

    let mut criterion = Criterion::default().configure_from_args();
    let mut rows = Vec::new();
    for (name, query) in &queries {
        // Every timed call, warm-up included: criterion reports means, the issue asks for p50
        // and p95.
        let mut samples = Vec::new();
        criterion.bench_function(name, |bencher| {
            bencher.iter_custom(|iterations| {
                let mut total = Duration::ZERO;
                for _ in 0..iterations {
                    let started = Instant::now();
                    query();
                    let took = started.elapsed();
                    samples.push(took);
                    total += took;
                }
                total
            })
        });
        let calls = samples.len();
        let (p50, p95) = percentiles(samples);
        rows.push((*name, calls, p50, p95));
    }
    criterion.final_summary();

    println!(
        "\nvault_queries: {NOTES} notes, {TASKS} tasks, {INBOX} inbox items (p50 and p95 over every timed call, criterion's warm-up and cold-cache first calls included)"
    );
    println!(
        "{:<20} {:>8} {:>10} {:>10}",
        "query", "calls", "p50 ms", "p95 ms"
    );
    for (name, calls, p50, p95) in rows {
        println!(
            "{name:<20} {calls:>8} {:>10.3} {:>10.3}",
            p50.as_secs_f64() * 1000.0,
            p95.as_secs_f64() * 1000.0
        );
    }
}
