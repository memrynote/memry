//! In-memory store of open Y.Docs keyed by note id.

use std::collections::HashMap;
use tokio::sync::Mutex;

pub struct DocStore {
    docs: Mutex<HashMap<String, yrs::Doc>>,
}

impl DocStore {
    pub fn new() -> Self {
        Self {
            docs: Mutex::new(HashMap::new()),
        }
    }

    pub async fn open_count(&self) -> usize {
        self.docs.lock().await.len()
    }
}
