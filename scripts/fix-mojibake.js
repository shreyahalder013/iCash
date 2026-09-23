/* eslint-disable */
// Scans frontend files for Windows-1252 mojibake (UTF-8 bytes mis-decoded as
// Win-1252 and re-saved). Only reports; use --fix to repair.
//
// Safe conversion heuristic: find maximal runs of >= 2 "suspicious" characters
// (chars whose Win-1252 byte value is >= 0x80), re-encode the run to raw bytes
// via Latin-1, and accept the conversion ONLY if the bytes form valid UTF-8
// that decodes to sensible text. Legitimate standalone punctuation (…, —, •,
// curly quotes) forms single-char runs or invalid byte sequences and is kept.
const fs = require('fs');
const path = require('path');

const FILES = [
  'frontend/script.js',
  'frontend/biometric.js',
  'frontend/style.css',
  'frontend/accessibility.js',
  'frontend/voice-banking.js',
  'frontend/index.html',
  'frontend/config.js',
  'frontend/lib/appwrite.js',
];

// Windows-1252 high codepoint → original byte value (chars above U+00FF)
const WIN1252_TO_BYTE = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

// Chars whose Windows-1252 byte value is >= 0x80 (i.e. possible mojibake bytes)
function isSuspicious(ch) {
  const c = ch.codePointAt(0);
  if (c >= 0x80 && c <= 0xff) return true; // Latin-1 supplement + C1 controls
  return WIN1252_TO_BYTE[c] !== undefined;
}

function latin1Bytes(str) {
  const bytes = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c <= 0xff) {
      bytes.push(c);
    } else if (WIN1252_TO_BYTE[c] !== undefined) {
      bytes.push(WIN1252_TO_BYTE[c]);
    } else {
      return null; // not representable as a single byte
    }
  }
  return Buffer.from(bytes);
}

function isValidUtf8(buf) {
  try {
    const decoded = buf.toString('utf8');
    // Round-trip check: re-encoding the decoded text must reproduce the bytes
    return Buffer.from(decoded, 'utf8').equals(buf) ? decoded : null;
  } catch (_) {
    return null;
  }
}

function fixMojibake(text) {
  let out = '';
  let i = 0;
  let fixes = 0;
  while (i < text.length) {
    if (isSuspicious(text[i])) {
      let j = i;
      while (j < text.length && isSuspicious(text[j])) j++;
      const run = text.slice(i, j);
      if (run.length >= 2) {
        const bytes = latin1Bytes(run);
        const decoded = bytes ? isValidUtf8(bytes) : null;
        if (decoded && decoded.length >= 1) {
          out += decoded;
          fixes++;
          i = j;
          continue;
        }
      }
      out += run;
      i = j;
    } else {
      out += text[i];
      i++;
    }
  }
  return { text: out, fixes };
}

const doFix = process.argv.includes('--fix');
let totalFixes = 0;
for (const rel of FILES) {
  const full = path.join(__dirname, '..', rel);
  if (!fs.existsSync(full)) continue;
  const original = fs.readFileSync(full, 'utf8');
  const { text, fixes } = fixMojibake(original);
  const hasMojibakeLeft = fixMojibake(text).fixes;
  if (fixes > 0) {
    totalFixes += fixes;
    console.log(`${rel}: ${fixes} mojibake runs${doFix ? ' (fixed)' : ''}, ${hasMojibakeLeft} remaining after pass`);
    if (doFix) fs.writeFileSync(full, text, 'utf8');
  } else {
    console.log(`${rel}: clean`);
  }
}
console.log(doFix ? `DONE. Total runs fixed: ${totalFixes}` : `Total mojibake runs found: ${totalFixes} (run with --fix to repair)`);
