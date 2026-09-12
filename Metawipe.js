// Reads raw JPEG/PNG structure to report what metadata is present, then
// strips ALL of it by redrawing the image through a canvas and
// re-exporting -- canvas never carries metadata through, so this works
// regardless of what was actually found by the scanner.

const JPEG_MARKER_NAMES = {
  0xe0: 'APP0 (JFIF)',
  0xe1: 'APP1 (EXIF / XMP)',
  0xe2: 'APP2 (ICC profile)',
  0xed: 'APP13 (Photoshop / IPTC)',
  0xfe: 'COM (comment)',
};
// Only markers that can actually carry personal/identifying data are
// flagged as "metadata" -- JFIF (APP0) and ICC color profiles (APP2) are
// harmless format headers that any encoder adds back automatically, so
// they're listed for transparency but never flagged as a privacy concern.
const JPEG_METADATA_MARKERS = new Set([0xe1, 0xed, 0xfe]);

const PNG_METADATA_TYPES = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function parseJPEGSegments(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;

  const segments = [];
  let offset = 2;
  while (offset + 1 < view.byteLength) {
    if (view.getUint8(offset) !== 0xff) break;
    const marker = view.getUint8(offset + 1);
    offset += 2;

    // markers with no length field
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > view.byteLength) break;

    const length = view.getUint16(offset);
    segments.push({
      marker,
      name: JPEG_MARKER_NAMES[marker] || ('marker 0x' + marker.toString(16)),
      isMetadata: JPEG_METADATA_MARKERS.has(marker),
      bytes: length,
    });

    if (marker === 0xda) break; // start of scan -- entropy-coded data follows, stop here
    offset += length;
  }
  return segments;
}

function parsePNGChunks(buffer) {
  const view = new DataView(buffer);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (view.byteLength < 8) return null;
  for (let i = 0; i < 8; i++) {
    if (view.getUint8(i) !== sig[i]) return null;
  }

  const chunks = [];
  let offset = 8;
  while (offset + 8 <= view.byteLength) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      view.getUint8(offset + 4), view.getUint8(offset + 5),
      view.getUint8(offset + 6), view.getUint8(offset + 7)
    );
    chunks.push({
      type,
      isMetadata: PNG_METADATA_TYPES.has(type),
      bytes: length,
    });
    offset += 8 + length + 4; // length field + type + data + crc
    if (type === 'IEND' || length < 0) break;
  }
  return chunks;
}

/**
 * Scans a file's raw bytes and returns a report:
 * { format: 'jpeg'|'png'|'other', segments: [...], metadataCount, metadataBytes }
 */
function scanMetadata(arrayBuffer) {
  const jpeg = parseJPEGSegments(arrayBuffer);
  if (jpeg) {
    const metaSegs = jpeg.filter(s => s.isMetadata);
    return {
      format: 'jpeg',
      segments: jpeg,
      metadataCount: metaSegs.length,
      metadataBytes: metaSegs.reduce((sum, s) => sum + s.bytes, 0),
    };
  }

  const png = parsePNGChunks(arrayBuffer);
  if (png) {
    const metaChunks = png.filter(c => c.isMetadata);
    return {
      format: 'png',
      segments: png.map(c => ({ name: c.type, isMetadata: c.isMetadata, bytes: c.bytes })),
      metadataCount: metaChunks.length,
      metadataBytes: metaChunks.reduce((sum, c) => sum + c.bytes, 0),
    };
  }

  return { format: 'other', segments: [], metadataCount: 0, metadataBytes: 0 };
}

/**
 * Strips metadata by redrawing the image through a canvas and
 * re-exporting it. Returns a Promise<Blob>.
 */
function stripMetadata(file, quality) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      const outType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url);
        if (!blob) { reject(new Error('Could not re-encode image')); return; }
        resolve(blob);
      }, outType, outType === 'image/jpeg' ? quality : undefined);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not load image -- unsupported or corrupted file'));
    };
    img.src = url;
  });
}
