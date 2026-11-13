//! The built-in local agent engine (`local-openai-compatible-backend.ts` of Electron). This
//! lane holds the text tool-call splitter the capability probe needs; the engine lands with the
//! local agent lane of #3539.

pub mod splitter;
