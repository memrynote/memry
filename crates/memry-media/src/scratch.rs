//! The buffers a WebP or GIF decoder allocates beside the frame it writes, read from the container
//! before decoding, as `check_png_profile` reads a PNG. Neither decoder checks them against the
//! sum `read_frame` holds to: `image`'s WebP codec keeps the default `set_limits`, and its GIF
//! codec checks the frame buffer against `Limits::max_alloc` alone (image 0.25.10,
//! `codecs/gif.rs:174`). Line numbers below are image-webp 0.2.4, image 0.25.10 and gif 0.14.2.

use image::ImageFormat;

use crate::{DecodeError, input};

/// The most bytes the decoder of `format` holds at once beside its `width` by `height` output.
pub(crate) fn decoder_scratch(format: ImageFormat, bytes: &[u8], width: u32, height: u32) -> u64 {
    match format {
        ImageFormat::WebP => webp(bytes, width, height),
        ImageFormat::Gif => gif(bytes),
        _ => 0,
    }
}

/// image-webp's `WebPDecoder::read_image` (`decoder.rs:669`):
/// - Animated (VP8X flag `0x02`): the first frame as RGBA, at most the canvas size
///   (`decoder.rs:816`, `:840`), beside an RGBA canvas (`:870`), 8 bytes a canvas pixel. The
///   frame's own decode, at most its VP8 planes, alpha plane and RGBA buffer, stays below that.
/// - Lossless (VP8L): `lossless_scratch`, and without alpha an RGBA frame it then copies to RGB
///   (`decoder.rs:687`).
/// - Lossy (VP8): `vp8_planes`, held while the alpha plane is read (`decoder.rs:699-712`).
fn webp(bytes: &[u8], width: u32, height: u32) -> u64 {
    let pixels = u64::from(width) * u64::from(height);
    let mut chunks = riff_chunks(bytes);
    match chunks.next().map(|chunk| (chunk.fourcc, chunk.data)) {
        Some((b"VP8 ", _)) => vp8_planes(width, height),
        Some((b"VP8L", data)) => {
            // The bit after the 14-bit width and height (`decoder.rs:426`).
            let alpha = data.get(1..5).is_some_and(|header| header[3] & 0x10 != 0);
            lossless_scratch(width, height) + if alpha { 0 } else { pixels * 4 }
        }
        Some((b"VP8X", data)) => {
            let flags = data.first().copied().unwrap_or(0);
            if flags & 0x02 != 0 {
                return pixels * 8;
            }
            let alpha = flags & 0x10 != 0;
            // The decoder keeps the first chunk of each kind and prefers VP8L (`decoder.rs:444`,
            // `:681`).
            let chunks: Vec<_> = chunks.collect();
            let first = |kind: &[u8; 4]| chunks.iter().find(|chunk| chunk.fourcc == kind);
            if first(b"VP8L").is_some() {
                lossless_scratch(width, height) + if alpha { 0 } else { pixels * 4 }
            } else if alpha {
                // `read_alpha_chunk` (`extended.rs:272`): an uncompressed plane, or a lossless one
                // decoded to RGBA beside its green copy. Without an ALPH chunk the decode fails
                // after the planes; count the lossless one.
                let raw = first(b"ALPH")
                    .is_some_and(|chunk| chunk.data.first().is_some_and(|info| info & 0x03 == 0));
                let alpha = if raw {
                    pixels
                } else {
                    pixels * 5 + lossless_scratch(width, height)
                };
                vp8_planes(width, height) + alpha
            } else {
                vp8_planes(width, height)
            }
        }
        _ => 0,
    }
}

/// A VP8 frame's Y, U and V planes, padded to whole 16-pixel macroblocks (`vp8.rs:1200-1205`).
fn vp8_planes(width: u32, height: u32) -> u64 {
    let padded = |side: u32| u64::from(side.div_ceil(16) * 16);
    padded(width) * padded(height) * 3 / 2
}

/// A VP8L image's sub-images at their smallest block of 4 by 4 pixels, 4 bytes each: the predictor
/// and colour transforms' (`lossless.rs:221`, `:238`), and the entropy image (`:313`) beside the
/// 2-byte group indices made from it (`:316`). The Huffman tables are bounded by image-webp's
/// memory limit instead (`webp`).
fn lossless_scratch(width: u32, height: u32) -> u64 {
    let blocks = u64::from(width.div_ceil(4)) * u64::from(height.div_ceil(4));
    blocks * (4 + 4 + 4 + 2)
}

/// Refuses a WebP container whose buffers the decoder would size from something `webp` does not
/// read. `image-webp` builds its chunk table at `WebPDecoder::new` (`decoder.rs:366-560`): the
/// first chunk of each kind, then the first ANMF chunk's first two subchunks with no check that
/// the image is animated (`:519-531`). It then:
/// - allocates EXIF and ICCP at their declared size, unclamped to the file and with no memory
///   limit, when `read_frame` asks for them (`:440`, `:634`): up to 4 GiB from a few bytes;
/// - decodes a still image from a VP8L chunk inside an ANMF chunk (`:681`), counted by `webp` as
///   the top-level VP8 beside it;
/// - allocates a VP8 frame's planes from its own header (`vp8.rs:1187-1205`) before comparing it
///   with the canvas or the animation frame (`decoder.rs:699`, `:807`).
///
/// Each refused file is one the decoder fails on or the WebP container spec forbids, so no image
/// that decodes is lost, except one whose chunk after the image data is cut short.
pub(crate) fn check_webp(bytes: &[u8]) -> Result<(), DecodeError> {
    let chunks: Vec<_> = riff_chunks(bytes).collect();
    let anmf = chunks.iter().find(|chunk| chunk.fourcc == b"ANMF");
    let frame: Vec<_> = anmf
        .map(|anmf| chunks_at(bytes, anmf.start + 16).take(2).collect())
        .unwrap_or_default();
    if let Some(cut) = chunks
        .iter()
        .chain(&frame)
        .find(|chunk| chunk.data.len() < chunk.size)
    {
        return Err(input(format!(
            "WebP {} chunk runs past the end of the file",
            String::from_utf8_lossy(cut.fourcc)
        )));
    }
    let Some(vp8x) = chunks.first().filter(|chunk| chunk.fourcc == b"VP8X") else {
        return Ok(());
    };
    let animated = vp8x.data.first().is_some_and(|flags| flags & 0x02 != 0);
    let (size, vp8) = if animated {
        // The ANMF header: x, y, width - 1, height - 1, three bytes each. The VP8 data follows an
        // ALPH chunk, whatever its fourcc (`decoder.rs:779-787`).
        let Some(anmf) = anmf else {
            return Ok(());
        };
        let size = (three_bytes(anmf.data, 6), three_bytes(anmf.data, 9));
        let vp8 = match frame.as_slice() {
            [first, ..] if first.fourcc == b"VP8 " => Some(first),
            [first, next] if first.fourcc == b"ALPH" => Some(next),
            _ => None,
        };
        (size, vp8)
    } else {
        if anmf.is_some() {
            return Err(input("a still WebP holds an animation frame"));
        }
        let size = (three_bytes(vp8x.data, 4), three_bytes(vp8x.data, 7));
        (size, chunks.iter().find(|chunk| chunk.fourcc == b"VP8 "))
    };
    if let Some(vp8) = vp8.and_then(|chunk| vp8_size(chunk.data))
        && Some(vp8) != size.0.zip(size.1)
    {
        return Err(input("WebP VP8 frame size does not match its image"));
    }
    Ok(())
}

/// A 24-bit little-endian field plus one, as VP8X and ANMF store a size.
fn three_bytes(data: &[u8], at: usize) -> Option<u32> {
    let field = data.get(at..at + 3)?;
    Some(u32::from_le_bytes([field[0], field[1], field[2], 0]) + 1)
}

/// The width and height of a VP8 key frame's header (`vp8.rs:1187-1191`).
fn vp8_size(data: &[u8]) -> Option<(u32, u32)> {
    let field = |at: usize| {
        data.get(at..at + 2)
            .map(|b| u32::from(u16::from_le_bytes([b[0], b[1]]) & 0x3FFF))
    };
    Some((field(6)?, field(8)?))
}

struct Chunk<'a> {
    fourcc: &'a [u8; 4],
    /// Where the data starts in the file.
    start: usize,
    /// The declared data size.
    size: usize,
    /// The data, cut at the end of the file.
    data: &'a [u8],
}

/// The chunks after a RIFF header.
fn riff_chunks(bytes: &[u8]) -> impl Iterator<Item = Chunk<'_>> {
    chunks_at(bytes, 12)
}

/// The chunks from `at` to the end of the file.
fn chunks_at(bytes: &[u8], mut at: usize) -> impl Iterator<Item = Chunk<'_>> {
    std::iter::from_fn(move || {
        let header = bytes.get(at..at.checked_add(8)?)?;
        let fourcc: &[u8; 4] = header[..4].try_into().ok()?;
        let size = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
        let start = at + 8;
        let data = &bytes[start..start.saturating_add(size).min(bytes.len())];
        at = start.saturating_add(size).saturating_add(size & 1);
        Some(Chunk {
            fourcc,
            start,
            size,
            data,
        })
    })
}

/// image's `GifDecoder::read_image` (`codecs/gif.rs:113`) on the first frame: its palette indices,
/// whole unless interlaced, when one row at a time (`converter.rs:119`, `:195-219`); and unless the
/// frame starts at the screen's left edge, spans its width and ends above its bottom, an RGBA
/// frame buffer (`codecs/gif.rs:175`).
fn gif(bytes: &[u8]) -> u64 {
    let Some(frame) = gif_first_frame(bytes) else {
        return 0;
    };
    let (width, height) = (u64::from(frame.width), u64::from(frame.height));
    let indices = if frame.interlaced {
        width
    } else {
        width * height
    };
    let fills_rows = frame.left == 0
        && frame.width == frame.screen_width
        && u32::from(frame.top) + u32::from(frame.height) <= u32::from(frame.screen_height);
    indices + if fills_rows { 0 } else { width * height * 4 }
}

struct GifFrame {
    screen_width: u16,
    screen_height: u16,
    left: u16,
    top: u16,
    width: u16,
    height: u16,
    interlaced: bool,
}

/// The first image descriptor, past the screen descriptor, the global palette and any
/// extensions, as gif's decoder walks them (`reader/decoder.rs:606-700`).
fn gif_first_frame(bytes: &[u8]) -> Option<GifFrame> {
    let u16_at = |at: usize| {
        bytes
            .get(at..at + 2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
    };
    let flags = *bytes.get(10)?;
    let palette = if flags & 0x80 != 0 {
        3 << ((flags & 0x07) + 1)
    } else {
        0
    };
    let mut at = 13 + palette;
    loop {
        match *bytes.get(at)? {
            0x21 => {
                // Introducer, label, then sub-blocks until an empty one.
                at += 2;
                loop {
                    let length = usize::from(*bytes.get(at)?);
                    at += 1 + length;
                    if length == 0 {
                        break;
                    }
                }
            }
            0x2C => {
                return Some(GifFrame {
                    screen_width: u16_at(6)?,
                    screen_height: u16_at(8)?,
                    left: u16_at(at + 1)?,
                    top: u16_at(at + 3)?,
                    width: u16_at(at + 5)?,
                    height: u16_at(at + 7)?,
                    interlaced: bytes.get(at + 9)? & 0x40 != 0,
                });
            }
            _ => return None,
        }
    }
}
