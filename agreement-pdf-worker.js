// Server-side signed-agreement stamping — runs INSIDE the Cloudflare Worker,
// triggered automatically the moment a client's signature is saved (see the
// nowSigned && !prevSigned check in worker.js), with no admin click involved.
//
// This is a SEPARATE implementation from public/assets/sign-agreement.js, not
// a shared one. That file runs in a browser (Image, canvas, document) and this
// runs in the Workers runtime (neither exists there); they cannot be one file.
// The GEOMETRY constants below MUST be kept numerically identical to that
// file's GEOMETRY — a change to the template's layout has to be applied in
// BOTH places by hand, or the client's own download and the auto-filed copy
// will silently drift apart. If you change one, change the other.
//
// KNOWN, DELIBERATE DIFFERENCE from the browser version: this does NOT crop
// the signature to its ink bounding box. Cropping needs pixel-level PNG
// decoding (reading the alpha channel), and there is no Canvas/Image API in
// the Workers runtime to do that with. Writing a hand-rolled PNG decoder is a
// second, separate risk on top of an already-novel change (this repo's first
// npm-sourced import into worker.js) — not worth stacking into one deploy.
// Practical effect: if a client's signature only fills a small part of the
// 600x180 pad, the auto-filed copy renders it smaller than the client's own
// downloaded copy (which does crop). Still legible in every case tested
// (STATUS.md), but not guaranteed for an unusually small signature. Fixing
// this for real means either moving the crop to capture time (storing an
// already-cropped image for every consumer) or a real PNG decoder — tracked
// in STATUS.md as a follow-up, not silently accepted.

import { PDFDocument, StandardFonts, rgb } from './vendor/pdf-lib.esm.min.js';

// Copied verbatim from sign-agreement.js's GEOMETRY. See the file-level
// comment above for why this can't just be imported from that file.
const GEOMETRY = {
  pageIndex: 1,
  name: {
    leftX: 60.85, baselineY: 257.15, size: 10.5, minSize: 7, maxWidth: 335,
    coverX: 55, coverY: 252.5, coverW: 345, coverH: 14, coverGrey: 0.9686274509,
  },
  sigLeftX: 125, dateLeftX: 100, sigBottomY: 226,
  dateBaselineY: 184.35, dateLift: 3, maxWidth: 240, maxHeight: 26, dateSize: 10.5,
};

// Same swap table as sign-agreement.js's LETTER_SWAPS/sanitizeName — kept
// verbatim for the same reason as GEOMETRY above.
const LETTER_SWAPS = {
  'Ł': 'L', 'ł': 'l', 'Đ': 'D', 'đ': 'd', 'Ħ': 'H', 'ħ': 'h',
  'Ŋ': 'N', 'ŋ': 'n', 'Ŧ': 'T', 'ŧ': 't', 'Œ': 'OE', 'œ': 'oe',
  'ı': 'i', 'İ': 'I', 'ĸ': 'k', 'ẞ': 'SS', 'Ə': 'E', 'ə': 'e',
};
const PUNCTUATION_SWAPS = [
  [/[‘’‚‛′]/g, "'"], [/[“”„‟″]/g, '"'], [/[‐-―−]/g, '-'],
  [/…/g, '...'], [/[     ]/g, ' '], [/[​‌‍﻿]/g, ''],
];

function sanitizeName(value) {
  if (!value) return '';
  let s = String(value);
  for (const [pattern, replacement] of PUNCTUATION_SWAPS) s = s.replace(pattern, replacement);
  let out = '';
  for (const ch of s) {
    if (/[\x20-\x7E\xA0-\xFF]/.test(ch)) { out += ch; continue; }
    if (LETTER_SWAPS[ch] !== undefined) { out += LETTER_SWAPS[ch]; continue; }
    const folded = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (folded && /^[\x20-\x7E\xA0-\xFF]*$/.test(folded)) out += folded;
  }
  return out.replace(/\s+/g, ' ').trim();
}

// Same field-priority order as sign-agreement.js's resolveClientName.
export function resolveClientNameServer(data) {
  data = data || {};
  const agreement = data.agreement || {};
  const profile = data.profile || {};
  const consent = data.consent || {};
  const candidates = [
    agreement.typedName,
    [profile.firstName, profile.lastName].filter(Boolean).join(' '),
    profile.name,
    consent.name,
  ];
  for (const candidate of candidates) {
    const clean = sanitizeName(candidate);
    if (clean) return clean;
  }
  return '';
}

function formatSignedDate(signedAt) {
  if (!signedAt) return '';
  const d = new Date(signedAt);
  if (isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function fitTextSize(font, text, size, maxWidth, minSize) {
  let s = size;
  while (s > minSize && font.widthOfTextAtSize(text, s) > maxWidth) s -= 0.25;
  return s;
}

function dataUrlToBytes(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('The stored signature is not a data URL');
  const base64 = dataUrl.slice(comma + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// templateBytes: ArrayBuffer/Uint8Array of the agreement PDF, read by the
// caller via env.ASSETS.fetch (the same binding serveAsset() already uses —
// this is the Worker reading its own bundled static file, not a new mechanism).
export async function buildSignedAgreementServer(templateBytes, { signatureDataUrl, signedAt, clientName }) {
  if (!signatureDataUrl) throw new Error('No signature to stamp');
  const doc = await PDFDocument.load(templateBytes);
  const page = doc.getPages()[GEOMETRY.pageIndex];
  if (!page) throw new Error(`Template has no page ${GEOMETRY.pageIndex + 1} — geometry needs re-deriving`);

  const inkBytes = dataUrlToBytes(signatureDataUrl);
  const [png, font, boldFont] = await Promise.all([
    doc.embedPng(inkBytes),
    doc.embedFont(StandardFonts.TimesRoman),
    doc.embedFont(StandardFonts.TimesRomanBold),
  ]);
  const ink0 = rgb(0.11, 0.145, 0.188);
  const N = GEOMETRY.name;

  const name = sanitizeName(clientName);
  if (name) {
    page.drawRectangle({
      x: N.coverX, y: N.coverY, width: N.coverW, height: N.coverH,
      color: rgb(N.coverGrey, N.coverGrey, N.coverGrey), borderWidth: 0,
    });
    page.drawText(name, {
      x: N.leftX, y: N.baselineY,
      size: fitTextSize(boldFont, name, N.size, N.maxWidth, N.minSize),
      font: boldFont, color: ink0,
    });
  }

  // Contain-fit against the FULL, untrimmed pad — see the file-level comment
  // on why there is no ink crop here. png.width/png.height are the pad's own
  // dimensions (pdf-lib reads them from the PNG header; this needs no decoder).
  const scale = Math.min(GEOMETRY.maxWidth / png.width, GEOMETRY.maxHeight / png.height);
  page.drawImage(png, {
    x: GEOMETRY.sigLeftX, y: GEOMETRY.sigBottomY,
    width: png.width * scale, height: png.height * scale,
  });

  const dateText = formatSignedDate(signedAt);
  if (dateText) {
    page.drawText(dateText, {
      x: GEOMETRY.dateLeftX, y: GEOMETRY.dateBaselineY + GEOMETRY.dateLift,
      size: GEOMETRY.dateSize, font, color: ink0,
    });
  }

  return doc.save();
}
