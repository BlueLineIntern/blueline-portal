// Stamps a captured signature onto the Advisory Agreement PDF template.
//
// Loaded by BOTH the client onboarding wizard (public/onboarding/) and the
// admin contact profile's Documents tab, so the two produce the same document
// from the same stored signature. That is the whole reason this lives in one
// file instead of being written twice: the client's copy and the firm's copy
// must not be able to disagree.
//
// (Not byte-identical between the two callers — pdf-lib names its XObjects with
// a random suffix, so the files differ by a couple of bytes. The rendered
// document, template and placement are the same.)
//
// Nothing is stored. The signed PDF is generated on demand from the signature
// already on the onboarding record, so there is no second copy of a signed
// agreement sitting in KV or SharePoint going stale.
//
// PROOF OF CONCEPT. The onboarding endpoints are unauthenticated by design, so
// a signature here has no signer attribution and the PDF carries no tamper
// evidence. It is not a legally binding signature and must not be relied on as
// an executed agreement.

(function (global) {
  'use strict';

  var TEMPLATE_URL = '/onboarding/advisory-agreement.pdf';
  var PDFLIB_URL = '/assets/vendor/pdf-lib.min.js';

  // Page 2 geometry, taken from the template's OWN content stream rather than
  // measured off a screenshot: the grey signature box is drawn by the operator
  //     0.9686 0.9686 0.9686 rg   50.8 158.35 496.75 120.05 re f*
  // and the three text baselines inside it are at 257.15 ("Jeannette Smith"),
  // 223.75 ("Signature: ____") and 184.35 ("Date: ____").
  //
  // pdf-lib uses a BOTTOM-LEFT origin; the page is US Letter, 612 x 792 pt.
  // If the template PDF is ever re-exported these numbers must be re-derived —
  // they are specific to this file, not to "advisory agreements" in general.
  var GEOMETRY = {
    pageIndex: 1, // zero-based: page 2

    // The template prints a SAMPLE client name ("Jeannette Smith") on its own
    // line at baseline 257.15 in NotoSerif-Bold 10.5. Whatever the client typed
    // has to replace it, or the document contradicts its own signature.
    //
    // It is covered with a rectangle in the signature box's own fill colour and
    // the real name drawn on top. This works because that box is a FLAT
    // #F7F7F7 fill and nothing else is drawn on that line — give the box a
    // border, a pattern or a second column and the patch becomes visible.
    //
    // CAVEAT: covering is visual only. The sample name is still in the page's
    // text layer, so copying text out of the PDF (or a text extractor) still
    // yields "Jeannette Smith". Acceptable for a labelled proof of concept;
    // for anything real, re-export the template without the name instead.
    name: {
      leftX: 60.85,
      baselineY: 257.15,
      size: 10.5,
      minSize: 7,
      maxWidth: 335,
      // Cover spans the flat-grey run on that line only. It starts at 252.5 —
      // just above the signature's own maximum top edge (226 + 26) — and the
      // cover is drawn BEFORE the signature anyway, so it can never erase it.
      coverX: 55,
      coverY: 252.5,
      coverW: 345,
      coverH: 14,
      coverGrey: 0.9686274509, // exactly the template's `0.9686... rg` box fill
    },

    // Left edges clear the printed "Signature:" / "Date:" labels, which start
    // at x=60.85 and run ~58pt and ~31pt wide respectively at 10.5pt.
    sigLeftX: 125,
    dateLeftX: 100,

    // The signature sits just ON TOP of the rule (whose glyph baseline is
    // 223.75) rather than straddling it, the way a real signature does.
    sigBottomY: 226,
    dateBaselineY: 184.35,
    dateLift: 3, // lift the typed date clear of its rule so it stays legible

    // Contain-fit box. The height cap is the binding one: the printed client
    // name's baseline is at 257.15, so 226 + 26 leaves ~7pt of clearance and
    // the signature cannot collide with it however it was drawn.
    maxWidth: 240,
    maxHeight: 26,

    dateSize: 10.5,
  };

  // ---------- pdf-lib, loaded on demand ----------

  var pdfLibPromise = null;

  // 512KB. Deliberately fetched on first click rather than on every page load
  // of the wizard and the contact profile, neither of which usually needs it.
  function loadPdfLib() {
    if (global.PDFLib) return Promise.resolve(global.PDFLib);
    if (pdfLibPromise) return pdfLibPromise;
    pdfLibPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = PDFLIB_URL;
      s.onload = function () {
        if (global.PDFLib) resolve(global.PDFLib);
        else reject(new Error('The PDF library loaded but did not initialise.'));
      };
      s.onerror = function () {
        reject(new Error('Could not load the PDF library.'));
      };
      document.head.appendChild(s);
    });
    // A failed load must not be cached, or one flaky request disables the
    // button for the rest of the page's life.
    pdfLibPromise.catch(function () { pdfLibPromise = null; });
    return pdfLibPromise;
  }

  // ---------- Signature preparation ----------

  // The pad is a fixed 600x180 bitmap, but the ink typically occupies a small
  // part of it. Stamping the whole bitmap would scale the actual signature down
  // to an illegible sliver, so crop to the ink's bounding box first. The pad
  // only ever clearRect()s its background, so it is transparent and alpha is a
  // reliable test for ink.
  function trimToInk(dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth;
        var h = img.naturalHeight;
        if (!w || !h) return reject(new Error('The stored signature image is empty.'));

        var src = document.createElement('canvas');
        src.width = w;
        src.height = h;
        var ctx = src.getContext('2d');
        ctx.drawImage(img, 0, 0);

        var data;
        try {
          data = ctx.getImageData(0, 0, w, h).data;
        } catch (err) {
          // Canvas reads can be refused (tainted canvas). Stamping the untrimmed
          // bitmap still produces a correct document, just a smaller signature —
          // better than failing the download outright.
          return resolve({ dataUrl: dataUrl, width: w, height: h, trimmed: false });
        }

        var minX = w, minY = h, maxX = -1, maxY = -1;
        for (var y = 0; y < h; y++) {
          for (var x = 0; x < w; x++) {
            // >8 rather than >0: antialiasing leaves near-zero alpha well
            // outside the visible stroke, which would defeat the crop.
            if (data[(y * w + x) * 4 + 3] > 8) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX < 0) return reject(new Error('The captured signature is blank.'));

        var pad = 4;
        minX = Math.max(0, minX - pad);
        minY = Math.max(0, minY - pad);
        maxX = Math.min(w - 1, maxX + pad);
        maxY = Math.min(h - 1, maxY + pad);

        var tw = maxX - minX + 1;
        var th = maxY - minY + 1;
        var out = document.createElement('canvas');
        out.width = tw;
        out.height = th;
        out.getContext('2d').drawImage(src, minX, minY, tw, th, 0, 0, tw, th);
        resolve({ dataUrl: out.toDataURL('image/png'), width: tw, height: th, trimmed: true });
      };
      img.onerror = function () {
        reject(new Error('The stored signature image could not be read.'));
      };
      img.src = dataUrl;
    });
  }

  // The standard-14 fonts are WinAnsi-encoded and pdf-lib's drawText THROWS on
  // any character outside that encoding, so a name has to be made safe before it
  // is drawn — otherwise one autocorrected apostrophe fails the whole download.
  //
  // Deleting the offenders is not good enough: phones turn ' into U+2019, and
  // dropping it silently renders O'Leary as "OLeary". So characters are
  // TRANSLITERATED where there is a sensible ASCII equivalent, and only dropped
  // when there genuinely isn't one. The 0x80-0x9F range counts as unsafe
  // throughout: WinAnsi defines only part of it.
  var PUNCTUATION_SWAPS = [
    [/[‘’‚‛′]/g, "'"],  // curly single quotes, prime
    [/[“”„‟″]/g, '"'],  // curly double quotes
    [/[‐-―−]/g, '-'],             // hyphens, dashes, minus
    [/…/g, '...'],
    [/[     ]/g, ' '],  // non-breaking / thin spaces
    [/[​‌‍﻿]/g, ''],         // zero-width junk
  ];

  // Latin letters with no NFD decomposition, so folding cannot reach them.
  // Ø, Æ, Þ, Ð and ß are deliberately absent — WinAnsi encodes those already.
  var LETTER_SWAPS = {
    'Ł': 'L', 'ł': 'l', 'Đ': 'D', 'đ': 'd', 'Ħ': 'H', 'ħ': 'h',
    'Ŋ': 'N', 'ŋ': 'n', 'Ŧ': 'T', 'ŧ': 't', 'Œ': 'OE', 'œ': 'oe',
    'ı': 'i', 'İ': 'I', 'ĸ': 'k', 'ẞ': 'SS', 'Ə': 'E', 'ə': 'e',
  };

  function sanitizeName(value) {
    if (!value) return '';
    var s = String(value);
    for (var i = 0; i < PUNCTUATION_SWAPS.length; i++) {
      s = s.replace(PUNCTUATION_SWAPS[i][0], PUNCTUATION_SWAPS[i][1]);
    }
    // Per character, so an already-encodable accent (é, ü, ñ, ø, æ, þ, ß — all
    // WinAnsi) is left intact, while one that isn't degrades to its base letter
    // rather than vanishing.
    var out = '';
    for (var j = 0; j < s.length; j++) {
      var ch = s[j];
      if (/[\x20-\x7E\xA0-\xFF]/.test(ch)) { out += ch; continue; }
      // Stroked and ligature letters do NOT decompose under NFD, so folding
      // alone silently deletes them — turning Łukasz into "ukasz", i.e. losing
      // the first letter of someone's name. Map them explicitly first.
      if (LETTER_SWAPS[ch] !== undefined) { out += LETTER_SWAPS[ch]; continue; }
      var folded = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      if (folded && /^[\x20-\x7E\xA0-\xFF]*$/.test(folded)) out += folded;
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  // Both callers resolve the name through THIS function rather than each picking
  // their own field order — otherwise the client's copy and the firm's copy could
  // legitimately show different names for the same signature.
  //
  // `data` is an onboarding record's data object ({consent, profile, agreement}).
  // Returns '' when nothing usable is on the record, which the caller must treat
  // as "leave the template alone" rather than "print a blank".
  function resolveClientName(data) {
    data = data || {};
    var agreement = data.agreement || {};
    var profile = data.profile || {};
    var consent = data.consent || {};
    var candidates = [
      agreement.typedName, // what they typed on the agreement step itself
      [profile.firstName, profile.lastName].filter(Boolean).join(' '),
      profile.name,
      consent.name,
    ];
    for (var i = 0; i < candidates.length; i++) {
      var clean = sanitizeName(candidates[i]);
      if (clean) return clean;
    }
    return '';
  }

  // Shrink to fit rather than overflow the covered area. Names are short enough
  // that this almost never triggers, but "almost never" is not never.
  function fitTextSize(font, text, size, maxWidth, minSize) {
    var s = size;
    while (s > minSize && font.widthOfTextAtSize(text, s) > maxWidth) s -= 0.25;
    return s;
  }

  // signedAt is a full ISO timestamp (not a date-only string), so parsing it
  // carries no risk of the UTC-midnight-renders-as-yesterday bug.
  function formatSignedDate(signedAt) {
    if (!signedAt) return '';
    var d = new Date(signedAt);
    if (isNaN(d.getTime())) return '';
    return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
  }

  // ---------- Build ----------

  // opts: { signatureDataUrl, signedAt, templateUrl? } -> Promise<Uint8Array>
  function buildSignedAgreement(opts) {
    opts = opts || {};
    if (!opts.signatureDataUrl) {
      return Promise.reject(new Error('No signature was captured for this agreement.'));
    }
    var templateUrl = opts.templateUrl || TEMPLATE_URL;

    return Promise.all([
      loadPdfLib(),
      fetch(templateUrl).then(function (res) {
        if (!res.ok) throw new Error('Could not load the agreement template (HTTP ' + res.status + ').');
        return res.arrayBuffer();
      }),
      trimToInk(opts.signatureDataUrl),
    ]).then(function (parts) {
      var PDFLib = parts[0];
      var templateBytes = parts[1];
      var ink = parts[2];

      return PDFLib.PDFDocument.load(templateBytes).then(function (doc) {
        var page = doc.getPages()[GEOMETRY.pageIndex];
        if (!page) {
          throw new Error(
            'The agreement template no longer has a page ' + (GEOMETRY.pageIndex + 1) +
            '. Its signature coordinates need to be re-derived.'
          );
        }
        // Times rather than Helvetica: the document is set in NotoSerif, and a
        // sans-serif fill-in next to it reads as a different document.
        return Promise.all([
          doc.embedPng(ink.dataUrl),
          doc.embedFont(PDFLib.StandardFonts.TimesRoman),
          doc.embedFont(PDFLib.StandardFonts.TimesRomanBold),
        ]).then(function (embedded) {
          var png = embedded[0];
          var font = embedded[1];
          var boldFont = embedded[2];
          var ink0 = PDFLib.rgb(0.11, 0.145, 0.188);
          var N = GEOMETRY.name;

          // --- Client name, FIRST so the cover cannot paint over the signature.
          // An empty name deliberately leaves the template untouched: printing a
          // blank where a name belongs is worse than the sample name being wrong.
          var clientName = sanitizeName(opts.clientName);
          if (clientName) {
            page.drawRectangle({
              x: N.coverX,
              y: N.coverY,
              width: N.coverW,
              height: N.coverH,
              color: PDFLib.rgb(N.coverGrey, N.coverGrey, N.coverGrey),
              borderWidth: 0,
            });
            page.drawText(clientName, {
              x: N.leftX,
              y: N.baselineY,
              size: fitTextSize(boldFont, clientName, N.size, N.maxWidth, N.minSize),
              font: boldFont,
              color: ink0,
            });
          }

          // --- Signature. Contain-fit, so it keeps the proportions it was drawn in.
          var scale = Math.min(
            GEOMETRY.maxWidth / ink.width,
            GEOMETRY.maxHeight / ink.height
          );
          page.drawImage(png, {
            x: GEOMETRY.sigLeftX,
            y: GEOMETRY.sigBottomY,
            width: ink.width * scale,
            height: ink.height * scale,
          });

          // --- Date.
          var dateText = formatSignedDate(opts.signedAt);
          if (dateText) {
            page.drawText(dateText, {
              x: GEOMETRY.dateLeftX,
              y: GEOMETRY.dateBaselineY + GEOMETRY.dateLift,
              size: GEOMETRY.dateSize,
              font: font,
              color: ink0,
            });
          }
          return doc.save();
        });
      });
    });
  }

  function suggestFilename(onboardingId) {
    var id = String(onboardingId || '').replace(/[^A-Za-z0-9._-]+/g, '_');
    return id
      ? 'Advisory_Agreement_' + id + '_signed.pdf'
      : 'Advisory_Agreement_signed.pdf';
  }

  // Build and hand the file to the browser. Returns a promise so callers can
  // show their own error text — this deliberately does not alert() on failure.
  function downloadSignedAgreement(opts, filename) {
    return buildSignedAgreement(opts).then(function (bytes) {
      var blob = new Blob([bytes], { type: 'application/pdf' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename || suggestFilename(opts && opts.onboardingId);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
  }

  global.BlueLineAgreementPdf = {
    build: buildSignedAgreement,
    download: downloadSignedAgreement,
    suggestFilename: suggestFilename,
    resolveClientName: resolveClientName,
    GEOMETRY: GEOMETRY,
  };
})(window);
