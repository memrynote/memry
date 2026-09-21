//! The local attachment cache and note references (N203, N204).
//!
//! Real SQLite, through the domain. No transport.
//!
//! | Test                                                  | Rule                        |
//! | ----------------------------------------------------- | --------------------------- |
//! | an absent reference list changes nothing              | §14.7, chapter 13 §13.4     |
//! | an explicitly empty list does clear                   | same, the other half        |
//! | a reference to an unfetched attachment still gets a row | a placeholder needs one   |
//! | a dropped reference stops pointing at the note        | §14.7                       |
//! | the metered policy, per path and per override         | FR-045                      |
//! | eviction clears paths, keeps rows, spares pins        | data-model §A.4             |
//! | the budget is measured in ciphertext bytes            | §14.8                       |
//! | a manifest re-fetch keeps the user's settings         | a pin is the user's         |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::api::vault::Vault;
use memry_core::domain::attachments;
use memry_core::seams::reachability::Reachable;
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn vault(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-attachments-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    open_data(&dir.join("data.db")).expect("second open")
}

/// A stored manifest plus downloaded bytes, which is the ordinary state.
fn cached(db: &Db, id: &str, size: i64, path: &str, downloaded_at: i64) {
    let id = id.to_owned();
    let path = path.to_owned();
    db.call_blocking(move |conn: &mut Connection| {
        attachments::put_manifest(conn, &id, "{}", size, "f.png", "image/png")?;
        attachments::record_download(conn, &id, &path, downloaded_at)?;
        Ok(())
    })
    .expect("the write");
}

// MARK: - N204, absence is not emptiness

/// §14.7: `attachmentReferences` is nullable and optional, so absent means
/// "this sender does not know". Clearing on that would delete a note's
/// pictures from this device because a different device stayed quiet.
#[test]
fn an_absent_reference_list_changes_nothing() {
    let db = vault("absent");
    cached(&db, "att-1", 100, "a.png", 1);
    db.call_blocking(|conn: &mut Connection| {
        attachments::merge_note_references(conn, "note-1", Some(&["att-1".to_owned()]))?;
        Ok(())
    })
    .expect("the first merge");

    db.call_blocking(|conn: &mut Connection| {
        // The shape an older client's push has.
        attachments::merge_note_references(conn, "note-1", None)?;
        let still = attachments::for_note(conn, "note-1")?;
        assert_eq!(
            still.len(),
            1,
            "an absent list must not clear what another sender told us"
        );
        Ok(())
    })
    .expect("the absent merge");
}

/// The other half, and the reason `Option` is the right shape: a sender that
/// *knows* there are none says so, and that does clear.
#[test]
fn an_explicitly_empty_list_clears() {
    let db = vault("empty");
    cached(&db, "att-1", 100, "a.png", 1);
    db.call_blocking(|conn: &mut Connection| {
        attachments::merge_note_references(conn, "note-1", Some(&["att-1".to_owned()]))?;
        assert_eq!(attachments::for_note(conn, "note-1")?.len(), 1);

        attachments::merge_note_references(conn, "note-1", Some(&[]))?;
        assert!(
            attachments::for_note(conn, "note-1")?.is_empty(),
            "a sender that knows there are none is believed"
        );
        // The row survives: it still remembers the manifest and the bytes.
        assert!(attachments::get(conn, "att-1")?.is_some());
        Ok(())
    })
    .expect("the merges");
}

/// A reference this device has never fetched still needs somewhere to land,
/// or the note cannot draw a placeholder and a later fetch has no row.
#[test]
fn a_reference_to_an_unfetched_attachment_still_gets_a_row() {
    let db = vault("unfetched");
    db.call_blocking(|conn: &mut Connection| {
        attachments::merge_note_references(conn, "note-1", Some(&["att-new".to_owned()]))?;
        let row = attachments::get(conn, "att-new")?.expect("a row");
        assert_eq!(row.note_refs, vec!["note-1".to_owned()]);
        assert!(row.manifest.is_none(), "known about, not yet pulled");
        assert!(row.local_path.is_none());
        // FR-045's default arrives with the row.
        assert!(row.unmetered_only, "the default is unmetered-only");
        Ok(())
    })
    .expect("the merge");
}

#[test]
fn a_dropped_reference_stops_pointing_at_the_note() {
    let db = vault("dropped");
    cached(&db, "att-1", 100, "a.png", 1);
    cached(&db, "att-2", 100, "b.png", 2);
    db.call_blocking(|conn: &mut Connection| {
        attachments::merge_note_references(
            conn,
            "note-1",
            Some(&["att-1".to_owned(), "att-2".to_owned()]),
        )?;
        assert_eq!(attachments::for_note(conn, "note-1")?.len(), 2);

        // The user deleted one picture from the note.
        attachments::merge_note_references(conn, "note-1", Some(&["att-1".to_owned()]))?;
        let remaining = attachments::for_note(conn, "note-1")?;
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].attachment_id, "att-1");
        Ok(())
    })
    .expect("the merges");
}

/// One attachment in two notes: dropping it from one must not unhook the
/// other.
#[test]
fn an_attachment_shared_by_two_notes_keeps_the_other_reference() {
    let db = vault("shared");
    cached(&db, "att-1", 100, "a.png", 1);
    db.call_blocking(|conn: &mut Connection| {
        attachments::merge_note_references(conn, "note-1", Some(&["att-1".to_owned()]))?;
        attachments::merge_note_references(conn, "note-2", Some(&["att-1".to_owned()]))?;
        attachments::merge_note_references(conn, "note-1", Some(&[]))?;

        assert!(attachments::for_note(conn, "note-1")?.is_empty());
        assert_eq!(
            attachments::for_note(conn, "note-2")?.len(),
            1,
            "note-2 still references it"
        );
        Ok(())
    })
    .expect("the merges");
}

// MARK: - N206a, binding a block to an attachment (Q4)

/// The rule desktop already implements in both directions: it writes an
/// embedded attachment to `attachments/<noteId>/<basename(manifest.filename)>`
/// and resolves a block url against that same path.
#[test]
fn a_block_url_binds_by_the_manifest_basename() {
    let db = vault("bind");
    db.call_blocking(|conn: &mut Connection| {
        attachments::put_manifest(conn, "att-1", "{}", 10, "diagram.png", "image/png")?;
        attachments::merge_note_references(conn, "note-1", Some(&["att-1".to_owned()]))?;

        // The url form desktop writes for an embedded attachment.
        let bound =
            attachments::resolve_for_block(conn, "note-1", "attachments/note-1/diagram.png")?;
        match bound {
            attachments::BlockAttachment::Bound { attachment } => {
                assert_eq!(attachment.attachment_id, "att-1");
            }
            other => panic!("expected a binding, got {other:?}"),
        }
        Ok(())
    })
    .expect("the binding");
}

#[test]
fn a_percent_encoded_url_still_binds() {
    let db = vault("encoded");
    db.call_blocking(|conn: &mut Connection| {
        attachments::put_manifest(conn, "att-1", "{}", 10, "my file.pdf", "application/pdf")?;
        attachments::merge_note_references(conn, "note-1", Some(&["att-1".to_owned()]))?;

        let bound = attachments::resolve_for_block(conn, "note-1", "my%20file.pdf")?;
        assert!(matches!(bound, attachments::BlockAttachment::Bound { .. }));
        Ok(())
    })
    .expect("the binding");
}

/// Each note has its own attachments directory, so the same basename in two
/// notes is not a collision — which is why the match is scoped to the note's
/// own references.
#[test]
fn two_notes_with_the_same_basename_do_not_collide() {
    let db = vault("scoped");
    db.call_blocking(|conn: &mut Connection| {
        attachments::put_manifest(conn, "att-a", "{}", 10, "screenshot.png", "image/png")?;
        attachments::put_manifest(conn, "att-b", "{}", 10, "screenshot.png", "image/png")?;
        attachments::merge_note_references(conn, "note-a", Some(&["att-a".to_owned()]))?;
        attachments::merge_note_references(conn, "note-b", Some(&["att-b".to_owned()]))?;

        for (note, expected) in [("note-a", "att-a"), ("note-b", "att-b")] {
            match attachments::resolve_for_block(conn, note, "screenshot.png")? {
                attachments::BlockAttachment::Bound { attachment } => {
                    assert_eq!(attachment.attachment_id, expected);
                }
                other => panic!("{note}: expected a binding, got {other:?}"),
            }
        }
        Ok(())
    })
    .expect("the bindings");
}

/// One note holding two attachments with the same basename. Desktop cannot
/// tell them apart either — both materialise to one path and one overwrites
/// the other — so picking one here risks showing the wrong picture.
#[test]
fn an_ambiguous_basename_is_refused_rather_than_guessed() {
    let db = vault("ambiguous");
    db.call_blocking(|conn: &mut Connection| {
        attachments::put_manifest(conn, "att-a", "{}", 10, "a/shot.png", "image/png")?;
        attachments::put_manifest(conn, "att-b", "{}", 10, "b/shot.png", "image/png")?;
        attachments::merge_note_references(
            conn,
            "note-1",
            Some(&["att-a".to_owned(), "att-b".to_owned()]),
        )?;

        match attachments::resolve_for_block(conn, "note-1", "shot.png")? {
            attachments::BlockAttachment::Ambiguous { basename } => {
                assert_eq!(basename, "shot.png");
            }
            other => panic!("an ambiguous match must be refused, got {other:?}"),
        }
        Ok(())
    })
    .expect("the refusal");
}

/// A remote image is ordinary content, not a failed download. Desktop refuses
/// to resolve these against the vault for the same reason.
#[test]
fn a_url_with_a_scheme_is_not_a_vault_attachment() {
    let db = vault("remote");
    db.call_blocking(|conn: &mut Connection| {
        for url in [
            "https://example.com/a.png",
            "http://example.com/a.png",
            "data:image/png;base64,AAAA",
            "/absolute/a.png",
        ] {
            match attachments::resolve_for_block(conn, "note-1", url)? {
                attachments::BlockAttachment::Remote { url: seen } => assert_eq!(seen, url),
                other => panic!("{url} must be remote, got {other:?}"),
            }
        }
        Ok(())
    })
    .expect("the remote urls");
}

#[test]
fn a_block_naming_nothing_this_device_holds_is_unknown() {
    let db = vault("unknown");
    db.call_blocking(|conn: &mut Connection| {
        assert!(matches!(
            attachments::resolve_for_block(conn, "note-1", "missing.png")?,
            attachments::BlockAttachment::Unknown
        ));
        // An empty url is not a remote url and not a binding either.
        assert!(matches!(
            attachments::resolve_for_block(conn, "note-1", "")?,
            attachments::BlockAttachment::Unknown
        ));
        Ok(())
    })
    .expect("the unknowns");
}

// MARK: - N203, the metered policy

/// FR-045: lazy, defaulting to unmetered, with an explicit per-item override.
#[test]
fn the_metered_policy_is_a_function_of_the_path_and_the_override() {
    let db = vault("metered");
    cached(&db, "att-1", 100, "a.png", 1);

    db.call_blocking(|conn: &mut Connection| {
        let row = attachments::get(conn, "att-1")?.expect("a row");
        assert!(row.unmetered_only, "the default");

        // Offline is never a download, whatever the override says.
        assert!(!attachments::may_download(&row, Reachable::Offline));
        // On an unmetered path the override is irrelevant: the setting says
        // "not on metered data", not "only when I ask".
        assert!(attachments::may_download(&row, Reachable::Wifi));
        // The one interesting case.
        assert!(!attachments::may_download(&row, Reachable::Cellular));

        attachments::set_unmetered_only(conn, "att-1", false)?;
        let overridden = attachments::get(conn, "att-1")?.expect("a row");
        assert!(
            attachments::may_download(&overridden, Reachable::Cellular),
            "the explicit override is what makes a cellular fetch allowed"
        );
        assert!(!attachments::may_download(&overridden, Reachable::Offline));
        Ok(())
    })
    .expect("the policy");
}

// MARK: - N203, the bounded cache

/// data-model §A.4: eviction removes files and clears `local_path`; it never
/// removes rows. The row is what remembers the manifest and the references, so
/// deleting it would turn an evicted picture into an unknown one.
#[test]
fn eviction_clears_paths_and_keeps_rows() {
    let db = vault("evict");
    cached(&db, "old", 600, "old.png", 1);
    cached(&db, "new", 600, "new.png", 2);

    db.call_blocking(|conn: &mut Connection| {
        assert_eq!(attachments::cached_bytes(conn)?, 1200);

        let eviction = attachments::evict_to_budget(conn, 700)?;
        assert_eq!(eviction.paths, vec!["old.png".to_owned()], "oldest first");
        assert_eq!(eviction.reclaimed, 600);
        assert_eq!(attachments::cached_bytes(conn)?, 600);

        // The row survives, with its bytes forgotten.
        let row = attachments::get(conn, "old")?.expect("the row survives eviction");
        assert!(row.local_path.is_none());
        assert!(row.downloaded_at.is_none());
        assert_eq!(row.manifest.as_deref(), Some("{}"), "the manifest is kept");
        Ok(())
    })
    .expect("the eviction");
}

/// A pin is an explicit instruction, and a cache cannot both honour it and
/// guarantee a ceiling. The pin wins and the pass returns over budget.
#[test]
fn eviction_never_touches_a_pinned_row() {
    let db = vault("pinned");
    cached(&db, "pinned", 1000, "p.png", 1);
    cached(&db, "loose", 100, "l.png", 2);

    db.call_blocking(|conn: &mut Connection| {
        attachments::set_pinned(conn, "pinned", true)?;
        let eviction = attachments::evict_to_budget(conn, 50)?;

        assert_eq!(eviction.paths, vec!["l.png".to_owned()]);
        assert!(
            attachments::get(conn, "pinned")?
                .expect("row")
                .local_path
                .is_some(),
            "a pinned row survives even when it alone exceeds the budget"
        );
        assert_eq!(
            attachments::cached_bytes(conn)?,
            1000,
            "the pass ends over budget rather than breaking the pin"
        );
        Ok(())
    })
    .expect("the eviction");
}

#[test]
fn a_cache_already_within_budget_evicts_nothing() {
    let db = vault("within");
    cached(&db, "att-1", 100, "a.png", 1);
    db.call_blocking(|conn: &mut Connection| {
        let eviction = attachments::evict_to_budget(conn, 1000)?;
        assert!(eviction.paths.is_empty());
        assert_eq!(eviction.reclaimed, 0);
        Ok(())
    })
    .expect("the eviction");
}

/// §14.8: quota and the cache budget are both ciphertext figures. A cache
/// sized against `manifest.size` under-counts by a nonce and a tag per chunk,
/// so `remote_size` is what is summed.
#[test]
fn the_budget_is_measured_in_the_ciphertext_size() {
    let db = vault("ciphertext");
    // A 10-byte plaintext file whose ciphertext is 50 bytes.
    cached(&db, "att-1", 50, "a.png", 1);
    db.call_blocking(|conn: &mut Connection| {
        assert_eq!(
            attachments::cached_bytes(conn)?,
            50,
            "the ciphertext figure, not the plaintext one"
        );
        Ok(())
    })
    .expect("the read");
}

/// A manifest is re-fetched whenever a note is opened on a device that evicted
/// the bytes. `pinned` and `unmetered_only` are the **user's** settings and
/// must survive that, or a re-open silently undoes what they asked for.
#[test]
fn a_manifest_refetch_keeps_the_users_settings_and_references() {
    let db = vault("refetch");
    cached(&db, "att-1", 100, "a.png", 1);

    db.call_blocking(|conn: &mut Connection| {
        attachments::merge_note_references(conn, "note-1", Some(&["att-1".to_owned()]))?;
        attachments::set_pinned(conn, "att-1", true)?;
        attachments::set_unmetered_only(conn, "att-1", false)?;

        // The same attachment's manifest, fetched again.
        attachments::put_manifest(
            conn,
            "att-1",
            r#"{"id":"att-1"}"#,
            140,
            "f2.png",
            "image/png",
        )?;

        let row = attachments::get(conn, "att-1")?.expect("the row");
        assert!(row.pinned, "a pin survives a re-fetch");
        assert!(!row.unmetered_only, "so does the override");
        assert_eq!(row.note_refs, vec!["note-1".to_owned()], "so do references");
        assert_eq!(row.remote_size, Some(140), "the manifest itself is updated");
        Ok(())
    })
    .expect("the refetch");
}

/// The sweep that reclaims bytes orphaned when a shell died between clearing
/// the column and unlinking the file.
#[test]
fn the_cache_reports_every_path_it_believes_is_on_disk() {
    let db = vault("orphans");
    cached(&db, "att-1", 100, "a.png", 1);
    cached(&db, "att-2", 100, "b.png", 2);

    db.call_blocking(|conn: &mut Connection| {
        let mut paths = attachments::orphan_candidates(conn)?;
        paths.sort();
        assert_eq!(paths, vec!["a.png".to_owned(), "b.png".to_owned()]);

        attachments::evict_to_budget(conn, 100)?;
        let after = attachments::orphan_candidates(conn)?;
        assert_eq!(
            after.len(),
            1,
            "an evicted path is no longer claimed, so a sweep can reclaim its file"
        );
        Ok(())
    })
    .expect("the sweep");
}
