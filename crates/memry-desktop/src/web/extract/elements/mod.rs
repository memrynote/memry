//! The element handlers of Defuddle (`dist/elements/*.js`), ported across Step 26 (#3543). The
//! removal stage needs two helpers of `images` and `math`; stage 2c brings `headings` and
//! `callouts`; the remaining handlers arrive with their corpus pages.

pub mod callouts;
pub mod headings;
pub mod images;
pub mod math;
