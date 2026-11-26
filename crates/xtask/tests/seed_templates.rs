//! `cargo xtask seed demo|rich|small` through its real seams: each committed template replayed
//! into a temp folder, then opened by a real session and vault tier as the app opens a vault.
//! The counts are the ones the Electron seeds print and leave on disk.
//!
//! ```text
//! cargo test -p xtask --test seed_templates
//! ```

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::sandbox::{SandboxError, Template, TemplateInfo};
use memry_desktop::session::{OpenSource, Session};
use memry_desktop::vault::consumer::{Applied, VaultTier};
use xtask::seed_template::{Profile, seed_profile, seed_store};

/// What the Electron seeds wrote (`Seeded ...` lines of `seed-vault.ts` and friends, and the
/// files on disk): markdown notes outside `journal/`, journal days, canvases, task rows.
const EXPECTED: [(Profile, [usize; 4]); 4] = [
    (Profile::Demo, [117, 186, 6, 68]),
    (Profile::Rich, [46, 5, 0, 12]),
    (Profile::Small(1), [4, 0, 0, 4]),
    (Profile::Small(2), [3, 0, 0, 4]),
];

const LINK: &str = "memry://note/";

fn info(profile: Profile) -> TemplateInfo {
    TemplateInfo::parse(&fs::read(profile.template_dir().join("manifest.json")).unwrap()).unwrap()
}

/// The export day: the replay keeps every date as the Electron seed wrote it.
fn export_moment(profile: Profile) -> DateTime<Utc> {
    info(profile).generated_at.parse().unwrap()
}

/// Opens `vault` in a new session, as the app does, and returns every note file row (id, path)
/// once the first index has run.
fn open_and_list(app: &Path, vault: &Path) -> BTreeSet<(String, String)> {
    let store = seed_store().unwrap();
    let registry = VaultRegistry::new(Arc::new(AppConfig::load(app.join("memry-config.json"))));
    let session = Session::new(registry);
    let tier = VaultTier::new(store.clone());
    tier.set_identity(NotesIdentity::new(store));
    tier.register(&session);
    let mut facts = tier.subscribe();
    let opened = session.open(vault, OpenSource::Select).unwrap();
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        match facts.try_recv() {
            Ok(Applied::Indexed { .. }) => break,
            Ok(_) => {}
            Err(_) => {
                assert!(Instant::now() < deadline, "the vault was never indexed");
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
    let paths = opened
        .vault
        .vault
        .note_files()
        .list_paths()
        .unwrap()
        .into_iter()
        .collect();
    drop(opened);
    session.close();
    paths
}

#[test]
fn each_seed_opens_with_the_electron_counts() {
    for (profile, [notes, journal, canvases, tasks]) in EXPECTED {
        let counts = info(profile);
        let count = |name: &str| usize::try_from(counts.count(name).unwrap()).unwrap();
        assert_eq!(
            [
                count("notes"),
                count("journal entries"),
                count("canvases"),
                count("tasks")
            ],
            [notes, journal, canvases, tasks],
            "{profile:?}: the exported template drifted from the Electron seed"
        );

        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("vault");
        let seeded = seed_profile(
            profile,
            &vault,
            export_moment(profile),
            seed_store().unwrap(),
        )
        .unwrap();
        // The replay counts journal days by their rows; the rich seed writes its days without
        // one, so the days are counted below, from what the open found.
        assert_eq!(seeded.canvases, canvases, "{profile:?}");

        fs::create_dir(dir.path().join("app")).unwrap();
        let rows = open_and_list(&dir.path().join("app"), &vault);
        let markdown: Vec<&String> = rows
            .iter()
            .map(|(_, path)| path)
            .filter(|path| path.ends_with(".md"))
            .collect();
        let days = markdown
            .iter()
            .filter(|path| path.starts_with("journal/"))
            .count();
        assert_eq!(
            (markdown.len() - days, days),
            (notes, journal),
            "{profile:?}: notes and journal days the open found"
        );

        // Every note link names a note the open kept: the replay rewrote the seed's ids.
        let ids: BTreeSet<&str> = rows.iter().map(|(id, _)| id.as_str()).collect();
        for path in &markdown {
            let text = fs::read_to_string(vault.join(path)).unwrap();
            for link in text.split(LINK).skip(1) {
                let id: String = link
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                    .collect();
                assert!(ids.contains(id.as_str()), "{profile:?}: {path} links {id}");
            }
        }

        // Tasks ride in seed.json; the replay writes them once Step 32 (32j2) replays task rows.
        let template = Template::load(&profile.template_dir(), &profile.template_dir()).unwrap();
        assert_eq!(template.manifest.data["tasks"].len(), tasks, "{profile:?}");
    }
}

#[test]
fn a_folder_with_someone_elses_files_is_never_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("vault");
    fs::create_dir(&vault).unwrap();
    fs::write(vault.join("mine.md"), "mine").unwrap();
    let refused = seed_profile(Profile::Small(1), &vault, Utc::now(), seed_store().unwrap());
    assert!(matches!(refused, Err(SandboxError::TargetNotEmpty(_))));
    assert_eq!(fs::read_to_string(vault.join("mine.md")).unwrap(), "mine");
}

#[test]
fn a_seeded_vault_is_reseeded() {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("vault");
    let now = Utc::now();
    seed_profile(Profile::Small(2), &vault, now, seed_store().unwrap()).unwrap();
    fs::write(vault.join("stale.md"), "old").unwrap();
    seed_profile(Profile::Small(2), &vault, now, seed_store().unwrap()).unwrap();
    assert!(!vault.join("stale.md").exists());
}
