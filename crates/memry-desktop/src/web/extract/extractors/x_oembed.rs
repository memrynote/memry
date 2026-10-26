//! STUB
use super::base::{Cx, Extracted, Extractor};
use crate::web::extract::error::ExtractError;
pub struct XOembedExtractor;
impl XOembedExtractor {
    pub fn new(_cx: &mut Cx) -> Result<Self, ExtractError> {
        Ok(Self)
    }
}
impl Extractor for XOembedExtractor {
    fn can_extract(&mut self, _cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(false)
    }
    fn extract(&mut self, _cx: &mut Cx) -> Result<Extracted, ExtractError> {
        Ok(Extracted::default())
    }
}
