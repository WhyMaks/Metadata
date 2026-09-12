// Reads raw JPEG/PNG structure to report what metadata is present,
// decodes readable values via readMetadata()/readMetadataAsync(),
// then strips ALL of it by redrawing the image through a canvas and
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

// ---------------------------------------------------------------------
// Reading metadata: decode-only, no writing.
// readMetadata() walks the same structures as the scanner but also
// decodes human-readable values:
//  - JPEG APP1 EXIF (TIFF IFD0 + EXIF sub-IFD + GPS sub-IFD, ASCII /
//    SHORT / LONG / RATIONAL)
//  - JPEG COM (comment, latin1/utf8 attempt)
//  - JPEG APP1 XMP / APP13 Photoshop-IPTC (reported, not fully parsed)
//  - PNG tEXt / iTXt (plain) / tIME / eXIf (embedded TIFF)
//  - PNG zTXt / compressed iTXt are reported by readMetadata() as
//    "[compressed, N bytes]" -- use readMetadataAsync() which tries to
//    inflate them via DecompressionStream when available.
// No function in this file writes or modifies metadata.
// ---------------------------------------------------------------------

function _latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function _utf8(bytes) {
  try {
    if (typeof TextDecoder !== 'undefined') {
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
  } catch (e) { /* fall through to latin1 */ }
  return _latin1(bytes);
}

function _cleanStr(s) {
  // strip trailing NULs/spaces, collapse whitespace, cap length for display
  s = s.replace(/\0+$/g, '').replace(/\0/g, ' ').trim();
  if (s.length > 500) s = s.slice(0, 500) + '…';
  return s;
}

function _printablePreview(bytes, max) {
  max = max || 120;
  const latin = _latin1(bytes.slice(0, max));
  // keep only printable ASCII runs, join with spaces
  const runs = latin.match(/[ -~]{4,}/g) || [];
  const preview = runs.join(' ').slice(0, max);
  return preview || ('<' + bytes.length + ' bytes binary>');
}

const TIFF_TAG_NAMES = {
  0x010e: 'ImageDescription',
  0x010f: 'Make',
  0x0110: 'Model',
  0x0112: 'Orientation',
  0x0131: 'Software',
  0x0132: 'DateTime',
  0x013b: 'Artist',
  0x8298: 'Copyright',
  0x8769: 'ExifIFD',
  0x8825: 'GPS IFD',
  0x9003: 'DateTimeOriginal',
  0x9004: 'DateTimeDigitized',
  0x9102: 'CompressedBitsPerPixel',
  0x9286: 'UserComment',
  0x9c9b: 'XPTitle',
  0x9c9c: 'XPComment',
  0x9c9d: 'XPAuthor',
  0x9c9e: 'XPKeywords',
  0x9c9f: 'XPSubject',
};

function _tiffTypeSize(type) {
  if (type === 1 || type === 2 || type === 7) return 1;
  if (type === 3 || type === 8) return 2;
  if (type === 4 || type === 9) return 4;
  if (type === 5 || type === 10) return 8;
  return 0;
}

function parseTiffTags(tiffBytes, prefix) {
  prefix = prefix || '';
  const fields = [];
  if (tiffBytes.length < 8) return fields;
  const le = tiffBytes[0] === 0x49 && tiffBytes[1] === 0x49;
  const be = tiffBytes[0] === 0x4d && tiffBytes[1] === 0x4d;
  if (!le && !be) return fields;
  const view = new DataView(tiffBytes.buffer, tiffBytes.byteOffset, tiffBytes.byteLength);
  const u16 = (off) => view.getUint16(off, le);
  const u32 = (off) => view.getUint32(off, le);
  if (u16(2) !== 42) return fields;
  const ifd0 = u32(4);
  if (ifd0 + 2 > tiffBytes.length) return fields;

  function readValue(type, count, valueOff, inlineBytes) {
    try {
      if (type === 2) { // ASCII
        let bytes;
        if (count <= 4) bytes = inlineBytes.slice(0, count);
        else {
          if (valueOff + count > tiffBytes.length) return '';
          bytes = tiffBytes.slice(valueOff, valueOff + count);
        }
        return _cleanStr(_latin1(bytes));
      }
      if (type === 3) { // SHORT
        const vals = [];
        const inline = count * 2 <= 4;
        for (let i = 0; i < count; i++) {
          if (inline) vals.push(le ? (inlineBytes[i * 2] | (inlineBytes[i * 2 + 1] << 8)) : ((inlineBytes[i * 2] << 8) | inlineBytes[i * 2 + 1]));
          else {
            if (valueOff + i * 2 + 2 > tiffBytes.length) break;
            vals.push(le ? (tiffBytes[valueOff + i * 2] | (tiffBytes[valueOff + i * 2 + 1] << 8))
                         : ((tiffBytes[valueOff + i * 2] << 8) | tiffBytes[valueOff + i * 2 + 1]));
          }
          if (vals.length >= 8) break;
        }
        return vals.join(', ');
      }
      if (type === 4 || type === 9) { // LONG / SLONG
        const vals = [];
        const inline = count * 4 <= 4;
        for (let i = 0; i < count; i++) {
          if (inline) {
            let v;
            if (le) v = (inlineBytes[i * 4] | (inlineBytes[i * 4 + 1] << 8) | (inlineBytes[i * 4 + 2] << 16) | (inlineBytes[i * 4 + 3] << 24)) >>> 0;
            else v = ((inlineBytes[i * 4] << 24) | (inlineBytes[i * 4 + 1] << 16) | (inlineBytes[i * 4 + 2] << 8) | inlineBytes[i * 4 + 3]) >>> 0;
            if (type === 9) v = v | 0;
            vals.push(String(v));
          } else {
            if (valueOff + i * 4 + 4 > tiffBytes.length) break;
            let v = le ? view.getUint32(valueOff + i * 4, true) : view.getUint32(valueOff + i * 4, false);
            if (type === 9) v = v | 0;
            vals.push(String(v));
          }
          if (vals.length >= 8) break;
        }
        return vals.join(', ');
      }
      if (type === 5 || type === 10) { // RATIONAL / SRATIONAL
        const vals = [];
        for (let i = 0; i < count; i++) {
          if (valueOff + i * 8 + 8 > tiffBytes.length) break;
          let n, d;
          if (type === 5) { n = le ? view.getUint32(valueOff + i * 8, true) : view.getUint32(valueOff + i * 8, false); d = le ? view.getUint32(valueOff + i * 8 + 4, true) : view.getUint32(valueOff + i * 8 + 4, false); }
          else { n = le ? view.getInt32(valueOff + i * 8, true) : view.getInt32(valueOff + i * 8, false); d = le ? view.getInt32(valueOff + i * 8 + 4, true) : view.getInt32(valueOff + i * 8 + 4, false); }
          vals.push(d === 0 ? (n + '/0') : (n + '/' + d));
          if (vals.length >= 8) break;
        }
        return vals.join(', ');
      }
      if (type === 7 || type === 1) { // UNDEFINED / BYTE
        let bytes;
        if (count <= 4 && inlineBytes) bytes = inlineBytes.slice(0, count);
        else {
          if (valueOff + count > tiffBytes.length) return '';
          bytes = tiffBytes.slice(valueOff, Math.min(valueOff + count, valueOff + 200));
        }
        // EXIF UserComment starts with 8-byte charset code ("ASCII\0\0\0" etc.)
        if (bytes.length > 8 && prefix === '') {
          const code = _latin1(bytes.slice(0, 8));
          if (/ASCII|UNICODE|JIS/.test(code)) return _cleanStr(_utf8(bytes.slice(8)));
        }
        // XP tags are UTF-16LE
        return _cleanStr(_printablePreview(bytes, 200));
      }
    } catch (e) { return ''; }
    return '';
  }

  function readIfd(offset, subPrefix, depth) {
    if (depth > 2 || offset + 2 > tiffBytes.length) return;
    const count = u16(offset);
    if (count > 200 || offset + 2 + count * 12 > tiffBytes.length + 4) return;
    for (let i = 0; i < count; i++) {
      const eOff = offset + 2 + i * 12;
      if (eOff + 12 > tiffBytes.length) break;
      const tag = u16(eOff);
      const type = u16(eOff + 2);
      const num = u32(eOff + 4);
      if (num === 0 || num > 10000) continue;
      const size = _tiffTypeSize(type);
      if (!size) continue;
      const inlineBytes = tiffBytes.slice(eOff + 8, eOff + 12);
      let valueOff = 0;
      if (num * size > 4) {
        valueOff = u32(eOff + 8);
        if (valueOff + Math.min(num * size, 64) > tiffBytes.length) continue;
      }
      // recurse into sub-IFDs (value is an offset, single LONG)
      if ((tag === 0x8769 || tag === 0x8825) && type === 4 && num === 1) {
        const subOff = (num * size <= 4)
          ? ((le ? (inlineBytes[0] | (inlineBytes[1] << 8) | (inlineBytes[2] << 16) | (inlineBytes[3] << 24)) : ((inlineBytes[0] << 24) | (inlineBytes[1] << 16) | (inlineBytes[2] << 8) | inlineBytes[3])) >>> 0)
          : valueOff;
        readIfd(subOff, tag === 0x8769 ? 'EXIF:' : 'GPS:', depth + 1);
        continue;
      }
      const name = TIFF_TAG_NAMES[tag] || ('tag 0x' + tag.toString(16));
      const value = readValue(type, num, valueOff, inlineBytes);
      if (value !== '') fields.push({ source: subPrefix || 'EXIF', name: (subPrefix || '') + name, value });
    }
  }

  readIfd(ifd0, prefix, 0);
  return fields;
}

function parseExifPayload(dataBytes) {
  // dataBytes: full APP1 content after the length field (starts with "Exif\0\0" or XMP header)
  const fields = [];
  if (dataBytes.length >= 6 &&
      dataBytes[0] === 0x45 && dataBytes[1] === 0x78 && dataBytes[2] === 0x69 && dataBytes[3] === 0x66 &&
      dataBytes[4] === 0x00 && dataBytes[5] === 0x00) {
    const tiff = dataBytes.slice(6);
    parseTiffTags(tiff, '').forEach(f => fields.push({ source: 'EXIF', name: f.name, value: f.value }));
    if (fields.length === 0) fields.push({ source: 'EXIF', name: 'note', value: 'empty EXIF block (' + dataBytes.length + ' bytes)' });
  } else if (_latin1(dataBytes.slice(0, 28)).indexOf('http://ns.adobe.com/xap/1.0/') === 0) {
    const text = _cleanStr(_utf8(dataBytes.slice(29)));
    fields.push({ source: 'XMP', name: 'packet', value: text.slice(0, 500) || ('(' + dataBytes.length + ' bytes)') });
  } else {
    fields.push({ source: 'APP1', name: 'unknown block', value: _printablePreview(dataBytes, 120) });
  }
  return fields;
}

function extractJpegFields(arrayBuffer) {
  const fields = [];
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return fields;
  let offset = 2;
  while (offset + 1 < view.byteLength) {
    if (view.getUint8(offset) !== 0xff) break;
    const marker = view.getUint8(offset + 1);
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > view.byteLength) break;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > view.byteLength + 2) break;
    const data = bytes.slice(offset + 2, offset + length);
    if (marker === 0xe1) {
      parseExifPayload(data).forEach(f => fields.push(f));
    } else if (marker === 0xfe) {
      const v = _cleanStr(_utf8(data)) || _cleanStr(_latin1(data));
      fields.push({ source: 'COM', name: 'comment', value: v || ('(' + data.length + ' bytes)') });
    } else if (marker === 0xed) {
      const preview = _printablePreview(data, 120);
      fields.push({ source: 'APP13', name: 'Photoshop/IPTC', value: preview + ' (' + data.length + ' bytes)' });
    }
    if (marker === 0xda) break;
    offset += length;
  }
  return fields;
}

function parsePngChunksWithData(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (view.byteLength < 8) return null;
  for (let i = 0; i < 8; i++) if (view.getUint8(i) !== sig[i]) return null;
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= view.byteLength) {
    const length = view.getUint32(offset);
    if (length > 100 * 1024 * 1024 || offset + 12 + length > view.byteLength) break;
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const data = bytes.slice(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 8 + length + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}

function decodePngTextChunk(data) {
  const nul = data.indexOf(0);
  if (nul < 0) return null;
  const keyword = _cleanStr(_latin1(data.slice(0, nul))) || 'text';
  const text = _cleanStr(_latin1(data.slice(nul + 1)));
  return { source: 'PNG-tEXt', name: keyword, value: text };
}

function decodePngItxtChunk(data) {
  // keyword NUL compFlag compMethod lang NUL translated NUL text
  const nul = data.indexOf(0);
  if (nul < 0 || data.length < nul + 4) return null;
  const keyword = _cleanStr(_utf8(data.slice(0, nul))) || 'text';
  const compFlag = data[nul + 1];
  let p = nul + 3;
  while (p < data.length && data[p] !== 0) p++;
  if (p >= data.length) return null;
  p++; // skip lang NUL
  while (p < data.length && data[p] !== 0) p++;
  if (p >= data.length) return null;
  p++; // skip translated-keyword NUL
  const textBytes = data.slice(p);
  if (compFlag === 1) {
    return { source: 'PNG-iTXt', name: keyword, value: '[compressed, ' + textBytes.length + ' bytes]', compressed: textBytes };
  }
  return { source: 'PNG-iTXt', name: keyword, value: _cleanStr(_utf8(textBytes)) };
}

function extractPngFields(arrayBuffer) {
  const fields = [];
  const chunks = parsePngChunksWithData(arrayBuffer);
  if (!chunks) return fields;
  chunks.forEach(c => {
    if (c.type === 'tEXt') {
      const f = decodePngTextChunk(c.data);
      if (f) fields.push({ source: f.source, name: f.name, value: f.value });
    } else if (c.type === 'iTXt') {
      const f = decodePngItxtChunk(c.data);
      if (f) {
        if (f.compressed) fields.push({ source: f.source, name: f.name, value: f.value, compressed: f.compressed });
        else fields.push({ source: f.source, name: f.name, value: f.value });
      }
    } else if (c.type === 'zTXt') {
      const nul = c.data.indexOf(0);
      if (nul > 0 && c.data.length > nul + 2) {
        const keyword = _cleanStr(_latin1(c.data.slice(0, nul))) || 'text';
        const compBytes = c.data.slice(nul + 2);
        fields.push({ source: 'PNG-zTXt', name: keyword, value: '[compressed, ' + compBytes.length + ' bytes]', compressed: compBytes });
      }
    } else if (c.type === 'tIME') {
      if (c.data.length === 7) {
        const y = (c.data[0] << 8) | c.data[1];
        const mo = String(c.data[2]).padStart(2, '0'), d = String(c.data[3]).padStart(2, '0');
        const h = String(c.data[4]).padStart(2, '0'), mi = String(c.data[5]).padStart(2, '0'), s = String(c.data[6]).padStart(2, '0');
        fields.push({ source: 'PNG', name: 'last-modified', value: y + '-' + mo + '-' + d + ' ' + h + ':' + mi + ':' + s + ' UTC' });
      }
    } else if (c.type === 'eXIf') {
      // may start with "Exif\0\0" or directly with TIFF header
      let tiff = c.data;
      if (tiff.length > 6 && tiff[0] === 0x45 && tiff[1] === 0x78 && tiff[2] === 0x69 && tiff[3] === 0x66) tiff = tiff.slice(6);
      const tags = parseTiffTags(tiff, '');
      if (tags.length === 0) fields.push({ source: 'PNG-eXIf', name: 'note', value: '(' + c.data.length + ' bytes, could not parse)' });
      else tags.forEach(t => fields.push({ source: 'PNG-eXIf', name: t.name, value: t.value }));
    }
  });
  return fields;
}

/**
 * Reads human-readable metadata values from raw file bytes (sync).
 * Compressed PNG chunks are reported without inflating.
 * Returns { format: 'jpeg'|'png'|'other', fields: [{source, name, value}] }.
 */
function readMetadata(arrayBuffer) {
  const jpeg = parseJPEGSegments(arrayBuffer);
  if (jpeg) return { format: 'jpeg', fields: extractJpegFields(arrayBuffer) };
  const png = parsePNGChunks(arrayBuffer);
  if (png) return { format: 'png', fields: extractPngFields(arrayBuffer) };
  return { format: 'other', fields: [] };
}

async function _inflateRaw(bytes) {
  // bytes: Uint8Array (zlib-wrapped deflate stream, as stored in PNG)
  if (typeof DecompressionStream === 'undefined') throw new Error('no DecompressionStream');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Same as readMetadata() but also tries to decompress PNG
 * zTXt / compressed iTXt chunks. Falls back to the "[compressed]"
 * placeholder when inflation is unavailable or fails.
 */
async function readMetadataAsync(arrayBuffer) {
  const report = readMetadata(arrayBuffer);
  const out = [];
  for (const f of report.fields) {
    if (f.compressed) {
      try {
        const raw = await _inflateRaw(f.compressed);
        out.push({ source: f.source, name: f.name, value: _cleanStr(_utf8(raw)) || ('(' + raw.length + ' bytes)') });
      } catch (e) {
        out.push({ source: f.source, name: f.name, value: f.value });
      }
    } else {
      out.push({ source: f.source, name: f.name, value: f.value });
    }
  }
  return { format: report.format, fields: out };
}
