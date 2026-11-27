//! Every integration test of this crate that does not need a process of its own, built as one
//! test binary. Each file under tests/ used to be a binary of its own that linked the crate and
//! its dependencies again: hundreds of links per CI run. A file that needs its own process (it
//! re-runs its binary, pins process-wide state, installs a global allocator, or a command names
//! it with `--test`) gets a `[[test]]` target in Cargo.toml instead. `every_test_file_is_built`
//! keeps a new file from being left out of both: with `autotests = false` it would never compile.

mod ai_fake;
mod caldav_server;
mod capture_support;
mod device_key;
mod electron_profile;
mod embedding_lane;
mod import_support;
mod index_support;
mod move_tree;
mod on_warning;
mod support;
mod svg_inert;
mod unsplash_server;
mod vault_env;

#[path = "account_oauth.rs"]
mod account_oauth;
#[path = "account_service.rs"]
mod account_service;
#[path = "account_sign_out_cancel.rs"]
mod account_sign_out_cancel;
#[path = "account_teardown.rs"]
mod account_teardown;
#[path = "account_vault_directory.rs"]
mod account_vault_directory;
#[path = "account_vault_download.rs"]
mod account_vault_download;
#[path = "activity_log.rs"]
mod activity_log;
#[path = "activity_scan.rs"]
mod activity_scan;
#[path = "agent_gate_wiring.rs"]
mod agent_gate_wiring;
#[path = "agent_mcp.rs"]
mod agent_mcp;
#[path = "agent_mcp_http.rs"]
mod agent_mcp_http;
#[path = "agent_mcp_parts.rs"]
mod agent_mcp_parts;
#[path = "agent_store.rs"]
mod agent_store;
#[path = "agent_write_gate.rs"]
mod agent_write_gate;
#[path = "ai_catalog.rs"]
mod ai_catalog;
#[path = "ai_features.rs"]
mod ai_features;
#[path = "ai_fill_fields.rs"]
mod ai_fill_fields;
#[path = "ai_inline_settings.rs"]
mod ai_inline_settings;
#[path = "ai_local_agent.rs"]
mod ai_local_agent;
#[path = "ai_local_agent_guards.rs"]
mod ai_local_agent_guards;
#[path = "ai_local_provider.rs"]
mod ai_local_provider;
#[path = "ai_proxy.rs"]
mod ai_proxy;
#[path = "ai_proxy_refusals.rs"]
mod ai_proxy_refusals;
#[path = "ai_structured.rs"]
mod ai_structured;
#[path = "ai_structured_shapes.rs"]
mod ai_structured_shapes;
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
#[path = "billing_service.rs"]
mod billing_service;
#[path = "block_refs.rs"]
mod block_refs;
#[path = "byte_preservation.rs"]
mod byte_preservation;
#[path = "calendar_caldav.rs"]
mod calendar_caldav;
#[path = "calendar_caldav_connect.rs"]
mod calendar_caldav_connect;
#[path = "calendar_caldav_sync.rs"]
mod calendar_caldav_sync;
#[path = "calendar_eventkit.rs"]
mod calendar_eventkit;
#[path = "calendar_feeds.rs"]
mod calendar_feeds;
#[path = "calendar_ics_fetch.rs"]
mod calendar_ics_fetch;
#[path = "calendar_settings.rs"]
mod calendar_settings;
#[path = "canvas_files.rs"]
mod canvas_files;
#[path = "canvas_folders.rs"]
mod canvas_folders;
#[path = "canvas_service.rs"]
mod canvas_service;
#[path = "canvas_vault_id.rs"]
mod canvas_vault_id;
#[path = "capture_pairing.rs"]
mod capture_pairing;
#[path = "capture_requests.rs"]
mod capture_requests;
#[path = "capture_server.rs"]
mod capture_server;
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
#[path = "electron_profile_fixture.rs"]
mod electron_profile_fixture;
#[path = "electron_vault_prep.rs"]
mod electron_vault_prep;
#[path = "electron_yjs_journal.rs"]
mod electron_yjs_journal;
#[path = "embedding_file_text.rs"]
mod embedding_file_text;
#[path = "embedding_owed.rs"]
mod embedding_owed;
#[path = "embedding_projector.rs"]
mod embedding_projector;
#[path = "embedding_worker.rs"]
mod embedding_worker;
#[path = "embeds.rs"]
mod embeds;
#[path = "file_open.rs"]
mod file_open;
#[path = "file_text_env.rs"]
mod file_text_env;
#[path = "file_text_ocr.rs"]
mod file_text_ocr;
#[path = "file_text_runner.rs"]
mod file_text_runner;
#[path = "fold_agent.rs"]
mod fold_agent;
#[path = "fold_untrusted.rs"]
mod fold_untrusted;
#[path = "folder_file.rs"]
mod folder_file;
#[path = "folder_prune.rs"]
mod folder_prune;
#[path = "folder_view.rs"]
mod folder_view;
#[path = "fs_atomic.rs"]
mod fs_atomic;
#[path = "home_boards.rs"]
mod home_boards;
#[path = "home_covers.rs"]
mod home_covers;
#[path = "http.rs"]
mod http;
#[path = "i18n_vectors.rs"]
mod i18n_vectors;
#[path = "icons.rs"]
mod icons;
#[path = "image_embedding_lane.rs"]
mod image_embedding_lane;
#[path = "image_processing.rs"]
mod image_processing;
#[path = "import_copy.rs"]
mod import_copy;
#[path = "import_runner.rs"]
mod import_runner;
#[path = "importer_bear.rs"]
mod importer_bear;
#[path = "importer_google_keep.rs"]
mod importer_google_keep;
#[path = "importer_noteplan.rs"]
mod importer_noteplan;
#[path = "importer_raindrop.rs"]
mod importer_raindrop;
#[path = "importer_roam.rs"]
mod importer_roam;
#[path = "importer_ticktick.rs"]
mod importer_ticktick;
#[path = "importer_ticktick_dates.rs"]
mod importer_ticktick_dates;
#[path = "importer_todoist.rs"]
mod importer_todoist;
#[path = "importer_untrusted.rs"]
mod importer_untrusted;
#[path = "importer_vectors.rs"]
mod importer_vectors;
#[path = "index_tag_definitions.rs"]
mod index_tag_definitions;
#[path = "indexer_facts.rs"]
mod indexer_facts;
#[path = "indexer_open_status.rs"]
mod indexer_open_status;
#[path = "indexer_reindex_coalesce.rs"]
mod indexer_reindex_coalesce;
#[path = "indexer_scan.rs"]
mod indexer_scan;
#[path = "ios_beta_join.rs"]
mod ios_beta_join;
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
#[path = "journal_same_day.rs"]
mod journal_same_day;
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
#[path = "local_agent_server.rs"]
mod local_agent_server;
#[path = "lock_outside_edits.rs"]
mod lock_outside_edits;
#[path = "lock_service.rs"]
mod lock_service;
#[path = "lock_set.rs"]
mod lock_set;
#[path = "logship.rs"]
mod logship;
#[path = "metadata_guards.rs"]
mod metadata_guards;
#[path = "metadata_vectors.rs"]
mod metadata_vectors;
#[path = "move_dir.rs"]
mod move_dir;
#[path = "move_journal.rs"]
mod move_journal;
#[path = "note_fold_model_vectors.rs"]
mod note_fold_model_vectors;
#[path = "note_fold_queue.rs"]
mod note_fold_queue;
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
#[path = "notes_aliases_owed.rs"]
mod notes_aliases_owed;
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
#[path = "notes_import_files.rs"]
mod notes_import_files;
#[path = "notes_kept.rs"]
mod notes_kept;
#[path = "notes_link_rewrite.rs"]
mod notes_link_rewrite;
#[path = "notes_local_only.rs"]
mod notes_local_only;
#[path = "notes_mixed_order.rs"]
mod notes_mixed_order;
#[path = "notes_moves.rs"]
mod notes_moves;
#[path = "notes_moves_edges.rs"]
mod notes_moves_edges;
#[path = "notes_outside_after_reopen.rs"]
mod notes_outside_after_reopen;
#[path = "notes_outside_aliases.rs"]
mod notes_outside_aliases;
#[path = "notes_outside_tags.rs"]
mod notes_outside_tags;
#[path = "notes_plain_checklists.rs"]
mod notes_plain_checklists;
#[path = "notes_properties.rs"]
mod notes_properties;
#[path = "notes_resolve_refs.rs"]
mod notes_resolve_refs;
#[path = "notes_service.rs"]
mod notes_service;
#[path = "notes_tag_mint_lists.rs"]
mod notes_tag_mint_lists;
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
#[path = "oauth_loopback.rs"]
mod oauth_loopback;
#[path = "obsidian_task_import.rs"]
mod obsidian_task_import;
#[path = "ocr_languages.rs"]
mod ocr_languages;
#[path = "owed_take.rs"]
mod owed_take;
#[path = "path_collision.rs"]
mod path_collision;
#[path = "paths.rs"]
mod paths;
#[path = "portals.rs"]
mod portals;
#[path = "project_note_files.rs"]
mod project_note_files;
#[path = "project_writes.rs"]
mod project_writes;
#[path = "properties_file.rs"]
mod properties_file;
#[path = "property_definitions.rs"]
mod property_definitions;
#[path = "property_definitions_seed.rs"]
mod property_definitions_seed;
#[path = "property_definitions_sync.rs"]
mod property_definitions_sync;
#[path = "property_usage.rs"]
mod property_usage;
#[path = "reminder_commands.rs"]
mod reminder_commands;
#[path = "reminder_scheduler.rs"]
mod reminder_scheduler;
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
#[path = "search_reasons.rs"]
mod search_reasons;
#[path = "settings_service.rs"]
mod settings_service;
#[path = "sticky_drafts.rs"]
mod sticky_drafts;
#[path = "sync_backend.rs"]
mod sync_backend;
#[path = "sync_host_clients.rs"]
mod sync_host_clients;
#[path = "sync_pack_files.rs"]
mod sync_pack_files;
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
#[path = "task_defaults.rs"]
mod task_defaults;
#[path = "task_reopen.rs"]
mod task_reopen;
#[path = "task_writes.rs"]
mod task_writes;
#[path = "tasks_service.rs"]
mod tasks_service;
#[path = "telemetry_flush.rs"]
mod telemetry_flush;
#[path = "telemetry_report_posts.rs"]
mod telemetry_report_posts;
#[path = "templates.rs"]
mod templates;
#[path = "templates_legacy.rs"]
mod templates_legacy;
#[cfg(windows)]
#[path = "trash_held.rs"]
mod trash_held;
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
#[path = "voice_embedding_lane.rs"]
mod voice_embedding_lane;
#[path = "voice_engine.rs"]
mod voice_engine;
#[path = "voice_service.rs"]
mod voice_service;
#[path = "web_fetch.rs"]
mod web_fetch;

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
