//! The network seam of extraction. The six async Defuddle extractors (reddit, c2-wiki,
//! x-oembed, bilibili, youtube) call `this.fetch` in `dist/extractors/_base.js`; this trait is
//! that call. Step 27 (#3544) supplies the production implementation, tests a replay.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchRequest {
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchResponse {
    pub status: u16,
    pub ok: bool,
    pub text: String,
}

/// A fetch error is caught where Defuddle catches it and extraction continues.
pub trait Fetcher {
    fn fetch(&self, request: FetchRequest) -> Result<FetchResponse, String>;
}
