//! A journal day's file (`writeback::journal`): the pass writes its body as a note's and sets
//! its `date` entry only, never its tags, over the files Electron writes
//! (`tests/fixtures/electron-journal`, `scripts/electron-fixtures/capture-journal.mjs`).

use std::sync::{Arc, Mutex};

use memry_core::markdown::frontmatter::{
    YamlMap, YamlValue, parse_markdown_note, split_frontmatter_block,
};

use super::{assert_wrote, fixture};
use crate::vault::hash::content_hash;
use crate::vault::writeback::Outcome;
use crate::vault::writeback::journal::{Dated, dated_block, set_date};

const ELECTRON: [(&str, &str, &str); 3] = [
    (
        "created.md",
        "2025-01-14",
        include_str!("../../../../tests/fixtures/electron-journal/created.md"),
    ),
    (
        "legacy.md",
        "2025-01-15",
        include_str!("../../../../tests/fixtures/electron-journal/legacy.md"),
    ),
    (
        "crlf.md",
        "2025-01-16",
        include_str!("../../../../tests/fixtures/electron-journal/crlf.md"),
    ),
];

/// A day Electron wrote keeps its whole block through a write, its `tags:` included, while the
/// day's record holds other tags; the body takes the edit in the file's line ends.
#[test]
fn an_electron_days_block_and_tags_stay_byte_for_byte_through_a_write() {
    for (name, date, text) in ELECTRON {
        let mut f = fixture();
        let rel = format!("journal/{date}.md");
        let id = f.adopt_day(&rel, date, text);
        assert_eq!(id, format!("j{date}"));
        assert_eq!(f.run(&id), Outcome::Unchanged, "{name}");
        let journal = f.vault.journal(f.store.clone()).unwrap();
        journal
            .set_tags(date.to_owned(), vec!["record-only".to_owned()])
            .unwrap();
        f.paragraph_from_sync(&id, "from the other device");
        let outcome = f.run(&id);
        let file = assert_wrote(&mut f, &outcome, &rel);
        let block = split_frontmatter_block(text).block.unwrap();
        assert_eq!(split_frontmatter_block(&file).block, Some(block), "{name}");
        assert!(file.contains("from the other device"), "{name}: {file}");
        assert!(!file.contains("record-only"), "{name}: {file}");
        let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
        assert_eq!(
            file.matches('\n').count(),
            file.matches(eol).count(),
            "{name}"
        );
    }
}

/// An Electron day at another day's path (a move Electron made, a hand-renamed file) has its
/// `date:` line set to the path's day, and every other byte of the block stays.
#[test]
fn a_day_whose_date_says_another_day_has_only_that_line_replaced() {
    let (_, _, text) = ELECTRON[0];
    let mut f = fixture();
    let id = f.adopt_day("journal/2025-01-20.md", "2025-01-20", text);
    f.paragraph_from_sync(&id, "from the other device");
    let outcome = f.run(&id);
    let file = assert_wrote(&mut f, &outcome, "journal/2025-01-20.md");
    let block = split_frontmatter_block(text).block.unwrap();
    let expected = block.replacen("date: '2025-01-14'\n", "date: '2025-01-20'\n", 1);
    assert_ne!(expected, block);
    assert_eq!(
        split_frontmatter_block(&file).block,
        Some(expected.as_str())
    );
}

/// A day owed a move of its file (`journal/2025-01-01.md` renamed to another day's path, or out
/// of the journal) is not that day's file any more: a body write leaves its `date:` as it is.
#[test]
fn a_day_owed_a_move_keeps_the_files_date() {
    let text = "---\ndate: '2025-01-02'\n---\nA day.\n";
    for rel in ["journal/2025-01-02.md", "archive/2025-01-01.md"] {
        let mut f = fixture();
        let id = f.adopt_day(rel, "2025-01-01", text);
        f.writer.owe_place(&id, "journal/2025-01-01.md").unwrap();
        f.paragraph_from_sync(&id, "from the other device");
        let outcome = f.run(&id);
        let file = assert_wrote(&mut f, &outcome, rel);
        assert!(
            file.starts_with("---\ndate: '2025-01-02'\n---\nA day.\n"),
            "{file}"
        );
    }
}

/// The writing tools data the document holds and the file does not stringifies the block
/// again: the day's date goes in, and the file's tags stay, never the record's.
#[test]
fn a_writing_data_change_writes_the_date_and_the_files_tags() {
    let mut f = fixture();
    let rel = "journal/2025-01-20.md";
    let body = "one <!--alt:k3x9q2-->two<!--/alt:k3x9q2--> three\n";
    let writing = "writing:\n  alternatives:\n    k3x9q2:\n      versions:\n        - text: two\n";
    let id = f.adopt_day(rel, "2025-01-20", &format!("---\n{writing}---\n{body}"));
    let journal = f.vault.journal(f.store.clone()).unwrap();
    journal
        .set_tags("2025-01-20".to_owned(), vec!["record-only".to_owned()])
        .unwrap();
    // The document holds the alternatives the file no longer does.
    let text = format!("---\ntags: [mine]\n---\n{body}");
    f.write(rel, &text);
    f.record(&id, rel, Some(content_hash(&text)));
    let outcome = f.run(&id);
    let file = assert_wrote(&mut f, &outcome, rel);
    let block = split_frontmatter_block(&file).block.unwrap();
    assert!(block.contains("tags:\n  - mine\n"), "{block}");
    assert!(block.contains("date: '2025-01-20'\n"), "{block}");
    assert!(block.contains("k3x9q2"), "{block}");
    assert!(!file.contains("record-only"), "{file}");
}

/// The date rides on a body write: a day whose file holds its body is not written to add it,
/// whatever the spelling around its block.
#[test]
fn a_day_without_a_date_gets_one_with_its_next_body_write_only() {
    for text in [
        "---\nmood: ok\n---\n\n\nA journal day.\n",
        "---\r\nmood: ok\r\n---\r\nA journal day.  \r\n",
        "---\nmood: ok\n---\n* a\n* b",
    ] {
        let mut f = fixture();
        let id = f.adopt_day("journal/2025-01-01.md", "2025-01-01", text);
        assert_eq!(f.run(&id), Outcome::Unchanged, "{text:?}");
        assert_eq!(f.read("journal/2025-01-01.md"), text);
    }
    let mut f = fixture();
    let id = f.adopt_day("journal/2025-01-01.md", "2025-01-01", "A journal day.\n");
    assert_eq!(f.run(&id), Outcome::Unchanged);
    assert_eq!(f.read("journal/2025-01-01.md"), "A journal day.\n");
    f.paragraph_from_sync(&id, "from the other device");
    let outcome = f.run(&id);
    let file = assert_wrote(&mut f, &outcome, "journal/2025-01-01.md");
    assert!(
        file.starts_with("---\ndate: '2025-01-01'\n---\nA journal day.\n"),
        "{file}"
    );
}

/// A day whose block ends its file, with no line end after the closing fence, keeps the fence
/// through the body write that sets its date: the line end goes after the fence (#3800).
#[test]
fn a_day_whose_block_ends_the_file_keeps_its_fence_with_its_date() {
    let rel = "journal/2025-01-01.md";
    let mut f = fixture();
    let id = f.adopt_day(rel, "2025-01-01", "---\nmood: ok\n---");
    assert_eq!(f.run(&id), Outcome::Unchanged);
    f.paragraph_from_sync(&id, "from the other device");
    let outcome = f.run(&id);
    let file = assert_wrote(&mut f, &outcome, rel);
    assert_eq!(
        file,
        "---\nmood: ok\ndate: '2025-01-01'\n---\nfrom the other device"
    );
}

fn dated(raw: &str) -> Dated {
    dated_block(&parse_markdown_note(raw).unwrap(), raw, "2025-01-20")
}

/// Each block the date can be set in, and each it cannot, byte for byte.
#[test]
fn the_date_is_set_in_place_or_the_block_is_left_as_it_is() {
    let set = [
        (
            "---\ntags: [a]\n---\nx\n",
            "---\ntags: [a]\ndate: '2025-01-20'\n---\n",
        ),
        (
            "---\r\ntags: [a]\r\n---\r\n",
            "---\r\ntags: [a]\r\ndate: '2025-01-20'\r\n---\r\n",
        ),
        (
            "---\ndate: '2025-01-14'\ntags:\n  - a\n---\n",
            "---\ndate: '2025-01-20'\ntags:\n  - a\n---\n",
        ),
        (
            "---\nmood: ok\ndate: 2025-01-14\n---\n",
            "---\nmood: ok\ndate: 2025-01-20\n---\n",
        ),
        (
            "---\ndate:\n  '2025-01-14'\n# kept\nmood: ok\n---\n",
            "---\ndate: '2025-01-20'\n# kept\nmood: ok\n---\n",
        ),
        (
            "---\ndate: 2025-01-14\n  # kept too\nmood: ok\n---\n",
            "---\ndate: 2025-01-20\n  # kept too\nmood: ok\n---\n",
        ),
        (
            "---\ndate: [2025-01-14]\n---\n",
            "---\ndate: '2025-01-20'\n---\n",
        ),
        ("x\n", "---\ndate: '2025-01-20'\n---\n"),
    ];
    for (raw, block) in set {
        assert_eq!(dated(raw), Dated::Set(block.to_owned()), "{raw:?}");
    }
    for raw in [
        "---\ndate: '2025-01-20'\ntags: [a]\n---\n",
        "---\ndate: 2025-01-20\n---\n",
        "---\ndate: 2025-01-20T23:30:00+02:00\n---\n",
    ] {
        assert_eq!(dated(raw), Dated::Says, "{raw:?}");
    }
    for raw in [
        "---\n{tags: [a]}\n---\n",
        "---\n'date': '2025-01-14'\n---\n",
        "---\n- a\n---\n",
        "\u{feff}x\n",
    ] {
        assert!(matches!(dated(raw), Dated::NotInPlace(_)), "{raw:?}");
    }
}

/// A block the date cannot be set in keeps every byte through a body write, and the write is
/// logged with the day and the reason, never the file's path.
#[test]
fn a_block_the_date_cannot_be_set_in_is_kept_and_logged() {
    let mut f = fixture();
    let rel = "journal/2025-01-20.md";
    let text = "---\n{tags: [a]}\n---\nA day.\n";
    let id = f.adopt_day(rel, "2025-01-20", text);
    f.paragraph_from_sync(&id, "from the other device");
    let written = Arc::new(Mutex::new(Vec::<u8>::new()));
    let subscriber = tracing_subscriber::fmt()
        .with_writer(Mutex::new(Capture(written.clone())))
        .with_ansi(false)
        .finish();
    let outcome = tracing::subscriber::with_default(subscriber, || f.run(&id));
    let file = assert_wrote(&mut f, &outcome, rel);
    assert!(
        file.starts_with("---\n{tags: [a]}\n---\nA day.\n"),
        "{file}"
    );
    let log = String::from_utf8(written.lock().unwrap().clone()).unwrap();
    assert!(log.contains("without the day's date"), "{log}");
    assert!(log.contains(&id), "{log}");
    assert!(!log.contains(rel), "a path reached the log: {log}");
}

struct Capture(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Capture {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// A block stringified again for the writing tools data takes the day as a string, unless it
/// already says the day.
#[test]
fn a_regenerated_block_takes_the_date_unless_it_says_the_day() {
    let mut map = YamlMap::new();
    set_date(&mut map, "2025-01-20");
    assert_eq!(
        map.get("date"),
        Some(&YamlValue::String("2025-01-20".into()))
    );
    let day_ms = 1_737_331_200_000;
    let mut map = YamlMap::new();
    map.insert("date".into(), YamlValue::Date(day_ms));
    set_date(&mut map, "2025-01-20");
    assert_eq!(map.get("date"), Some(&YamlValue::Date(day_ms)));
    set_date(&mut map, "2025-01-21");
    assert_eq!(
        map.get("date"),
        Some(&YamlValue::String("2025-01-21".into()))
    );
}
