//! Core image resizing algorithms shared with WASM and JS wrappers.

use std::f32::consts::PI;

#[cfg(target_arch = "wasm32")]
use core::arch::wasm32::*;

#[derive(Debug, Clone, Copy)]
pub enum ResizeFilter {
    Nearest = 0,
    Bilinear = 1,
    Box = 2,
    Hamming = 3,
    Lanczos = 4,
}

#[derive(Debug)]
pub enum ResizeError {
    InvalidSourceSize,
    InvalidDestinationSize,
    SourceBufferTooSmall,
}

impl core::fmt::Display for ResizeError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            ResizeError::InvalidSourceSize => write!(f, "invalid source dimensions"),
            ResizeError::InvalidDestinationSize => write!(f, "invalid destination dimensions"),
            ResizeError::SourceBufferTooSmall => write!(f, "source buffer too small"),
        }
    }
}

impl std::error::Error for ResizeError {}

fn u32_to_usize(v: u32) -> Result<usize, ResizeError> {
    v.try_into().map_err(|_| ResizeError::InvalidSourceSize)
}

fn pixel_count(width: u32, height: u32) -> Result<usize, ResizeError> {
    let pixels = width
        .checked_mul(height)
        .ok_or(ResizeError::InvalidSourceSize)?;
    let bytes = pixels.checked_mul(4).ok_or(ResizeError::InvalidSourceSize)?;
    u32_to_usize(bytes)
}

#[inline(always)]
fn round_to_u8(v: f32) -> u8 {
    let i = (v + 0.5) as i32;
    if i <= 0 { 0 } else if i >= 255 { 255 } else { i as u8 }
}

#[inline(always)]
fn sinc(v: f32) -> f32 {
    if v == 0.0 {
        1.0
    } else {
        let pv = PI * v;
        pv.sin() / pv
    }
}

// ---------------------------------------------------------------------------
// Compile-time filter dispatch via trait monomorphization (Phase 3-3)
// ---------------------------------------------------------------------------

trait ConvFilter {
    fn kernel(distance: f32) -> f32;
    fn support() -> f32;
}

struct BilinearFilter;
impl ConvFilter for BilinearFilter {
    #[inline(always)]
    fn kernel(distance: f32) -> f32 {
        let x = distance.abs();
        if x >= 1.0 { 0.0 } else { 1.0 - x }
    }
    #[inline(always)]
    fn support() -> f32 { 1.0 }
}

struct BoxFilter;
impl ConvFilter for BoxFilter {
    #[inline(always)]
    fn kernel(distance: f32) -> f32 {
        if distance.abs() <= 0.5 { 1.0 } else { 0.0 }
    }
    #[inline(always)]
    fn support() -> f32 { 0.5 }
}

struct HammingFilter;
impl ConvFilter for HammingFilter {
    #[inline(always)]
    fn kernel(distance: f32) -> f32 {
        let x = distance.abs();
        if x >= 2.0 { return 0.0; }
        sinc(distance) * (0.54 + 0.46 * ((PI * distance) * 0.5).cos())
    }
    #[inline(always)]
    fn support() -> f32 { 2.0 }
}

struct LanczosFilter;
impl ConvFilter for LanczosFilter {
    #[inline(always)]
    fn kernel(distance: f32) -> f32 {
        let x = distance.abs();
        if x >= 3.0 { return 0.0; }
        sinc(distance) * sinc(distance * (1.0 / 3.0))
    }
    #[inline(always)]
    fn support() -> f32 { 3.0 }
}

// ---------------------------------------------------------------------------
// Flat kernel storage — single contiguous allocation per axis (Phase 3-2)
// ---------------------------------------------------------------------------

struct KernelEntry {
    start: u32,
    offset: u32,
    len: u16,
}

struct AxisKernels {
    entries: Vec<KernelEntry>,
    weights: Vec<f32>,
}

fn compute_axis_kernels<F: ConvFilter>(src_len: u32, dst_len: u32) -> AxisKernels {
    let src_f = src_len as f32;
    let dst_f = dst_len as f32;
    let scale = (src_f / dst_f).max(1.0);
    let inv_scale = 1.0 / scale;
    let support = F::support() * scale;
    let max_kernel_size = ((support * 2.0).ceil() as usize) + 2;

    let mut entries = Vec::with_capacity(dst_len as usize);
    let mut all_weights = Vec::with_capacity(dst_len as usize * max_kernel_size);

    for i in 0..dst_len {
        let center = ((i as f32) + 0.5) * src_f / dst_f - 0.5;
        let start = (center - support).floor().max(0.0) as usize;
        let end = (center + support).ceil().min((src_len - 1) as f32) as usize;
        let len = end - start + 1;
        let weight_offset = all_weights.len();

        let mut sum: f32 = 0.0;
        for j in start..=end {
            let w = F::kernel((center - j as f32) * inv_scale);
            all_weights.push(w);
            sum += w;
        }

        if sum > 0.0 {
            let inv_sum = 1.0 / sum;
            for w in all_weights[weight_offset..].iter_mut() {
                *w *= inv_sum;
            }
            entries.push(KernelEntry {
                start: start as u32,
                offset: weight_offset as u32,
                len: len as u16,
            });
        } else {
            // Discard any weights we pushed, replace with single nearest
            all_weights.truncate(weight_offset);
            let nearest = center.round().clamp(0.0, (src_len - 1) as f32) as u32;
            all_weights.push(1.0);
            entries.push(KernelEntry {
                start: nearest,
                offset: weight_offset as u32,
                len: 1,
            });
        }
    }

    AxisKernels { entries, weights: all_weights }
}

// ---------------------------------------------------------------------------
// Horizontal pass
// ---------------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
fn horizontal_pass(
    src: &[u8],
    tmp: &mut [f32],
    src_width: usize,
    src_height: usize,
    dst_width: usize,
    x_kernels: &AxisKernels,
) {
    let tmp_stride = dst_width * 4;
    for sy in 0..src_height {
        let src_row = sy * src_width * 4;
        let tmp_row = sy * tmp_stride;

        for (dx, ke) in x_kernels.entries.iter().enumerate() {
            let ti = tmp_row + dx * 4;
            let woff = ke.offset as usize;
            let wlen = ke.len as usize;
            let kstart = ke.start as usize;

            unsafe {
                let mut acc = f32x4_splat(0.0);
                for j in 0..wlen {
                    let w = *x_kernels.weights.get_unchecked(woff + j);
                    let si = src_row + (kstart + j) * 4;
                    let pixel = f32x4(
                        *src.get_unchecked(si) as f32,
                        *src.get_unchecked(si + 1) as f32,
                        *src.get_unchecked(si + 2) as f32,
                        *src.get_unchecked(si + 3) as f32,
                    );
                    acc = f32x4_add(acc, f32x4_mul(pixel, f32x4_splat(w)));
                }
                v128_store(tmp.as_mut_ptr().add(ti) as *mut v128, acc);
            }
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn horizontal_pass(
    src: &[u8],
    tmp: &mut [f32],
    src_width: usize,
    src_height: usize,
    dst_width: usize,
    x_kernels: &AxisKernels,
) {
    let tmp_stride = dst_width * 4;
    for sy in 0..src_height {
        let src_row = sy * src_width * 4;
        let tmp_row = sy * tmp_stride;

        for (dx, ke) in x_kernels.entries.iter().enumerate() {
            let ti = tmp_row + dx * 4;
            let woff = ke.offset as usize;
            let wlen = ke.len as usize;
            let kstart = ke.start as usize;

            let mut r: f32 = 0.0;
            let mut g: f32 = 0.0;
            let mut b: f32 = 0.0;
            let mut a: f32 = 0.0;

            for j in 0..wlen {
                let w = x_kernels.weights[woff + j];
                let si = src_row + (kstart + j) * 4;
                r += src[si] as f32 * w;
                g += src[si + 1] as f32 * w;
                b += src[si + 2] as f32 * w;
                a += src[si + 3] as f32 * w;
            }

            tmp[ti] = r;
            tmp[ti + 1] = g;
            tmp[ti + 2] = b;
            tmp[ti + 3] = a;
        }
    }
}

// ---------------------------------------------------------------------------
// Vertical pass
// ---------------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
fn vertical_pass(
    tmp: &[f32],
    dst: &mut [u8],
    dst_width: usize,
    tmp_stride: usize,
    y_kernels: &AxisKernels,
) {
    for (dy, ke) in y_kernels.entries.iter().enumerate() {
        let dst_row = dy * dst_width * 4;
        let woff = ke.offset as usize;
        let wlen = ke.len as usize;
        let kstart = ke.start as usize;

        for dx in 0..dst_width {
            unsafe {
                let mut acc = f32x4_splat(0.0);
                for j in 0..wlen {
                    let w = *y_kernels.weights.get_unchecked(woff + j);
                    let ti = (kstart + j) * tmp_stride + dx * 4;
                    let pixel = v128_load(tmp.as_ptr().add(ti) as *const v128);
                    acc = f32x4_add(acc, f32x4_mul(pixel, f32x4_splat(w)));
                }

                // Clamp to [0, 255] and round
                let clamped = f32x4_max(
                    f32x4_splat(0.0),
                    f32x4_min(f32x4_splat(255.0), acc),
                );
                let rounded = f32x4_add(clamped, f32x4_splat(0.5));
                let int_vals = i32x4_trunc_sat_f32x4(rounded);

                let di = dst_row + dx * 4;
                *dst.get_unchecked_mut(di) = i32x4_extract_lane::<0>(int_vals) as u8;
                *dst.get_unchecked_mut(di + 1) = i32x4_extract_lane::<1>(int_vals) as u8;
                *dst.get_unchecked_mut(di + 2) = i32x4_extract_lane::<2>(int_vals) as u8;
                *dst.get_unchecked_mut(di + 3) = i32x4_extract_lane::<3>(int_vals) as u8;
            }
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn vertical_pass(
    tmp: &[f32],
    dst: &mut [u8],
    dst_width: usize,
    tmp_stride: usize,
    y_kernels: &AxisKernels,
) {
    for (dy, ke) in y_kernels.entries.iter().enumerate() {
        let dst_row = dy * dst_width * 4;
        let woff = ke.offset as usize;
        let wlen = ke.len as usize;
        let kstart = ke.start as usize;

        for dx in 0..dst_width {
            let mut r: f32 = 0.0;
            let mut g: f32 = 0.0;
            let mut b: f32 = 0.0;
            let mut a: f32 = 0.0;

            for j in 0..wlen {
                let w = y_kernels.weights[woff + j];
                let ti = (kstart + j) * tmp_stride + dx * 4;
                r += tmp[ti] * w;
                g += tmp[ti + 1] * w;
                b += tmp[ti + 2] * w;
                a += tmp[ti + 3] * w;
            }

            let di = dst_row + dx * 4;
            dst[di] = round_to_u8(r);
            dst[di + 1] = round_to_u8(g);
            dst[di + 2] = round_to_u8(b);
            dst[di + 3] = round_to_u8(a);
        }
    }
}

// ---------------------------------------------------------------------------
// Main convolution entry — dispatches to monomorphized kernel computation
// ---------------------------------------------------------------------------

fn resize_convolution_u8(
    src: &[u8],
    src_width: u32,
    src_height: u32,
    dst_width: u32,
    dst_height: u32,
    filter: ResizeFilter,
    dst: &mut [u8],
) {
    let src_w = src_width as usize;
    let src_h = src_height as usize;
    let dst_w = dst_width as usize;
    let tmp_stride = dst_w * 4;

    // Monomorphized kernel computation — compiler inlines each filter's kernel()
    let (x_kernels, y_kernels) = match filter {
        ResizeFilter::Bilinear => (
            compute_axis_kernels::<BilinearFilter>(src_width, dst_width),
            compute_axis_kernels::<BilinearFilter>(src_height, dst_height),
        ),
        ResizeFilter::Box => (
            compute_axis_kernels::<BoxFilter>(src_width, dst_width),
            compute_axis_kernels::<BoxFilter>(src_height, dst_height),
        ),
        ResizeFilter::Hamming => (
            compute_axis_kernels::<HammingFilter>(src_width, dst_width),
            compute_axis_kernels::<HammingFilter>(src_height, dst_height),
        ),
        ResizeFilter::Lanczos => (
            compute_axis_kernels::<LanczosFilter>(src_width, dst_width),
            compute_axis_kernels::<LanczosFilter>(src_height, dst_height),
        ),
        _ => unreachable!(),
    };

    let mut tmp = vec![0.0f32; src_h * tmp_stride];

    horizontal_pass(src, &mut tmp, src_w, src_h, dst_w, &x_kernels);
    vertical_pass(&tmp, dst, dst_w, tmp_stride, &y_kernels);
}

/// Resize one RGBA image buffer with nearest neighbor, bilinear, box, hamming, or lanczos sampling.
pub fn resize_rgba_u8(
    src: &[u8],
    src_width: u32,
    src_height: u32,
    dst_width: u32,
    dst_height: u32,
    filter: ResizeFilter,
) -> Result<Vec<u8>, ResizeError> {
    if src_width == 0 || src_height == 0 {
        return Err(ResizeError::InvalidSourceSize);
    }
    if dst_width == 0 || dst_height == 0 {
        return Err(ResizeError::InvalidDestinationSize);
    }

    let src_stride = pixel_count(src_width, src_height)?;
    if src.len() < src_stride {
        return Err(ResizeError::SourceBufferTooSmall);
    }

    let dst_stride = pixel_count(dst_width, dst_height)?;
    let mut dst = vec![0u8; dst_stride];

    match filter {
        ResizeFilter::Nearest => {
            let src_w_f = src_width as f32;
            let src_h_f = src_height as f32;
            let dst_w_f = dst_width as f32;
            let dst_h_f = dst_height as f32;
            for y in 0..dst_height {
                let sy = (((y as f32 + 0.5) * src_h_f / dst_h_f) - 0.5).round() as i32;
                let sy = sy.clamp(0, (src_height - 1) as i32) as u32;
                for x in 0..dst_width {
                    let sx = (((x as f32 + 0.5) * src_w_f / dst_w_f) - 0.5).round() as i32;
                    let sx = sx.clamp(0, (src_width - 1) as i32) as u32;
                    let src_idx = ((sy * src_width + sx) * 4) as usize;
                    let dst_idx = ((y * dst_width + x) * 4) as usize;
                    dst[dst_idx..dst_idx + 4].copy_from_slice(&src[src_idx..src_idx + 4]);
                }
            }
        }

        ResizeFilter::Bilinear | ResizeFilter::Box | ResizeFilter::Hamming | ResizeFilter::Lanczos => {
            resize_convolution_u8(src, src_width, src_height, dst_width, dst_height, filter, &mut dst);
        }
    }

    Ok(dst)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_one_to_one_keeps_pixels() {
        let src = vec![
            1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255,
        ];
        let out = resize_rgba_u8(&src, 2, 2, 2, 2, ResizeFilter::Nearest).unwrap();
        assert_eq!(out, src);
    }

    #[test]
    fn bilinear_half_scale_down() {
        let src = vec![
            255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
        ];
        let out = resize_rgba_u8(&src, 2, 2, 1, 1, ResizeFilter::Bilinear).unwrap();
        assert_eq!(out.len(), 4);
    }

    #[test]
    fn box_filter_runs_without_crash() {
        let src = vec![
            255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
        ];
        let out = resize_rgba_u8(&src, 2, 2, 3, 3, ResizeFilter::Box).unwrap();
        assert_eq!(out.len(), 36);
    }

    #[test]
    fn hamming_filter_runs_without_crash() {
        let src = vec![
            255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
        ];
        let out = resize_rgba_u8(&src, 2, 2, 3, 3, ResizeFilter::Hamming).unwrap();
        assert_eq!(out.len(), 36);
    }

    #[test]
    fn lanczos_filter_runs_without_crash() {
        let src = vec![
            255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
        ];
        let out = resize_rgba_u8(&src, 2, 2, 3, 3, ResizeFilter::Lanczos).unwrap();
        assert_eq!(out.len(), 36);
    }

    #[test]
    fn invalid_zero_dimension_rejected() {
        let src = vec![0u8; 16];
        let err = resize_rgba_u8(&src, 2, 0, 1, 1, ResizeFilter::Nearest);
        assert!(matches!(err, Err(ResizeError::InvalidSourceSize)));
    }

    #[test]
    fn invalid_destination_rejected() {
        let src = vec![255u8; 16];
        let err = resize_rgba_u8(&src, 2, 2, 0, 1, ResizeFilter::Nearest);
        assert!(matches!(err, Err(ResizeError::InvalidDestinationSize)));
    }

    #[test]
    fn separable_lanczos_produces_valid_output() {
        let mut src = vec![0u8; 4 * 4 * 4];
        for y in 0..4u32 {
            for x in 0..4u32 {
                let idx = ((y * 4 + x) * 4) as usize;
                let val = ((x + y) * 32).min(255) as u8;
                src[idx] = val;
                src[idx + 1] = val;
                src[idx + 2] = val;
                src[idx + 3] = 255;
            }
        }
        let out = resize_rgba_u8(&src, 4, 4, 2, 2, ResizeFilter::Lanczos).unwrap();
        assert_eq!(out.len(), 16);
        for i in (3..16).step_by(4) {
            assert_eq!(out[i], 255);
        }
    }

    #[test]
    fn separable_matches_quality_range() {
        let src = vec![128u8; 8 * 8 * 4];
        for filter in [ResizeFilter::Box, ResizeFilter::Hamming, ResizeFilter::Lanczos] {
            let out = resize_rgba_u8(&src, 8, 8, 4, 4, filter).unwrap();
            for &v in &out {
                assert!((v as i32 - 128).unsigned_abs() <= 1, "filter {:?} produced {v}", filter);
            }
        }
    }

    #[test]
    fn flat_kernel_storage_consistency() {
        // Verify flat kernel storage produces same results as expected
        let mut src = vec![0u8; 16 * 16 * 4];
        for i in 0..src.len() {
            src[i] = (i % 256) as u8;
        }
        let out1 = resize_rgba_u8(&src, 16, 16, 8, 8, ResizeFilter::Lanczos).unwrap();
        let out2 = resize_rgba_u8(&src, 16, 16, 8, 8, ResizeFilter::Lanczos).unwrap();
        assert_eq!(out1, out2, "deterministic output");
        assert_eq!(out1.len(), 8 * 8 * 4);
    }
}
