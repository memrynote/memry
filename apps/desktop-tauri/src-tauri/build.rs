fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "crdt_open_doc",
                "crdt_close_doc",
                "crdt_apply_update",
                "crdt_apply_update_chunk_start",
                "crdt_apply_update_chunk_append",
                "crdt_apply_update_chunk_finish",
                "crdt_get_snapshot",
                "crdt_get_state_vector",
                "crdt_sync_step_1",
                "crdt_sync_step_2",
                "crdt_get_or_init_doc",
            ]),
        ),
    )
    .expect("failed to run tauri build script")
}
