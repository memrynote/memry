//! Unlinked mentions and a wiki link's hover card (#3530 13i) through `notes::mentions` and
//! `notes::link_preview`, the services the `notes_get_unlinked_mentions` and
//! `notes_preview_by_title` commands call, over a real session: records, rows, files and the
//! note index in a temp vault.

mod device_key;
mod index_support;
mod vault_env;

use std::sync::{Arc, Mutex};

use index_support::until;
use memry_core::seams::secure_store::SecureStore;
use memry_core::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::link_preview::{PreviewTagView, preview_by_title};
use memry_desktop::notes::mentions::Mentions;
use memry_desktop::vault::consumer::rows::RowStat;
use memry_desktop::vault::file_types::FileType;
use serde_json::{Value, json};
use vault_env::{env, indexed};

fn apply(core: &memry_core::api::vault::Vault, item_type: &str, id: &str, payload: Value) {
    let record = InboundRecord {
        item_type: item_type.to_owned(),
        item_id: id.to_owned(),
        payload_json: payload.to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: 1_760_000_000_000,
        deleted_at: None,
    };
    let outcome = core
        .db_handle()
        .call_blocking(move |data| sync_items::apply_remote(data, &record, 1_760_000_000_000))
        .unwrap();
    assert!(!matches!(outcome, ApplyOutcome::Corrupt { .. }), "{id}");
}

#[test]
fn mentions_are_read_from_each_source_body_and_leave_out_backlinks_and_the_note_itself() {
    let store: Mutex<Option<Arc<dyn SecureStore>>> = Mutex::default();
    let mut e = env(|s| {
        *store.lock().unwrap() = Some(s.clone());
        Some(NotesIdentity::new(s))
    });
    e.write("Target.md", "# Target\n\nTarget mentions itself.\n");
    // The frontmatter is not the body, and code, comments and links are not mentions.
    e.write(
        "notes/Standup.md",
        "---\nsummary: Target\n---\nWe met about Target today.\n`Target` <!-- Target --> [x](Target)\n\nThe target again.\n",
    );
    e.write("Linked.md", "[[Target]] and Target in plain text\n");
    e.write("Elsewhere.md", "Nothing to see.\n");
    let index = NoteIndex::new(e.tier.clone(), |_| {}, |_| {});
    index.register(&e.session);
    e.open();
    e.facts_until(indexed);
    let id_at = |path: &str| -> String {
        e.rows()
            .into_iter()
            .find(|(_, p)| p == path)
            .unwrap_or_else(|| panic!("no row at {path}"))
            .0
    };
    let (target, standup) = (id_at("Target.md"), id_at("notes/Standup.md"));
    let mentions = Mentions::new(&e.session.current().unwrap());
    until("the sources indexed", || {
        mentions.get(&target).unwrap().len() == 1
    });

    let got = mentions.get(&target).unwrap();
    let source = &got[0];
    assert_eq!(
        (
            source.source_id.as_str(),
            source.source_path.as_str(),
            source.source_title.as_str()
        ),
        (standup.as_str(), "notes/Standup.md", "Standup")
    );
    let shown: Vec<String> = source
        .contexts
        .iter()
        .map(|c| {
            let units: Vec<u16> = c.snippet.encode_utf16().collect();
            String::from_utf16(&units[c.link_start as usize..c.link_end as usize]).unwrap()
        })
        .collect();
    assert_eq!(shown, ["Target", "target"]);
    assert_eq!((source.mention_count, source.truncated), (2, false));
    assert_eq!(
        source.contexts[0].snippet,
        "We met about Target today. `Target` <!-- Target --> [x](Target)  The target aga…"
    );
    assert!(mentions.get("no-such-note").unwrap().is_empty());
    drop(mentions);
    e.close();
}

#[test]
fn a_link_card_reads_the_note_its_name_resolves_to() {
    let mut e = env(|_| None);
    e.open();
    let core = e.core();
    let rows = e.tier.rows();
    let session = rows.session_for(&core).unwrap();
    let note = |id: &str, title: &str, aliases: Value, text: &str| {
        apply(
            &core,
            "note",
            id,
            json!({ "title": title, "fileType": "markdown", "aliases": aliases }),
        );
        let path = format!("{title}.md");
        e.write(&path, text);
        let stat = RowStat {
            file_type: FileType::Markdown,
            size: text.len() as u64,
            content_hash: None,
            file_hash: None,
        };
        rows.reserve(session, id, &path, stat).unwrap();
    };
    note(
        "n-plan",
        "Plan",
        json!(["Roadmap"]),
        "---\ntags: [work, later]\ncover: wash:sage\nemoji: \"🗺️\"\n---\n# Goals\n\nShip **it**.\n",
    );
    note(
        "n-why",
        "Why",
        json!([]),
        "---\ndescription: The reasons\n---\nLong body.\n",
    );
    apply(
        &core,
        "tag_definition",
        "work",
        json!({ "name": "work", "color": "teal" }),
    );
    let open = e.session.current().unwrap();

    let card = preview_by_title(&open, "Roadmap").unwrap().unwrap();
    assert_eq!(
        (card.id.as_str(), card.title.as_str(), card.path.as_str()),
        ("n-plan", "Plan", "Plan.md")
    );
    assert_eq!(card.matched_name.as_deref(), Some("Roadmap"));
    assert_eq!(
        card.tags,
        [
            PreviewTagView {
                name: "work".to_owned(),
                color: "teal".to_owned()
            },
            PreviewTagView {
                name: "later".to_owned(),
                color: "stone".to_owned()
            },
        ]
    );
    assert_eq!(card.cover.as_deref(), Some("wash:sage"));
    assert_eq!(card.description, None);
    assert_eq!(card.body.as_deref(), Some("# Goals\n\nShip **it**.\n"));
    assert_eq!(card.snippet.as_deref(), Some("Goals Ship it."));
    assert!(card.created_at.ends_with('Z'), "{}", card.created_at);
    assert_eq!(
        preview_by_title(&open, "plan")
            .unwrap()
            .unwrap()
            .matched_name,
        None
    );

    // A card with a description shows it and needs no body.
    let why = preview_by_title(&open, "Why").unwrap().unwrap();
    assert_eq!(
        (why.description.as_deref(), why.body),
        (Some("The reasons"), None)
    );
    assert!(preview_by_title(&open, "Nowhere").unwrap().is_none());
    drop(open);
    e.close();
}
