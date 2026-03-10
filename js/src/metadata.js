/**
 * Lightweight JPEG EXIF extractor / injector.
 * No external dependencies — operates on raw binary segments.
 *
 * Supports:
 *   - Extracting APP1 (EXIF), APP2 (ICC), APP13 (IPTC) segments
 *   - Reading EXIF Orientation tag
 *   - Re-injecting preserved segments into a new JPEG blob
 */

const MARKER_SOI = 0xffd8;
const MARKER_SOS = 0xffda;
const MARKER_APP1 = 0xffe1;
const MARKER_APP2 = 0xffe2;
const MARKER_APP13 = 0xffed;

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
const ORIENTATION_TAG = 0x0112;

function readUint16(view, offset, littleEndian) {
  return view.getUint16(offset, littleEndian);
}

/**
 * Extract metadata segments from JPEG binary data.
 * Returns raw segment bytes (including marker + length header) for each type found.
 */
export function extractSegments(jpegBuffer) {
  const view = new DataView(jpegBuffer);
  const segments = { exif: null, icc: [], iptc: null };

  if (view.getUint16(0) !== MARKER_SOI) {
    return segments;
  }

  let offset = 2;
  while (offset < view.byteLength - 1) {
    const marker = view.getUint16(offset);

    // Reached image data — no more metadata segments
    if (marker === MARKER_SOS || (marker & 0xff00) !== 0xff00) {
      break;
    }

    // Skip standalone markers (no length field)
    if (marker >= 0xffd0 && marker <= 0xffd9) {
      offset += 2;
      continue;
    }

    const segLen = view.getUint16(offset + 2);
    const segStart = offset;
    const segEnd = offset + 2 + segLen;

    if (segEnd > view.byteLength) break;

    if (marker === MARKER_APP1 && !segments.exif) {
      // Verify EXIF header
      let isExif = true;
      for (let i = 0; i < EXIF_HEADER.length; i += 1) {
        if (view.getUint8(offset + 4 + i) !== EXIF_HEADER[i]) {
          isExif = false;
          break;
        }
      }
      if (isExif) {
        segments.exif = new Uint8Array(jpegBuffer, segStart, segEnd - segStart);
      }
    }

    if (marker === MARKER_APP2) {
      segments.icc.push(new Uint8Array(jpegBuffer, segStart, segEnd - segStart));
    }

    if (marker === MARKER_APP13 && !segments.iptc) {
      segments.iptc = new Uint8Array(jpegBuffer, segStart, segEnd - segStart);
    }

    offset = segEnd;
  }

  return segments;
}

/**
 * Read EXIF Orientation tag (1-8) from JPEG binary data.
 * Returns 1 (normal) if not found or not JPEG.
 */
export function readOrientation(jpegBuffer) {
  const view = new DataView(jpegBuffer);

  if (view.getUint16(0) !== MARKER_SOI) return 1;

  let offset = 2;
  while (offset < view.byteLength - 1) {
    const marker = view.getUint16(offset);

    if (marker === MARKER_SOS || (marker & 0xff00) !== 0xff00) break;

    if (marker >= 0xffd0 && marker <= 0xffd9) {
      offset += 2;
      continue;
    }

    const segLen = view.getUint16(offset + 2);
    const segEnd = offset + 2 + segLen;

    if (marker === MARKER_APP1) {
      // Check EXIF header
      let isExif = true;
      for (let i = 0; i < EXIF_HEADER.length; i += 1) {
        if (offset + 4 + i >= view.byteLength) { isExif = false; break; }
        if (view.getUint8(offset + 4 + i) !== EXIF_HEADER[i]) { isExif = false; break; }
      }

      if (isExif) {
        return parseOrientationFromExif(view, offset + 4 + EXIF_HEADER.length, segEnd);
      }
    }

    offset = segEnd;
  }

  return 1;
}

function parseOrientationFromExif(view, tiffStart, segEnd) {
  if (tiffStart + 8 > segEnd) return 1;

  // TIFF header: byte order
  const byteOrder = view.getUint16(tiffStart);
  const le = byteOrder === 0x4949; // 'II' = little-endian
  if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return 1;

  // Verify TIFF magic 42
  if (readUint16(view, tiffStart + 2, le) !== 42) return 1;

  // IFD0 offset (relative to TIFF start)
  const ifdOffset = view.getUint32(tiffStart + 4, le);
  const ifdPos = tiffStart + ifdOffset;

  if (ifdPos + 2 > segEnd) return 1;
  const entryCount = readUint16(view, ifdPos, le);

  for (let i = 0; i < entryCount; i += 1) {
    const entryOffset = ifdPos + 2 + i * 12;
    if (entryOffset + 12 > segEnd) break;

    const tag = readUint16(view, entryOffset, le);
    if (tag === ORIENTATION_TAG) {
      const value = readUint16(view, entryOffset + 8, le);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }

  return 1;
}

/**
 * Inject previously extracted metadata segments into a new JPEG blob.
 * Inserts segments right after SOI, before the rest of the image data.
 */
export async function injectSegments(jpegBlob, segments) {
  const buffer = await jpegBlob.arrayBuffer();
  const view = new DataView(buffer);

  if (view.getUint16(0) !== MARKER_SOI) {
    return jpegBlob; // not a JPEG, return as-is
  }

  const parts = [];

  // SOI marker
  parts.push(new Uint8Array(buffer, 0, 2));

  // Inject preserved segments
  if (segments.exif) {
    parts.push(new Uint8Array(segments.exif));
  }
  if (segments.icc && segments.icc.length > 0) {
    for (const chunk of segments.icc) {
      parts.push(new Uint8Array(chunk));
    }
  }
  if (segments.iptc) {
    parts.push(new Uint8Array(segments.iptc));
  }

  // Skip existing APP segments in the new JPEG to avoid duplicates
  let restOffset = 2;
  while (restOffset < buffer.byteLength - 1) {
    const marker = view.getUint16(restOffset);

    if (marker === MARKER_SOS || (marker & 0xff00) !== 0xff00) break;

    if (marker >= 0xffd0 && marker <= 0xffd9) {
      restOffset += 2;
      continue;
    }

    const segLen = view.getUint16(restOffset + 2);
    const segMarker = marker;

    // Skip APP1 (EXIF), APP2 (ICC), APP13 (IPTC) in the new JPEG
    // since we're injecting our own copies
    if (segMarker === MARKER_APP1 || segMarker === MARKER_APP2 || segMarker === MARKER_APP13) {
      restOffset = restOffset + 2 + segLen;
      continue;
    }

    break;
  }

  // Rest of the JPEG (quantization tables, huffman tables, image data, etc.)
  parts.push(new Uint8Array(buffer, restOffset));

  return new Blob(parts, { type: "image/jpeg" });
}

/**
 * Compute the canvas transform needed to correct EXIF orientation.
 * Returns { width, height, transform } where width/height are the
 * corrected dimensions and transform is applied to CanvasRenderingContext2D.
 */
export function orientationTransform(orientation, width, height) {
  // Orientations 5-8 swap width/height
  const swapped = orientation >= 5;
  const outW = swapped ? height : width;
  const outH = swapped ? width : height;

  return {
    width: outW,
    height: outH,
    apply(ctx) {
      switch (orientation) {
        case 2: ctx.transform(-1, 0, 0, 1, outW, 0); break;
        case 3: ctx.transform(-1, 0, 0, -1, outW, outH); break;
        case 4: ctx.transform(1, 0, 0, -1, 0, outH); break;
        case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
        case 6: ctx.transform(0, 1, -1, 0, outW, 0); break;
        case 7: ctx.transform(0, -1, -1, 0, outW, outH); break;
        case 8: ctx.transform(0, -1, 1, 0, 0, outH); break;
        default: break; // orientation 1 = no transform
      }
    },
  };
}
