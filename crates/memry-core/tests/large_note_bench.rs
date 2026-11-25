//! Release-core benches for large notes. Ignored by default because a debug
//! core is not what ships. Run them on a release core:
//!
//! ```text
//! cargo test --release -p memry-core --test large_note_bench -- --ignored --nocapture
//! ```
//!
//! **What one body edit costs as a note's edit history grows (#5692).** An edit used to replay the note's whole update log, so its cost grew with
//! every edit before it until a sync folded the log. This bench seeds N edits
//! through the real API and times the next ones, for N = 100, 1,000 and
//! 5,000. Its budget is a ratio, not a wall-clock bound: an edit after 5,000
//! edits costs at most `BUDGET` times an edit after 100.
//!
//! **What opening the 200 KB note costs (REVIEW-5687).** The iOS large-note
//! test's body, 1,958 blocks and 200,025 UTF-16 units of mixed scripts,
//! written in one body write, then read and walked as the shell's open does.
//! It records the numbers and asserts no bound.

mod http_fakes;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use http_fakes::FakeSecureStore;
use memry_core::api::content_admin::TemplateDraft;
use memry_core::api::notes_write::NotesWriter;
use memry_core::api::vault::Vault;
use memry_core::crdt::body_edit::BlockEdit;
use memry_core::crypto::sodium;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};

static SCRATCH: AtomicU64 = AtomicU64::new(0);

const SAMPLES: usize = 21;
const BUDGET: f64 = 3.0;

struct Note {
    vault: Vault,
    store: Arc<dyn SecureStore>,
    writer: Arc<NotesWriter>,
    id: String,
    dir: PathBuf,
}

impl Drop for Note {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn note() -> Note {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("memry-edit-cost-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    let vault = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    let (_public, secret) = sodium::sign_seed_keypair(&[3u8; 32]).expect("a keypair");
    let store: Arc<dyn SecureStore> = FakeSecureStore::new();
    store
        .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
        .expect("plant the signing key");
    let writer = vault
        .notes_writer(Arc::clone(&store))
        .expect("the note writer");
    let id = writer.create("Large".to_string(), None).expect("the note");
    Note {
        vault,
        store,
        writer,
        id,
        dir,
    }
}

impl Note {
    fn edit(&self, edit: BlockEdit) {
        assert!(
            self.writer
                .edit_block(self.id.clone(), edit)
                .expect("the edit"),
            "the note is live"
        );
    }

    /// N edits of history: each inserts one block of about 100 characters.
    fn seed(&self, edits: usize) {
        for n in 0..edits {
            self.edit(BlockEdit::InsertBlock {
                kind: "paragraph".to_string(),
                after_block_id: (n > 0).then(|| format!("b{}", n - 1)),
                text: format!(
                    "{n:05} the quick brown fox jumps over the lazy dog, {}",
                    "x".repeat(50)
                ),
                new_block_id: format!("b{n}"),
            });
        }
    }

    /// The median of `SAMPLES` typing edits into the first block.
    fn median_edit(&self) -> Duration {
        let mut samples: Vec<Duration> = (0..SAMPLES)
            .map(|n| {
                let edit = BlockEdit::ReplaceText {
                    block_id: "b0".to_string(),
                    text: format!("typed {n}"),
                    base: None,
                };
                let started = Instant::now();
                self.edit(edit);
                started.elapsed()
            })
            .collect();
        samples.sort();
        samples[SAMPLES / 2]
    }
}

#[test]
#[ignore = "a release-core bench: cargo test --release -- --ignored"]
fn an_edit_costs_the_change_not_the_history() {
    let mut rows = Vec::new();
    for edits in [100, 1_000, 5_000] {
        let note = note();
        note.seed(edits);
        rows.push((edits, note.median_edit()));
    }
    println!("| history (edits) | edit N+1 (median of {SAMPLES}) |");
    println!("| --- | --- |");
    for (edits, median) in &rows {
        println!("| {edits} | {:.3} ms |", median.as_secs_f64() * 1e3);
    }
    let ratio = rows[2].1.as_secs_f64() / rows[0].1.as_secs_f64();
    println!("ratio 5k/100: {ratio:.2} (budget {BUDGET})");
    assert!(
        ratio <= BUDGET,
        "an edit after 5,000 edits costs {ratio:.1}x one after 100: it replays the history"
    );
}

const HEADING: &str = "Unicode and size stress";

/// `LargeNoteBody.paragraphs` of `apps/ios/MemryTests/LargeNoteOpenTests.swift`.
fn paragraphs() -> Vec<String> {
    let rows = [
        "مرحبا بالعالم، هذا نص عربي من اليمين إلى اليسار",
        "שלום עולם, זהו טקסט בעברית מימין לשמאל",
        "你好，世界。こんにちは世界。안녕하세요 세계.",
        "🚀🎉🧪📝 family 👨\u{200d}👩\u{200d}👧\u{200d}👦 flag 🇹🇷 keycap 1️⃣ combining e\u{301} n\u{303}",
        "Mixed: abc مرحبا 123 שלום 你好 😀 end.",
    ];
    let mut out = Vec::new();
    let mut length = 2 + HEADING.encode_utf16().count();
    let mut index = 0;
    while length < 200_000 {
        index += 1;
        let line = format!(
            "Paragraph {index:04}: {} {}",
            rows[index % 5],
            rows[(index + 2) % 5]
        );
        length += line.encode_utf16().count() + 2;
        out.push(line);
    }
    out
}

#[test]
#[ignore = "a release-core bench: cargo test --release -- --ignored"]
fn opening_the_200_kb_note() {
    let note = note();
    let paragraphs = paragraphs();
    let markdown = std::iter::once(format!("# {HEADING}"))
        .chain(paragraphs.iter().cloned())
        .collect::<Vec<_>>()
        .join("\n\n");
    let tasks = note.vault.tasks(Arc::clone(&note.store)).expect("tasks");
    let template = tasks
        .create_template("LM Unicode 200KB".to_string())
        .expect("the template");
    tasks
        .update_template(
            template.clone(),
            TemplateDraft {
                name: "LM Unicode 200KB".to_string(),
                description: None,
                icon: None,
                tags: Vec::new(),
                content: markdown,
            },
        )
        .expect("the template body");
    let id = note
        .writer
        .create_from_template(template, "LM Unicode 200KB".to_string(), None)
        .expect("the note");
    let notes = note.vault.notes();

    let mut reads = Vec::new();
    let mut walks = Vec::new();
    let mut blocks = 0;
    for _ in 0..SAMPLES {
        let started = Instant::now();
        let read = notes.read(id.clone()).expect("the read").expect("the note");
        reads.push(started.elapsed());
        assert!(read.body.present);
        let started = Instant::now();
        blocks = notes
            .blocks(id.clone())
            .expect("the walk")
            .expect("the note")
            .len();
        walks.push(started.elapsed());
    }
    assert_eq!(
        blocks,
        paragraphs.len() + 1,
        "the heading and every paragraph"
    );
    reads.sort();
    walks.sort();
    println!("200 KB note: {blocks} blocks");
    println!("| step | median of {SAMPLES} |");
    println!("| --- | --- |");
    println!(
        "| read | {:.3} ms |",
        reads[SAMPLES / 2].as_secs_f64() * 1e3
    );
    println!(
        "| walk | {:.3} ms |",
        walks[SAMPLES / 2].as_secs_f64() * 1e3
    );
}
