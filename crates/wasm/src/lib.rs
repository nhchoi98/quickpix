mod utils;

use quickpix_core::{resize_rgba_u8, ResizeError, ResizeFilter};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    "0.1.0".to_string()
}

#[wasm_bindgen]
pub fn supported() -> bool {
    true
}

#[wasm_bindgen]
pub fn resize_rgba(
    src: &[u8],
    src_width: u32,
    src_height: u32,
    dst_width: u32,
    dst_height: u32,
    filter: u32,
) -> Vec<u8> {
    let filter = match filter {
        2 => ResizeFilter::Box,
        3 => ResizeFilter::Hamming,
        4 => ResizeFilter::Lanczos,
        1 => ResizeFilter::Bilinear,
        _ => ResizeFilter::Nearest,
    };

    match resize_rgba_u8(
        src,
        src_width,
        src_height,
        dst_width,
        dst_height,
        filter,
    ) {
        Ok(buf) => buf,
        Err(err) => match err {
            ResizeError::InvalidSourceSize => panic!("invalid source size"),
            ResizeError::InvalidDestinationSize => panic!("invalid destination size"),
            ResizeError::SourceBufferTooSmall => panic!("source buffer too small"),
        },
    }
}

pub use utils::to_css_filter;

#[wasm_bindgen(start)]
pub fn init() {
    utils::set_panic_hook();
}
