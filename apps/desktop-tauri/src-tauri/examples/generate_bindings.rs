//! Regenerate `src/generated/bindings.ts` from Rust command signatures
//! and domain struct derives. Run via `pnpm bindings:generate`.
//!
//! Every M2/M3/M4 `#[tauri::command] #[specta::specta]` is registered
//! here through `collect_commands![]`. Every domain struct that derives
//! `specta::Type` is registered through `.typ::<...>()` so a typo or
//! missing rename_all surfaces in the generated TS file. The generator
//! is the single source of truth for the renderer-visible IPC contract.

use memry_desktop_tauri_lib::auth::{secrets as auth_secrets, types as auth_types};
use memry_desktop_tauri_lib::commands;
use memry_desktop_tauri_lib::db;
use memry_desktop_tauri_lib::error::AppError;
use specta_typescript::Typescript;
use tauri_specta::{collect_commands, Builder};

// NOTE: M3 vault commands intentionally not registered here. Their
// `NoteFrontmatter` type uses `#[serde(skip_serializing_if)]`, which
// specta's default unified mode cannot represent. The M4 plan's
// pre-flight calls out that any M3 cleanup must land in a separate
// commit before M4 starts; we keep the existing baseline (no vault
// types in bindings) and add only shell/dialog plus the new M4
// surface, leaving M3 cleanup to its own task.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let builder = Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            // Settings + lifecycle (M2)
            commands::settings::settings_get,
            commands::settings::settings_set,
            commands::settings::settings_list,
            commands::lifecycle::notify_flush_done,
            // Shell + dialog (M3, no specta issues)
            commands::shell::shell_open_url,
            commands::shell::shell_open_path,
            commands::shell::shell_reveal_in_finder,
            commands::dialog::dialog_choose_folder,
            commands::dialog::dialog_choose_files,
            // M4: auth + sync_auth + sync_setup
            commands::auth::auth_status,
            commands::auth::auth_unlock,
            commands::auth::auth_lock,
            commands::auth::auth_register_device,
            commands::auth::auth_request_otp,
            commands::auth::auth_submit_otp,
            commands::auth::auth_enable_biometric,
            commands::auth::sync_auth_request_otp,
            commands::auth::sync_auth_verify_otp,
            commands::auth::sync_auth_resend_otp,
            commands::auth::sync_auth_init_o_auth,
            commands::auth::sync_auth_refresh_token,
            commands::auth::sync_auth_logout,
            commands::auth::sync_setup_setup_first_device,
            commands::auth::sync_setup_setup_new_account,
            commands::auth::sync_setup_confirm_recovery_phrase,
            commands::auth::sync_setup_get_recovery_phrase,
            // M4: account
            commands::account::account_get_info,
            commands::account::account_sign_out,
            commands::account::account_get_recovery_key,
            // M4: devices
            commands::devices::sync_devices_get_devices,
            commands::devices::sync_devices_remove_device,
            commands::devices::sync_devices_rename_device,
            // M4: linking
            commands::linking::sync_linking_generate_linking_qr,
            commands::linking::sync_linking_link_via_qr,
            commands::linking::sync_linking_complete_linking_qr,
            commands::linking::sync_linking_link_via_recovery,
            commands::linking::sync_linking_approve_linking,
            commands::linking::sync_linking_get_linking_sas,
            // M4: crypto
            commands::crypto::crypto_encrypt_item,
            commands::crypto::crypto_decrypt_item,
            commands::crypto::crypto_verify_signature,
            commands::crypto::crypto_rotate_keys,
            commands::crypto::crypto_get_rotation_progress,
            // M4: secrets
            commands::secrets::secrets_set_provider_key,
            commands::secrets::secrets_get_provider_key_status,
            commands::secrets::secrets_delete_provider_key,
        ])
        // Errors
        .typ::<AppError>()
        // M4 auth + secrets types
        .typ::<auth_types::AuthStateKind>()
        .typ::<auth_types::AuthStatus>()
        .typ::<auth_secrets::ProviderKeyStatus>()
        // M4 command input/result structs (auth)
        .typ::<commands::auth::AuthUnlockInput>()
        .typ::<commands::auth::AuthRequestOtpInput>()
        .typ::<commands::auth::AuthSubmitOtpInput>()
        .typ::<commands::auth::AuthRegisterDeviceInput>()
        .typ::<commands::auth::BiometricStatus>()
        .typ::<commands::auth::RegisterDeviceView>()
        .typ::<commands::auth::OtpRequestView>()
        .typ::<commands::auth::OtpVerifyView>()
        .typ::<commands::auth::InitOAuthInput>()
        .typ::<commands::auth::InitOAuthView>()
        .typ::<commands::auth::RefreshTokenView>()
        .typ::<commands::auth::LogoutView>()
        .typ::<commands::auth::SetupFirstDeviceInput>()
        .typ::<commands::auth::SetupResultView>()
        .typ::<commands::auth::SetupNewAccountInput>()
        .typ::<commands::auth::ConfirmRecoveryPhraseInput>()
        .typ::<commands::auth::SimpleSuccess>()
        .typ::<commands::auth::RecoveryPhraseView>()
        // M4 account
        .typ::<commands::account::AccountInfoView>()
        .typ::<commands::account::AccountSignOutResult>()
        // M4 devices
        .typ::<commands::devices::SyncDevicesRemoveDeviceInput>()
        .typ::<commands::devices::SyncDevicesRenameDeviceInput>()
        .typ::<commands::devices::SyncDevicesGetDevicesResult>()
        .typ::<commands::devices::DeviceView>()
        .typ::<commands::devices::SyncDevicesMutationResult>()
        // M4 linking
        .typ::<commands::linking::SyncLinkingLinkViaQrInput>()
        .typ::<commands::linking::SyncLinkingCompleteLinkingQrInput>()
        .typ::<commands::linking::SyncLinkingLinkViaRecoveryInput>()
        .typ::<commands::linking::SyncLinkingApproveLinkingInput>()
        .typ::<commands::linking::SyncLinkingGetLinkingSasInput>()
        .typ::<commands::linking::LinkingQrView>()
        .typ::<commands::linking::LinkingScanView>()
        .typ::<commands::linking::LinkingCompleteView>()
        .typ::<commands::linking::LinkingMutationResult>()
        .typ::<commands::linking::LinkingSasView>()
        // M4 crypto
        .typ::<commands::crypto::CryptoEncryptItemInput>()
        .typ::<commands::crypto::CryptoEncryptItemResult>()
        .typ::<commands::crypto::CryptoDecryptItemInput>()
        .typ::<commands::crypto::CryptoDecryptItemResult>()
        .typ::<commands::crypto::CryptoVerifySignatureInput>()
        .typ::<commands::crypto::CryptoVerifySignatureResult>()
        .typ::<commands::crypto::CryptoRotateKeysResult>()
        .typ::<commands::crypto::CryptoRotationProgress>()
        // M4 secrets
        .typ::<commands::secrets::SecretsSetProviderKeyInput>()
        .typ::<commands::secrets::SecretsGetProviderKeyStatusInput>()
        .typ::<commands::secrets::SecretsDeleteProviderKeyInput>()
        // Domain DB structs (registered for stable export across migrations)
        .typ::<db::bookmarks::Bookmark>()
        .typ::<db::calendar_bindings::CalendarBinding>()
        .typ::<db::calendar_events::CalendarEvent>()
        .typ::<db::calendar_external_events::CalendarExternalEvent>()
        .typ::<db::calendar_sources::CalendarSource>()
        .typ::<db::folder_configs::FolderConfig>()
        .typ::<db::inbox::InboxItem>()
        .typ::<db::note_metadata::NoteMetadata>()
        .typ::<db::note_positions::NotePosition>()
        .typ::<db::notes_cache::PropertyDefinition>()
        .typ::<db::projects::Project>()
        .typ::<db::reminders::Reminder>()
        .typ::<db::saved_filters::SavedFilter>()
        .typ::<db::search_reasons::SearchReason>()
        .typ::<db::settings::Setting>()
        .typ::<db::statuses::Status>()
        .typ::<db::sync_devices::SyncDevice>()
        .typ::<db::sync_history::SyncHistoryEntry>()
        .typ::<db::sync_queue::SyncQueueItem>()
        .typ::<db::sync_state::SyncState>()
        .typ::<db::tag_definitions::TagDefinition>()
        .typ::<db::tasks::Task>();

    builder.export(Typescript::default(), "../src/generated/bindings.ts")?;

    Ok(())
}
