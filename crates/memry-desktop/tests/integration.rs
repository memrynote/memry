//! Every integration test of this crate that does not need a process of its own, built as one
//! test binary. Each file under tests/ used to be a binary of its own that linked the crate and
//! its dependencies again: hundreds of links per CI run. A file that needs its own process (it
//! re-runs its binary, pins process-wide state, installs a global allocator, or a command names
//! it with `--test`) gets a `[[test]]` target in Cargo.toml instead. `every_test_file_is_built`
//! keeps a new file from being left out of both: with `autotests = false` it would never compile.

mod device_key;
mod index_support;
mod move_tree;
mod on_warning;
mod support;
mod svg_inert;
mod unsplash_server;
mod vault_env;

#[path = "activity_log.rs"]
mod activity_log;
#[path = "activity_scan.rs"]
mod activity_scan;
#[path = "ai_catalog.rs"]
mod ai_catalog;
#[path = "ai_inline_settings.rs"]
mod ai_inline_settings;
#[path = "ai_proxy.rs"]
mod ai_proxy;
#[path = "app_edit.rs"]
mod app_edit;
#[path = "article_constants.rs"]
mod article_constants;
#[path = "article_dom.rs"]
mod article_dom;
#[path = "article_map.rs"]
mod article_map;
#[path = "article_markdown.rs"]
mod article_markdown;
#[path = "article_mathml.rs"]
mod article_mathml;
#[path = "article_metadata.rs"]
mod article_metadata;
#[path = "article_mutations.rs"]
mod article_mutations;
#[path = "article_pipeline.rs"]
mod article_pipeline;
#[path = "article_removals.rs"]
mod article_removals;
#[path = "article_standardize.rs"]
mod article_standardize;
#[path = "article_temml.rs"]
mod article_temml;
#[path = "article_vectors.rs"]
mod article_vectors;
#[path = "attachment_actions.rs"]
mod attachment_actions;
#[path = "attachment_delete.rs"]
mod attachment_delete;
#[path = "attachment_delete_healed.rs"]
mod attachment_delete_healed;
#[path = "attachment_delete_names.rs"]
mod attachment_delete_names;
#[path = "attachment_locks.rs"]
mod attachment_locks;
#[path = "attachment_refs.rs"]
mod attachment_refs;
#[path = "attachment_rename.rs"]
mod attachment_rename;
#[path = "attachment_sources.rs"]
mod attachment_sources;
#[path = "attachment_uploads.rs"]
mod attachment_uploads;
#[path = "attachments.rs"]
mod attachments;
#[path = "block_refs.rs"]
mod block_refs;
#[path = "byte_preservation.rs"]
mod byte_preservation;
#[path = "command_failure.rs"]
mod command_failure;
#[path = "config_compat.rs"]
mod config_compat;
#[path = "content_hash_vectors.rs"]
mod content_hash_vectors;
#[path = "custom_icons.rs"]
mod custom_icons;
#[path = "debug_query.rs"]
mod debug_query;
#[path = "e2e.rs"]
mod e2e;
#[path = "editor_compaction.rs"]
mod editor_compaction;
#[path = "editor_host.rs"]
mod editor_host;
#[cfg(unix)]
#[path = "editor_readonly.rs"]
mod editor_readonly;
#[path = "embeds.rs"]
mod embeds;
#[path = "file_open.rs"]
mod file_open;
#[path = "fold_untrusted.rs"]
mod fold_untrusted;
#[path = "folder_file.rs"]
mod folder_file;
#[path = "folder_prune.rs"]
mod folder_prune;
#[path = "fs_atomic.rs"]
mod fs_atomic;
#[path = "home_covers.rs"]
mod home_covers;
#[path = "http.rs"]
mod http;
#[path = "i18n_vectors.rs"]
mod i18n_vectors;
#[path = "icons.rs"]
mod icons;
#[path = "import_copy.rs"]
mod import_copy;
#[path = "index_tag_definitions.rs"]
mod index_tag_definitions;
#[path = "indexer_facts.rs"]
mod indexer_facts;
#[path = "indexer_open_status.rs"]
mod indexer_open_status;
#[path = "indexer_scan.rs"]
mod indexer_scan;
#[path = "journal_calendar.rs"]
mod journal_calendar;
#[path = "journal_change.rs"]
mod journal_change;
#[path = "journal_change_crash.rs"]
mod journal_change_crash;
#[path = "journal_change_waits.rs"]
mod journal_change_waits;
#[path = "journal_cross_renamed.rs"]
mod journal_cross_renamed;
#[path = "journal_folder.rs"]
mod journal_folder;
#[path = "journal_folder_claim.rs"]
mod journal_folder_claim;
#[path = "journal_folder_held.rs"]
mod journal_folder_held;
#[path = "journal_folder_kept_held.rs"]
mod journal_folder_kept_held;
#[path = "journal_folder_outside.rs"]
mod journal_folder_outside;
#[path = "journal_format_vectors.rs"]
mod journal_format_vectors;
#[path = "journal_rename.rs"]
mod journal_rename;
#[path = "journal_service.rs"]
mod journal_service;
#[path = "journal_stalled_writer.rs"]
mod journal_stalled_writer;
#[path = "journal_update.rs"]
mod journal_update;
#[path = "large_file_index.rs"]
mod large_file_index;
#[path = "large_file_search.rs"]
mod large_file_search;
#[path = "large_file_sessions.rs"]
mod large_file_sessions;
#[path = "lock_outside_edits.rs"]
mod lock_outside_edits;
#[path = "lock_service.rs"]
mod lock_service;
#[path = "lock_set.rs"]
mod lock_set;
#[path = "logship.rs"]
mod logship;
#[path = "move_dir.rs"]
mod move_dir;
#[path = "move_journal.rs"]
mod move_journal;
#[path = "note_fold_service.rs"]
mod note_fold_service;
#[path = "note_fold_text_vectors.rs"]
mod note_fold_text_vectors;
#[path = "note_fold_vectors.rs"]
mod note_fold_vectors;
#[path = "note_link_mention.rs"]
mod note_link_mention;
#[path = "note_links.rs"]
mod note_links;
#[path = "note_links_changed.rs"]
mod note_links_changed;
#[path = "note_mentions.rs"]
mod note_mentions;
#[path = "note_properties_index.rs"]
mod note_properties_index;
#[path = "note_properties_learned.rs"]
mod note_properties_learned;
#[path = "note_properties_outside.rs"]
mod note_properties_outside;
#[path = "note_versions.rs"]
mod note_versions;
#[path = "notes_aliases.rs"]
mod notes_aliases;
#[path = "notes_append_blocks.rs"]
mod notes_append_blocks;
#[path = "notes_apply_template.rs"]
mod notes_apply_template;
#[path = "notes_create_template.rs"]
mod notes_create_template;
#[path = "notes_folder_delete.rs"]
mod notes_folder_delete;
#[path = "notes_folder_move.rs"]
mod notes_folder_move;
#[path = "notes_folder_move_spelling.rs"]
mod notes_folder_move_spelling;
#[path = "notes_folders.rs"]
mod notes_folders;
#[path = "notes_frontmatter.rs"]
mod notes_frontmatter;
#[path = "notes_identity.rs"]
mod notes_identity;
#[path = "notes_kept.rs"]
mod notes_kept;
#[path = "notes_link_rewrite.rs"]
mod notes_link_rewrite;
#[path = "notes_local_only.rs"]
mod notes_local_only;
#[path = "notes_moves.rs"]
mod notes_moves;
#[path = "notes_moves_edges.rs"]
mod notes_moves_edges;
#[path = "notes_outside_after_reopen.rs"]
mod notes_outside_after_reopen;
#[path = "notes_outside_tags.rs"]
mod notes_outside_tags;
#[path = "notes_properties.rs"]
mod notes_properties;
#[path = "notes_resolve_refs.rs"]
mod notes_resolve_refs;
#[path = "notes_service.rs"]
mod notes_service;
#[path = "notes_tag_rename.rs"]
mod notes_tag_rename;
#[path = "notes_tag_retag.rs"]
mod notes_tag_retag;
#[path = "notes_tag_template.rs"]
mod notes_tag_template;
#[path = "notes_update.rs"]
mod notes_update;
#[path = "notes_update_critic_marks.rs"]
mod notes_update_critic_marks;
#[path = "notes_writes.rs"]
mod notes_writes;
#[path = "path_collision.rs"]
mod path_collision;
#[path = "paths.rs"]
mod paths;
#[path = "properties_file.rs"]
mod properties_file;
#[path = "property_definitions.rs"]
mod property_definitions;
#[path = "property_definitions_seed.rs"]
mod property_definitions_seed;
#[path = "property_definitions_sync.rs"]
mod property_definitions_sync;
#[path = "sanitize_svg_inert.rs"]
mod sanitize_svg_inert;
#[path = "sanitize_svg_untrusted.rs"]
mod sanitize_svg_untrusted;
#[path = "sanitize_svg_vectors.rs"]
mod sanitize_svg_vectors;
#[path = "seams_tls.rs"]
mod seams_tls;
#[path = "seams_transport.rs"]
mod seams_transport;
#[path = "settings_service.rs"]
mod settings_service;
#[path = "sync_host_clients.rs"]
mod sync_host_clients;
#[path = "tag_definitions_sync.rs"]
mod tag_definitions_sync;
#[path = "tag_field_rename.rs"]
mod tag_field_rename;
#[path = "tag_impact.rs"]
mod tag_impact;
#[path = "tag_objects.rs"]
mod tag_objects;
#[path = "tag_schema.rs"]
mod tag_schema;
#[path = "tags.rs"]
mod tags;
#[path = "telemetry_flush.rs"]
mod telemetry_flush;
#[path = "templates.rs"]
mod templates;
#[path = "templates_legacy.rs"]
mod templates_legacy;
#[path = "typing_barrier.rs"]
mod typing_barrier;
#[path = "unsplash.rs"]
mod unsplash;
#[path = "untrusted_scheme_input.rs"]
mod untrusted_scheme_input;
#[path = "vault_app_move_open.rs"]
mod vault_app_move_open;
#[path = "vault_config.rs"]
mod vault_config;
#[path = "vault_config_unreadable.rs"]
mod vault_config_unreadable;
#[path = "vault_consumer.rs"]
mod vault_consumer;
#[path = "vault_exclude.rs"]
mod vault_exclude;
#[path = "vault_exclude_read_only.rs"]
mod vault_exclude_read_only;
#[path = "vault_init.rs"]
mod vault_init;
#[path = "vault_locks_app_edit.rs"]
mod vault_locks_app_edit;
#[path = "vault_notices.rs"]
mod vault_notices;
#[path = "vault_notices_journal.rs"]
mod vault_notices_journal;
#[path = "vault_pairing.rs"]
mod vault_pairing;
#[path = "vault_paths.rs"]
mod vault_paths;
#[path = "vault_settings.rs"]
mod vault_settings;
#[path = "vault_walk.rs"]
mod vault_walk;
#[path = "vault_watch.rs"]
mod vault_watch;
#[path = "vault_watch_reported.rs"]
mod vault_watch_reported;
#[path = "vault_watch_session.rs"]
mod vault_watch_session;
#[path = "vault_writeback.rs"]
mod vault_writeback;
#[path = "vault_writes.rs"]
mod vault_writes;

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
