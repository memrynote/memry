//! Article captures (`ingestArticleCapture`, `ingest.ts`) against real
//! SQLite: the row desktop writes for an article, a screenshot and a PDF, the
//! enrich path, and the folder guard on stored files.

use memry_core::domain::inbox::ingest::{
    self, InboxArticle, InboxArticleFiles, InboxArticlePdf, InboxArticleProperties,
    InboxExtractionStatus,
};
use memry_core::domain::inbox::write;
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use rusqlite::{Connection, params};
use serde_json::{Value, json};

const NOW: i64 = 1_790_251_200_000;
const DEVICE: &str = "desk";
const SOURCE: &str = "browser-extension";

fn open(label: &str) -> Db {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-inbox-ingest-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn article() -> InboxArticle {
    InboxArticle {
        url: "https://example.com/post".into(),
        content_markdown: "# Post\n\nBody".into(),
        excerpt: "Body".into(),
        extraction_status: InboxExtractionStatus::Full,
        properties: InboxArticleProperties {
            title: "Post".into(),
            source: "example.com".into(),
            author: Some("Ada".into()),
            published: None,
            created: "2026-09-24".into(),
            description: None,
        },
        hero_image: Some("https://example.com/hero.jpg".into()),
    }
}

fn payload(conn: &Connection, id: &str) -> Value {
    let raw = sync_items::push_payload(conn, "inbox", id)
        .expect("row")
        .expect("payload");
    serde_json::from_str(&raw).expect("json")
}

fn tags(conn: &Connection, id: &str) -> Vec<String> {
    let mut statement = conn
        .prepare("SELECT tag FROM inbox_item_tags WHERE item_id = ?1 ORDER BY tag")
        .expect("prepare");
    statement
        .query_map(params![id], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

fn upload_marked(conn: &Connection, id: &str) -> bool {
    conn.query_row(
        "SELECT count(*) FROM inbox_attachment_uploads WHERE item_id = ?1",
        params![id],
        |row| row.get::<_, i64>(0),
    )
    .expect("count")
        == 1
}

#[test]
fn an_article_becomes_a_tagged_link_with_its_hero_as_thumbnail() {
    let db = open("article");
    db.call_blocking(|conn| {
        let id = write::mint_id();
        let hero = format!("attachments/inbox/{id}/thumbnail.jpg");
        let files = InboxArticleFiles {
            hero_path: Some(hero.clone()),
            ..InboxArticleFiles::default()
        };
        let item =
            ingest::capture_article(conn, &id, &article(), &files, None, SOURCE, DEVICE, NOW)?
                .acknowledge();
        assert_eq!(item.item_type, "link");
        let p = payload(conn, &id);
        assert_eq!(p["title"], "Post");
        assert_eq!(p["content"], "# Post\n\nBody");
        assert_eq!(p["sourceUrl"], "https://example.com/post");
        assert_eq!(p["captureSource"], SOURCE);
        assert_eq!(p["processingStatus"], "complete");
        assert_eq!(p["thumbnailPath"], json!(hero));
        assert_eq!(p["attachmentPath"], Value::Null);
        assert_eq!(
            p["metadata"],
            json!({
                "url": "https://example.com/post",
                "fetchStatus": "complete",
                "excerpt": "Body",
                "extractionStatus": "full",
                "heroImage": "https://example.com/hero.jpg",
                "properties": {
                    "title": "Post", "source": "example.com", "author": "Ada",
                    "created": "2026-09-24"
                }
            })
        );
        assert_eq!(tags(conn, &id), ["clippings"]);
        assert!(!upload_marked(conn, &id), "only a pdf's file uploads");
        Ok(())
    })
    .expect("article");
}

#[test]
fn a_screenshot_is_the_body_and_the_thumbnail() {
    let db = open("screenshot");
    db.call_blocking(|conn| {
        let id = write::mint_id();
        let shot = format!("attachments/inbox/{id}/screenshot.png");
        let files = InboxArticleFiles {
            screenshot_path: Some(shot.clone()),
            hero_path: Some(format!("attachments/inbox/{id}/thumbnail.jpg")),
            ..InboxArticleFiles::default()
        };
        let mut capture = article();
        capture.content_markdown = String::new();
        let tags_in = vec!["read-later".to_owned()];
        ingest::capture_article(
            conn,
            &id,
            &capture,
            &files,
            Some(&tags_in),
            SOURCE,
            DEVICE,
            NOW,
        )?;
        let p = payload(conn, &id);
        assert_eq!(p["content"], json!(format!("![screenshot]({shot})")));
        assert_eq!(p["thumbnailPath"], json!(shot));
        assert_eq!(tags(conn, &id), ["read-later"]);
        Ok(())
    })
    .expect("screenshot");
}

#[test]
fn a_pdf_is_a_pdf_capture_whose_file_uploads() {
    let db = open("pdf");
    db.call_blocking(|conn| {
        let id = write::mint_id();
        let path = format!("attachments/inbox/{id}/paper.pdf");
        let files = InboxArticleFiles {
            pdf: Some(InboxArticlePdf {
                path: path.clone(),
                filename: "paper.pdf".into(),
                size: 4096,
            }),
            ..InboxArticleFiles::default()
        };
        let mut capture = article();
        capture.hero_image = None;
        ingest::capture_article(conn, &id, &capture, &files, Some(&[]), SOURCE, DEVICE, NOW)?;
        let p = payload(conn, &id);
        assert_eq!(p["type"], "pdf");
        assert_eq!(p["content"], Value::Null);
        assert_eq!(p["attachmentPath"], json!(path));
        assert_eq!(p["thumbnailPath"], Value::Null);
        assert_eq!(p["metadata"]["originalFilename"], "paper.pdf");
        assert_eq!(p["metadata"]["fileSize"], 4096);
        assert_eq!(p["metadata"]["mimeType"], "application/pdf");
        assert!(p["metadata"].get("heroImage").is_none());
        assert!(
            tags(conn, &id).is_empty(),
            "an explicit empty list adds none"
        );
        assert!(upload_marked(conn, &id));
        Ok(())
    })
    .expect("pdf");
}

#[test]
fn a_file_outside_the_captures_folder_is_refused_and_nothing_is_written() {
    let db = open("guard");
    db.call_blocking(|conn| {
        let id = write::mint_id();
        for path in [
            "attachments/inbox/other/x.png".to_owned(),
            format!("attachments/inbox/{id}/../x.png"),
            format!("notes/{id}/x.png"),
        ] {
            let files = InboxArticleFiles {
                screenshot_path: Some(path),
                ..InboxArticleFiles::default()
            };
            assert!(
                ingest::capture_article(conn, &id, &article(), &files, None, SOURCE, DEVICE, NOW)
                    .is_err()
            );
        }
        assert!(sync_items::push_payload(conn, "inbox", &id)?.is_none());
        let stray = write::mint_id();
        let item = ingest::capture_article(
            conn,
            &stray,
            &article(),
            &InboxArticleFiles::default(),
            None,
            SOURCE,
            DEVICE,
            NOW,
        )?
        .acknowledge();
        assert!(
            ingest::enrich_article(
                conn,
                &item.id,
                &article(),
                Some("attachments/x.jpg"),
                DEVICE,
                NOW
            )
            .is_err()
        );
        Ok(())
    })
    .expect("guard");
}

#[test]
fn enriching_replaces_the_article_keys_and_keeps_the_rest() {
    let db = open("enrich");
    db.call_blocking(|conn| {
        let item = match write::capture_link(
            conn,
            "https://example.com/post",
            None,
            false,
            DEVICE,
            NOW,
        )? {
            write::Captured::Created(item) | write::Captured::Duplicate(item) => item,
        };
        let hero = format!("attachments/inbox/{}/thumbnail.png", item.id);
        let mut capture = article();
        capture.extraction_status = InboxExtractionStatus::Partial;
        ingest::enrich_article(conn, &item.id, &capture, Some(&hero), DEVICE, NOW + 1)?;
        let p = payload(conn, &item.id);
        assert_eq!(p["content"], "# Post\n\nBody");
        assert_eq!(p["thumbnailPath"], json!(hero));
        assert_eq!(p["type"], "link");
        assert_eq!(p["metadata"]["fetchStatus"], "pending", "other keys stay");
        assert_eq!(p["metadata"]["extractionStatus"], "partial");
        assert_eq!(p["metadata"]["properties"]["author"], "Ada");
        assert!(
            p["metadata"].get("heroImage").is_none(),
            "enrich does not add it"
        );

        ingest::enrich_article(conn, &item.id, &capture, None, DEVICE, NOW + 2)?;
        assert_eq!(
            payload(conn, &item.id)["thumbnailPath"],
            json!(hero),
            "kept without a new hero"
        );
        Ok(())
    })
    .expect("enrich");
}
