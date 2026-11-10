//! Every integration test of this crate that does not need a process of its own, built as one
//! test binary. Each file under tests/ used to be a binary of its own that linked the crate and
//! its dependencies again: hundreds of links per CI run. A file that needs its own process (it
//! re-runs its binary, pins process-wide state, installs a global allocator, or a command names
//! it with `--test`) gets a `[[test]]` target in Cargo.toml instead. `every_test_file_is_built`
//! keeps a new file from being left out of both: with `autotests = false` it would never compile.

#[cfg(feature = "markdown")]
mod editor_support;
mod http_fakes;
#[cfg(feature = "markdown")]
mod note_identity_support;
mod support;

#[path = "account_setup.rs"]
mod account_setup;
#[path = "api_attachment_fetch.rs"]
mod api_attachment_fetch;
#[path = "api_inbox.rs"]
mod api_inbox;
#[path = "api_journal.rs"]
mod api_journal;
#[path = "api_notes_write.rs"]
mod api_notes_write;
#[path = "api_search.rs"]
mod api_search;
#[path = "api_sync_oversized_update.rs"]
mod api_sync_oversized_update;
#[path = "api_sync_pass.rs"]
mod api_sync_pass;
#[path = "api_task_conformance.rs"]
mod api_task_conformance;
#[path = "api_task_tree.rs"]
mod api_task_tree;
#[path = "api_tasks.rs"]
mod api_tasks;
#[path = "api_vault_reads.rs"]
mod api_vault_reads;
#[path = "api_vault_sync.rs"]
mod api_vault_sync;
#[path = "attachment_cache.rs"]
mod attachment_cache;
#[path = "attachment_download.rs"]
mod attachment_download;
#[path = "attachment_manifest_vectors.rs"]
mod attachment_manifest_vectors;
#[path = "attachment_upload_wire.rs"]
mod attachment_upload_wire;
#[path = "auth_session.rs"]
mod auth_session;
#[path = "block_edit_vectors.rs"]
mod block_edit_vectors;
#[path = "block_refs.rs"]
mod block_refs;
#[path = "block_refs_untrusted.rs"]
mod block_refs_untrusted;
#[path = "body_edit_append.rs"]
mod body_edit_append;
#[path = "body_edit_columns.rs"]
mod body_edit_columns;
#[path = "body_edit_ops.rs"]
mod body_edit_ops;
#[path = "body_edit_replace_text.rs"]
mod body_edit_replace_text;
#[path = "body_edit_restore.rs"]
mod body_edit_restore;
#[path = "calendar_cursor_device_local.rs"]
mod calendar_cursor_device_local;
#[path = "calendar_external_relation.rs"]
mod calendar_external_relation;
#[path = "calendar_feeds.rs"]
mod calendar_feeds;
#[path = "calendar_ical_vectors.rs"]
mod calendar_ical_vectors;
#[path = "calendar_provider_push.rs"]
mod calendar_provider_push;
#[path = "calendar_settings_sync.rs"]
mod calendar_settings_sync;
#[path = "calendar_source_purge.rs"]
mod calendar_source_purge;
#[path = "calendar_vectors.rs"]
mod calendar_vectors;
#[path = "calendar_week_load.rs"]
mod calendar_week_load;
#[path = "calendar_write_vectors.rs"]
mod calendar_write_vectors;
#[path = "checklist_plain_proptest.rs"]
mod checklist_plain_proptest;
#[path = "checklist_plain_vectors.rs"]
mod checklist_plain_vectors;
#[path = "corrupt_recovery.rs"]
mod corrupt_recovery;
#[path = "crdt_blocks.rs"]
mod crdt_blocks;
#[path = "crdt_compact.rs"]
mod crdt_compact;
#[path = "crdt_convergence.rs"]
mod crdt_convergence;
#[path = "crdt_local_edit.rs"]
mod crdt_local_edit;
#[path = "crdt_snapshot_batch.rs"]
mod crdt_snapshot_batch;
#[path = "crdt_snapshot_covers_through.rs"]
mod crdt_snapshot_covers_through;
#[path = "crdt_snapshots.rs"]
mod crdt_snapshots;
#[path = "crdt_vectors.rs"]
mod crdt_vectors;
#[path = "delete_attestation_vectors.rs"]
mod delete_attestation_vectors;
#[path = "delete_keep.rs"]
mod delete_keep;
#[path = "delete_keep_vectors.rs"]
mod delete_keep_vectors;
#[path = "device_link.rs"]
mod device_link;
#[path = "domain_bookmarks.rs"]
mod domain_bookmarks;
#[path = "domain_calendar_sync.rs"]
mod domain_calendar_sync;
#[path = "domain_custom_icons.rs"]
mod domain_custom_icons;
#[path = "domain_file_aliases.rs"]
mod domain_file_aliases;
#[path = "domain_file_cover.rs"]
mod domain_file_cover;
#[path = "domain_file_tags.rs"]
mod domain_file_tags;
#[path = "domain_folders.rs"]
mod domain_folders;
#[path = "domain_inbox_queries.rs"]
mod domain_inbox_queries;
#[path = "domain_inbox_sync.rs"]
mod domain_inbox_sync;
#[path = "domain_inbox_write.rs"]
mod domain_inbox_write;
#[path = "domain_journal.rs"]
mod domain_journal;
#[path = "domain_journal_day_identity.rs"]
mod domain_journal_day_identity;
#[path = "domain_local_only.rs"]
mod domain_local_only;
#[path = "domain_note_app_move.rs"]
mod domain_note_app_move;
#[path = "domain_note_files.rs"]
mod domain_note_files;
#[path = "domain_note_folder_delete.rs"]
mod domain_note_folder_delete;
#[path = "domain_note_folder_move.rs"]
mod domain_note_folder_move;
#[path = "domain_note_identity.rs"]
mod domain_note_identity;
#[path = "domain_note_identity_moves.rs"]
mod domain_note_identity_moves;
#[path = "domain_note_journal_change.rs"]
mod domain_note_journal_change;
#[path = "domain_note_new_files.rs"]
mod domain_note_new_files;
#[path = "domain_note_positions.rs"]
mod domain_note_positions;
#[path = "domain_note_tasks.rs"]
mod domain_note_tasks;
#[path = "domain_notes.rs"]
mod domain_notes;
#[path = "domain_projects.rs"]
mod domain_projects;
#[path = "domain_projects_links.rs"]
mod domain_projects_links;
#[path = "domain_projects_write.rs"]
mod domain_projects_write;
#[path = "domain_related_items.rs"]
mod domain_related_items;
#[path = "domain_reminders_task.rs"]
mod domain_reminders_task;
#[path = "domain_saved_filters.rs"]
mod domain_saved_filters;
#[path = "domain_search.rs"]
mod domain_search;
#[path = "domain_tag_categories.rs"]
mod domain_tag_categories;
#[path = "domain_task_activity.rs"]
mod domain_task_activity;
#[path = "domain_task_settings.rs"]
mod domain_task_settings;
#[path = "domain_task_views.rs"]
mod domain_task_views;
#[path = "domain_tasks.rs"]
mod domain_tasks;
#[path = "domain_tasks_lifecycle.rs"]
mod domain_tasks_lifecycle;
#[path = "domain_tasks_write.rs"]
mod domain_tasks_write;
#[path = "domain_template_legacy.rs"]
mod domain_template_legacy;
#[path = "domain_template_store.rs"]
mod domain_template_store;
#[path = "domain_templates.rs"]
mod domain_templates;
#[path = "dryoc_parity.rs"]
mod dryoc_parity;
#[path = "editor_compaction.rs"]
mod editor_compaction;
#[path = "editor_concurrency.rs"]
mod editor_concurrency;
#[path = "editor_every_writer.rs"]
mod editor_every_writer;
#[path = "editor_excluded_refuses.rs"]
mod editor_excluded_refuses;
#[path = "editor_large_file.rs"]
mod editor_large_file;
#[path = "editor_locked_refuses.rs"]
mod editor_locked_refuses;
#[path = "editor_open_apply.rs"]
mod editor_open_apply;
#[path = "editor_origin_fanout.rs"]
mod editor_origin_fanout;
#[path = "external_feed.rs"]
mod external_feed;
#[path = "field_merge_vectors.rs"]
mod field_merge_vectors;
#[path = "fold_chunks_store.rs"]
mod fold_chunks_store;
#[path = "header_tags.rs"]
mod header_tags;
#[path = "header_tags_untrusted.rs"]
mod header_tags_untrusted;
#[path = "http_client.rs"]
mod http_client;
#[path = "inbox_vectors.rs"]
mod inbox_vectors;
#[path = "journal_body.rs"]
mod journal_body;
#[path = "journal_day_merge.rs"]
mod journal_day_merge;
#[path = "journal_links.rs"]
mod journal_links;
#[path = "journal_metadata.rs"]
mod journal_metadata;
#[path = "journal_reads.rs"]
mod journal_reads;
#[path = "journal_reminders.rs"]
mod journal_reminders;
#[path = "journal_seed.rs"]
mod journal_seed;
#[path = "journal_settings.rs"]
mod journal_settings;
#[path = "journal_vectors.rs"]
mod journal_vectors;
#[path = "link_contexts_untrusted.rs"]
mod link_contexts_untrusted;
#[path = "link_reads.rs"]
mod link_reads;
#[path = "link_reads_load.rs"]
mod link_reads_load;
#[path = "link_rewrite_file.rs"]
mod link_rewrite_file;
#[path = "link_rewrite_text.rs"]
mod link_rewrite_text;
#[path = "linking_vectors.rs"]
mod linking_vectors;
#[path = "local_first_account.rs"]
mod local_first_account;
#[path = "markdown_atomic.rs"]
mod markdown_atomic;
#[path = "markdown_bn_parse_vectors.rs"]
mod markdown_bn_parse_vectors;
#[path = "markdown_class_vectors.rs"]
mod markdown_class_vectors;
#[path = "markdown_depth.rs"]
mod markdown_depth;
#[path = "markdown_depth_untrusted.rs"]
mod markdown_depth_untrusted;
#[path = "markdown_doc_edit_vectors.rs"]
mod markdown_doc_edit_vectors;
#[path = "markdown_doc_vectors.rs"]
mod markdown_doc_vectors;
#[path = "markdown_fail_closed.rs"]
mod markdown_fail_closed;
#[path = "markdown_frontmatter_edit.rs"]
mod markdown_frontmatter_edit;
#[path = "markdown_frontmatter_vectors.rs"]
mod markdown_frontmatter_vectors;
#[path = "markdown_layer_blocks_vectors.rs"]
mod markdown_layer_blocks_vectors;
#[path = "markdown_layer_critic_vectors.rs"]
mod markdown_layer_critic_vectors;
#[path = "markdown_layer_markers_vectors.rs"]
mod markdown_layer_markers_vectors;
#[path = "markdown_md_to_html_vectors.rs"]
mod markdown_md_to_html_vectors;
#[path = "markdown_memry_parse_vectors.rs"]
mod markdown_memry_parse_vectors;
#[path = "markdown_pm_vectors.rs"]
mod markdown_pm_vectors;
#[path = "markdown_seed_corpus_vectors.rs"]
mod markdown_seed_corpus_vectors;
#[path = "markdown_seed_vectors.rs"]
mod markdown_seed_vectors;
#[path = "markdown_serialize_vectors.rs"]
mod markdown_serialize_vectors;
#[path = "markdown_yxml_vectors.rs"]
mod markdown_yxml_vectors;
#[path = "mention_mask_untrusted.rs"]
mod mention_mask_untrusted;
#[path = "note_aliases.rs"]
mod note_aliases;
#[path = "note_blocks_vectors.rs"]
mod note_blocks_vectors;
#[path = "note_header_status.rs"]
mod note_header_status;
#[path = "note_link_display.rs"]
mod note_link_display;
#[path = "note_meta.rs"]
mod note_meta;
#[path = "note_refs_move.rs"]
mod note_refs_move;
#[path = "note_snapshots.rs"]
mod note_snapshots;
#[path = "note_stats_store.rs"]
mod note_stats_store;
#[path = "note_stats_vectors.rs"]
mod note_stats_vectors;
#[path = "offline_reconnect.rs"]
mod offline_reconnect;
#[path = "outbox_crdt_batch_cap.rs"]
mod outbox_crdt_batch_cap;
#[path = "pack_vectors.rs"]
mod pack_vectors;
#[path = "portal_vectors.rs"]
mod portal_vectors;
#[path = "projector_null_tolerance.rs"]
mod projector_null_tolerance;
#[path = "push_crdt_update_cap.rs"]
mod push_crdt_update_cap;
#[path = "push_delete_wins.rs"]
mod push_delete_wins;
#[path = "push_seal.rs"]
mod push_seal;
#[path = "read_your_writes.rs"]
mod read_your_writes;
#[path = "recreate_clock_vectors.rs"]
mod recreate_clock_vectors;
#[path = "recurrence_vectors.rs"]
mod recurrence_vectors;
#[path = "roundtrip_acceptance.rs"]
mod roundtrip_acceptance;
#[path = "sync_cursor_repair.rs"]
mod sync_cursor_repair;
#[path = "sync_engine.rs"]
mod sync_engine;
#[path = "sync_engine_seed.rs"]
mod sync_engine_seed;
#[path = "sync_equal_clock.rs"]
mod sync_equal_clock;
#[path = "sync_first_sync.rs"]
mod sync_first_sync;
#[path = "sync_note_body_feed.rs"]
mod sync_note_body_feed;
#[path = "sync_outbox.rs"]
mod sync_outbox;
#[path = "sync_pack_bootstrap.rs"]
mod sync_pack_bootstrap;
#[path = "sync_realtime.rs"]
mod sync_realtime;
#[path = "sync_realtime_run.rs"]
mod sync_realtime_run;
#[path = "tag_fields.rs"]
mod tag_fields;
#[path = "tag_fold_vectors.rs"]
mod tag_fold_vectors;
#[path = "tag_objects.rs"]
mod tag_objects;
#[path = "tag_pins.rs"]
mod tag_pins;
#[path = "tag_reads.rs"]
mod tag_reads;
#[path = "tag_schema_refs_vectors.rs"]
mod tag_schema_refs_vectors;
#[path = "task_duration.rs"]
mod task_duration;
#[path = "task_field_values.rs"]
mod task_field_values;
#[path = "task_filter_vectors.rs"]
mod task_filter_vectors;
#[path = "task_parse_vectors.rs"]
mod task_parse_vectors;
#[path = "task_views_vectors.rs"]
mod task_views_vectors;
#[path = "text_extract_vectors.rs"]
mod text_extract_vectors;
#[path = "tombstone.rs"]
mod tombstone;
#[path = "tombstone_purge.rs"]
mod tombstone_purge;
#[path = "unknown_fields.rs"]
mod unknown_fields;
#[path = "unlinked_mentions.rs"]
mod unlinked_mentions;
#[path = "vault_locks.rs"]
mod vault_locks;
#[path = "vault_locks_schema.rs"]
mod vault_locks_schema;
#[path = "vault_locks_writers.rs"]
mod vault_locks_writers;
#[path = "vectors.rs"]
mod vectors;
#[path = "versioned_keys_carry.rs"]
mod versioned_keys_carry;
#[path = "versioned_values_vectors.rs"]
mod versioned_values_vectors;
#[path = "wiki_link_rewrite.rs"]
mod wiki_link_rewrite;
#[path = "wiki_name_keys.rs"]
mod wiki_name_keys;
#[path = "wiki_target_resolution_vectors.rs"]
mod wiki_target_resolution_vectors;

#[test]
fn every_test_file_is_built() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let this =
        std::fs::read_to_string(root.join("tests/integration.rs")).expect("read integration.rs");
    let manifest = std::fs::read_to_string(root.join("Cargo.toml")).expect("read Cargo.toml");
    let mut missing = Vec::new();
    for entry in std::fs::read_dir(root.join("tests")).expect("list tests/") {
        let name = entry
            .expect("dir entry")
            .file_name()
            .into_string()
            .expect("utf-8 name");
        let Some(stem) = name.strip_suffix(".rs") else {
            continue;
        };
        let built = stem == "integration"
            || this.contains(&format!("#[path = \"{name}\"]"))
            || this.contains(&format!("mod {stem};"))
            || manifest.contains(&format!("path = \"tests/{name}\""));
        if !built {
            missing.push(name);
        }
    }
    assert!(
        missing.is_empty(),
        "add these to tests/integration.rs, or give them a [[test]] target in Cargo.toml: {missing:?}"
    );
}
