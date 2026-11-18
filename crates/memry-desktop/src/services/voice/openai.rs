//! The OpenAI engine of voice transcription (`transcription.ts` `transcribeAudioData` with the
//! `openai` provider): one multipart POST to the audio transcriptions endpoint, `response_format`
//! `text`, through the shared HTTP client. Failures are the user-facing strings of Electron's
//! `normalizeTranscriptionError`.

use std::time::Duration;

/// The model is `whisper-1` unless this launch variable names another (`env-config.ts:41`).
pub const MODEL_VAR: &str = "OPENAI_WHISPER_MODEL";
pub const ENDPOINT: &str = "https://api.openai.com/v1/audio/transcriptions";
/// The API's upload limit (`MAX_FILE_SIZE`), checked before anything is sent.
pub const MAX_BYTES: usize = 25 * 1024 * 1024;
/// `SUPPORTED_FORMATS`.
const FORMATS: [&str; 7] = ["mp3", "mp4", "mpeg", "mpga", "m4a", "wav", "webm"];
/// The OpenAI SDK's default request timeout, which Electron uses.
const TIMEOUT: Duration = Duration::from_secs(10 * 60);

pub const RATE_LIMITED: &str = "Rate limit exceeded. Please try again later.";
pub const INVALID_KEY: &str = "Invalid OpenAI API key. Please check your settings.";
pub const NO_QUOTA: &str = "OpenAI quota exceeded. Please check your billing.";

pub struct OpenAi {
    client: reqwest::Client,
    endpoint: String,
    model: String,
}

impl OpenAi {
    /// `model` is the [`MODEL_VAR`] value; blank or absent means `whisper-1`.
    pub fn new(client: reqwest::Client, endpoint: impl Into<String>, model: Option<&str>) -> Self {
        Self {
            client,
            endpoint: endpoint.into(),
            model: model
                .filter(|model| !model.is_empty())
                .unwrap_or("whisper-1")
                .to_owned(),
        }
    }

    /// The format and size checks Electron runs before it reads the key.
    pub fn check(ext: &str, len: usize) -> Result<(), String> {
        if !FORMATS.contains(&ext) {
            return Err(format!(
                "Unsupported audio format: {ext}. Supported: {}",
                FORMATS.join(", ")
            ));
        }
        if len > MAX_BYTES {
            let mb = (len as f64 / 1024.0 / 1024.0).round();
            return Err(format!(
                "Audio file too large: {mb}MB. Maximum size is 25MB."
            ));
        }
        Ok(())
    }

    /// The text OpenAI hears in `audio` (an `.ext` file that passed [`Self::check`]). `language`
    /// is sent only when set, so OpenAI detects it otherwise.
    pub async fn transcribe(
        &self,
        key: &str,
        audio: &[u8],
        ext: &str,
        language: Option<&str>,
    ) -> Result<String, String> {
        let boundary = format!("memry-{}", uuid::Uuid::new_v4().simple());
        let mut fields = vec![("model", self.model.as_str()), ("response_format", "text")];
        if let Some(language) = language {
            fields.push(("language", language));
        }
        let response = self
            .client
            .post(&self.endpoint)
            .bearer_auth(key)
            .timeout(TIMEOUT)
            .header(
                reqwest::header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(multipart(&boundary, &fields, audio, ext))
            .send()
            .await
            .map_err(|error| {
                tracing::warn!(scope = "Voice", "the OpenAI request failed: {error}");
                "Connection error.".to_owned()
            })?;
        let status = response.status();
        let body = response.text().await.map_err(|error| error.to_string())?;
        if status.is_success() {
            return Ok(body);
        }
        Err(api_error(status.as_u16(), &body))
    }
}

/// The request body: the text fields, then the file as `audio.<ext>`.
fn multipart(boundary: &str, fields: &[(&str, &str)], audio: &[u8], ext: &str) -> Vec<u8> {
    let mut body = Vec::with_capacity(audio.len() + 512);
    for (name, value) in fields {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; \
             filename=\"audio.{ext}\"\r\nContent-Type: audio/{ext}\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(audio);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

/// `normalizeTranscriptionError` over the API's error body (`{"error":{"message","code"}}`): an
/// exhausted quota (which OpenAI answers with a 429 too), then a rate limit, then a bad key;
/// anything else is the SDK's `<status> <message>`.
fn api_error(status: u16, body: &str) -> String {
    let error = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("error").cloned());
    let field = |name: &str| {
        error
            .as_ref()
            .and_then(|error| error.get(name))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    let (code, message) = (field("code"), field("message"));
    if code == "insufficient_quota" {
        NO_QUOTA.to_owned()
    } else if status == 429 || code.starts_with("rate_limit") {
        RATE_LIMITED.to_owned()
    } else if status == 401 || code == "invalid_api_key" {
        INVALID_KEY.to_owned()
    } else if message.is_empty() {
        format!("{status} status code (no body)")
    } else {
        format!("{status} {message}")
    }
}
