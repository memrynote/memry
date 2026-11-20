//! Deterministic bulk notes for benchmark vaults, ported from
//! `apps/desktop/scripts/seed-data/bulk-notes.ts`.
//!
//! The same `count` and `seed` give the same notes as the TypeScript generator, byte for byte
//! once written (`tests/bulk_notes_golden.rs` holds the hashes it recorded), so benchmark runs
//! on either side compare like for like. Every random draw happens in the TypeScript's order.

mod rng;
mod templates;
mod topics;

use std::collections::{BTreeSet, HashSet};

use chrono::{DateTime, Local, SecondsFormat, TimeDelta, Timelike, Utc};
use memry_core::markdown::frontmatter::{YamlMap, YamlValue};

use rng::Rng;
use templates::{
    BODY_TEMPLATES, BULLET_TEMPLATES, CALLOUTS, LEAD_TEMPLATES, LINK_HOSTS, OWNERS,
    PRIORITY_VALUES, STATUS_VALUES,
};
use topics::{TOPICS, Topic};

/// One generated note: its identity, its dates and what its file holds.
#[derive(Debug, Clone)]
pub struct BulkNote {
    /// 12 lowercase alphanumerics, the shape of `generateNoteId()`.
    pub id: String,
    /// Vault-relative, `<topic folder>/<title>.md`.
    pub path: String,
    pub title: String,
    pub emoji: String,
    /// ISO 8601 with milliseconds, UTC.
    pub created_at: String,
    pub modified_at: String,
    pub tags: Vec<String>,
    /// User keys only, in file order: `tags`, `status`, `priority`, `owner`, `rating`.
    pub frontmatter: YamlMap,
    /// The markdown after the frontmatter.
    pub body: String,
}

/// A folder the notes use, with its topic's icon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BulkFolder {
    pub path: String,
    pub icon: String,
}

#[derive(Debug, Clone)]
pub struct BulkVault {
    pub notes: Vec<BulkNote>,
    /// In the order the topics are defined.
    pub folders: Vec<BulkFolder>,
    /// Every tag the notes use, deduplicated and sorted.
    pub tags: Vec<String>,
}

const NOTE_ID_ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

/// Placeholders `fill` replaces, in the order it draws for them (not their order in the text).
const SLOTS: [&str; 5] = ["{system}", "{action}", "{metric}", "{artifact}", "{person}"];

fn slot_items(topic: &Topic, slot: &str) -> &'static [&'static str] {
    match slot {
        "{system}" => topic.systems,
        "{action}" => topic.actions,
        "{metric}" => topic.metrics,
        "{artifact}" => topic.artifacts,
        _ => topic.people,
    }
}

/// `pickMany`: distinct picks, capped at the pool size.
fn pick_many(rng: &mut Rng, items: &[&'static str], count: usize) -> Vec<&'static str> {
    let wanted = count.min(items.len());
    let mut chosen: Vec<&'static str> = Vec::with_capacity(wanted);
    while chosen.len() < wanted {
        let candidate = *rng.pick(items);
        if !chosen.contains(&candidate) {
            chosen.push(candidate);
        }
    }
    chosen
}

/// `fill`: each placeholder's first occurrence, drawn only when the template holds it.
fn fill(template: &str, rng: &mut Rng, topic: &Topic, subject: &str) -> String {
    let mut text = template.to_owned();
    for slot in SLOTS {
        if text.contains(slot) {
            let value = *rng.pick(slot_items(topic, slot));
            text = text.replacen(slot, value, 1);
        }
    }
    text.replacen("{subject_lower}", &subject.to_lowercase(), 1)
}

/// `sentenceCase`: the first character upper-cased.
fn sentence_case(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn paragraph(rng: &mut Rng, topic: &Topic, subject: &str, sentences: usize) -> String {
    pick_many(rng, BODY_TEMPLATES, sentences)
        .into_iter()
        .map(|template| fill(template, rng, topic, subject))
        .collect::<Vec<_>>()
        .join(" ")
}

fn table(rng: &mut Rng, topic: &Topic, rows: usize) -> String {
    let mut lines = vec![
        "| Item | Owner | State |".to_owned(),
        "| --- | --- | --- |".to_owned(),
    ];
    for _ in 0..rows {
        let artifact = rng.pick(topic.artifacts);
        let person = rng.pick(topic.people);
        let state = rng.pick(STATUS_VALUES);
        lines.push(format!("| {artifact} | {person} | {state} |"));
    }
    lines.join("\n")
}

fn checklist(rng: &mut Rng, topic: &Topic, subject: &str, items: usize) -> String {
    let mut lines = Vec::with_capacity(items);
    for i in 0..items {
        // The first item done and the last one open, so every note carries both states.
        let done = if i == 0 {
            'x'
        } else if i == items - 1 || rng.next() >= 0.4 {
            ' '
        } else {
            'x'
        };
        let template = *rng.pick(BULLET_TEMPLATES);
        let item = sentence_case(&fill(template, rng, topic, subject));
        lines.push(format!("- [{done}] {item}"));
    }
    lines.join("\n")
}

/// `rngNoteId`.
fn note_id(rng: &mut Rng) -> String {
    (0..12)
        .map(|_| char::from(NOTE_ID_ALPHABET[rng.below(NOTE_ID_ALPHABET.len())]))
        .collect()
}

/// `sanitizeFileName`: the characters no file system takes become `-`.
fn sanitize_file_name(title: &str) -> String {
    let replaced: String = title
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c => c,
        })
        .collect();
    memry_core::markdown::frontmatter::js_trim(&replaced).to_owned()
}

/// `seedPastISOAt` of `seed-data/date.ts`: `days` from today (the local date, at noon UTC) at
/// `hours:minutes` UTC. Today's time still ahead of `now` moves back to before `now`.
fn seed_past_iso_at(days: i64, hours: u32, minutes: u32, now: DateTime<Local>) -> String {
    let at = (now.date_naive() + TimeDelta::days(days))
        .and_hms_opt(hours, minutes, 0)
        .expect("hours and minutes are a time of day")
        .and_utc();
    if days != 0 || at <= now.with_timezone(&Utc) {
        return iso(at);
    }
    let elapsed = i64::from(now.hour() * 60 + now.minute());
    let requested = (i64::from(hours) - 6) * 20 + i64::from(minutes);
    let back = requested.max(1).min(elapsed);
    let local = now - TimeDelta::minutes(back);
    let truncated = local.with_timezone(&Utc).timestamp() / 60 * 60;
    iso(DateTime::from_timestamp(truncated, 0).expect("a time in range"))
}

fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

struct Skeleton {
    topic: &'static Topic,
    subject: &'static str,
    id: String,
    title: String,
    path: String,
    days_ago_created: i64,
    days_ago_modified: i64,
}

/// `generateBulkVault`: `count` notes spread evenly across the topics, unique titles, each
/// linking to a few others. Dates are relative to the local clock now; the file bytes are not.
pub fn generate(count: usize, seed: u32) -> BulkVault {
    let now = Local::now();
    let mut rng = Rng::new(seed);

    // Pass 1, identities: bodies need the titles of other notes to link to.
    let mut claimed: HashSet<String> = HashSet::with_capacity(count);
    let skeletons: Vec<Skeleton> = (0..count)
        .map(|index| {
            let topic = &TOPICS[index % TOPICS.len()];
            let subject = *rng.pick(topic.subjects);
            let qualifier = *rng.pick(topic.qualifiers);
            let mut title = format!("{subject} — {qualifier}");
            let mut path = format!("{}/{}.md", topic.folder, sanitize_file_name(&title));
            let mut suffix = 2;
            while claimed.contains(&path) {
                title = format!("{subject} — {qualifier} {suffix}");
                path = format!("{}/{}.md", topic.folder, sanitize_file_name(&title));
                suffix += 1;
            }
            claimed.insert(path.clone());
            let days_ago_created = 30 + rng.below(700) as i64;
            let days_ago_modified = rng.below(days_ago_created as usize) as i64;
            Skeleton {
                topic,
                subject,
                id: note_id(&mut rng),
                title,
                path,
                days_ago_created,
                days_ago_modified,
            }
        })
        .collect();

    // Pass 2, bodies, with wiki-links into the rest of the vault.
    let notes: Vec<BulkNote> = (0..count)
        .map(|index| note(&mut rng, &skeletons, index, now))
        .collect();

    let used: HashSet<&str> = notes
        .iter()
        .filter_map(|note| note.path.split('/').next())
        .collect();
    let tags: BTreeSet<&String> = notes.iter().flat_map(|note| &note.tags).collect();
    BulkVault {
        folders: TOPICS
            .iter()
            .filter(|topic| used.contains(topic.folder))
            .map(|topic| BulkFolder {
                path: topic.folder.to_owned(),
                icon: topic.icon.to_owned(),
            })
            .collect(),
        tags: tags.into_iter().cloned().collect(),
        notes,
    }
}

fn note(rng: &mut Rng, skeletons: &[Skeleton], index: usize, now: DateTime<Local>) -> BulkNote {
    let count = skeletons.len();
    let skeleton = &skeletons[index];
    let Skeleton { topic, subject, .. } = *skeleton;
    let tag_count = 2 + rng.below(2);
    let tags = pick_many(rng, topic.tags, tag_count);
    // `(index + count - 23) % count`. Below 23 notes that goes negative and the TypeScript
    // throws on the missing note; here it wraps around instead.
    let back = (index as i64 + count as i64 - 23).rem_euclid(count as i64) as usize;
    let linked: Vec<&Skeleton> = [(index + 7) % count, (index + 137) % count, back]
        .into_iter()
        .map(|at| &skeletons[at])
        .filter(|target| target.title != skeleton.title)
        .collect();

    let lead = *rng.pick(LEAD_TEMPLATES);
    let mut sections = vec![
        fill(lead, rng, topic, subject),
        String::new(),
        "## Context".to_owned(),
        String::new(),
        paragraph(rng, topic, subject, 3),
        String::new(),
    ];
    let bullet_count = 3 + rng.below(3);
    sections.push(
        pick_many(rng, BULLET_TEMPLATES, bullet_count)
            .into_iter()
            .map(|template| format!("- {}", sentence_case(&fill(template, rng, topic, subject))))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    sections.push(String::new());
    sections.push(format!("## {}", sentence_case(rng.pick(topic.qualifiers))));
    sections.push(String::new());
    sections.push(paragraph(rng, topic, subject, 3));
    sections.push(String::new());
    sections.push((*rng.pick(CALLOUTS)).to_owned());
    sections.push(String::new());
    let rows = 3 + rng.below(3);
    sections.push(table(rng, topic, rows));

    if !topic.snippets.is_empty() && rng.next() < 0.55 {
        let snippet = *rng.pick(topic.snippets);
        sections.extend(["", "### Reference", "", snippet].map(str::to_owned));
    }

    let questions = pick_many(rng, topic.questions, 3.min(topic.questions.len()))
        .into_iter()
        .enumerate()
        .map(|(i, question)| format!("{}. {question}", i + 1))
        .collect::<Vec<_>>()
        .join("\n");
    let items = 3 + rng.below(3);
    let next = checklist(rng, topic, subject, items);
    let links = linked
        .iter()
        .map(|target| format!("- [[{}]]", target.title))
        .collect::<Vec<_>>()
        .join("\n");
    let host = format!("- {}", rng.pick(LINK_HOSTS));
    let tag_line = tags
        .iter()
        .map(|tag| format!("#{tag}"))
        .collect::<Vec<_>>()
        .join(" ");
    sections.extend(
        [
            "",
            "## Open questions",
            "",
            questions.as_str(),
            "",
            "## Next",
            "",
            next.as_str(),
            "",
            "## Links",
            "",
            links.as_str(),
            host.as_str(),
            "",
            tag_line.as_str(),
        ]
        .map(str::to_owned),
    );

    let mut frontmatter = YamlMap::new();
    let tag_values = tags.iter().map(|tag| YamlValue::String((*tag).to_owned()));
    frontmatter.insert(
        "tags".to_owned(),
        YamlValue::Seq(std::sync::Arc::new(tag_values.collect())),
    );
    for (key, values) in [
        ("status", STATUS_VALUES),
        ("priority", PRIORITY_VALUES),
        ("owner", OWNERS),
    ] {
        let value = (*rng.pick(values)).to_owned();
        frontmatter.insert(key.to_owned(), YamlValue::String(value));
    }
    let rating = 1 + rng.below(5);
    frontmatter.insert("rating".to_owned(), YamlValue::Number(rating as f64));

    BulkNote {
        id: skeleton.id.clone(),
        path: skeleton.path.clone(),
        title: skeleton.title.clone(),
        emoji: topic.icon.to_owned(),
        created_at: seed_past_iso_at(-skeleton.days_ago_created, 9, 15, now),
        modified_at: seed_past_iso_at(-skeleton.days_ago_modified, 16, 45, now),
        tags: tags.into_iter().map(str::to_owned).collect(),
        frontmatter,
        body: sections.join("\n"),
    }
}

#[cfg(test)]
mod tests;
