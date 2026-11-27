//! The voice commands and event.

macro_rules! voice {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::voice::inbox_retry_transcription,
            crate::commands::voice::settings_download_voice_model,
            crate::commands::voice::settings_get_voice_model_status,
            crate::commands::voice::settings_get_voice_recording_readiness,
            crate::commands::voice::settings_get_voice_transcription_openai_key_status,
            crate::commands::voice::settings_open_os_microphone_settings,
            crate::commands::voice::settings_set_voice_transcription_openai_key,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::VoiceModelProgressEvent,
        ] $($chain)*)
    };
}
