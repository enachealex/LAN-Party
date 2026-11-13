// @ts-check
// Files people upload, served back from LAN Party's own origin: chat attachments (/uploads), the
// GIF library (/gifs), the soundboard (/sounds), entrance clips (/entrances) and feedback
// screenshots (/feedback-media).
//
// Anything served from this origin that a browser renders as a document runs with LAN Party's
// cookies, storage and API. An uploaded .html (or an .svg, which can carry script) opened from one
// of those paths would be a page of the uploader's choosing, running as whoever opened the link.
// Hosted apps make that easy to reach: a site framed inside LAN Party can open any url in a new
// tab. So two layers, each enough on its own for the common case:
//
//   serving  every file is sent with nosniff and a CSP that turns it into a sandboxed, scriptless
//            document should it ever be opened as one; anything that is not an image, audio, video
//            or plain text is sent as a download (Content-Disposition: attachment) and typed as
//            opaque bytes, so it is never rendered here at all. A CSP on an <img>, <audio> or
//            <video> response is ignored, so media still displays exactly as before.
//   upload   the four persistent libraries store a file under an extension chosen from the type
//            that was accepted (never the client's filename), so nothing in them is ever served as
//            html, xml, svg or script in the first place. Chat attachments keep their names: people
//            share all sorts of files there, and the serving layer is what covers them.
//
// Also here: the frame-ancestors directive every LAN Party response carries.

const path = require('path');
/** @type {any} express ships no types here, and only express.static (and its mime table) is used */
const express = require('express');

/** LAN Party may be framed by itself (the client frames its own /app-bundles) and by nothing else. */
const FRAME_ANCESTORS_SELF = "frame-ancestors 'self'";

/**
 * The frame-ancestors directive for this instance: 'self', plus every CLIENT_ORIGIN entry that is a
 * plain http(s) origin. Those are where this server's own client is configured to run (in
 * development, typically a Vite server on another port), and that client frames /app-bundles. A
 * malformed entry is left out rather than written into a security header.
 * @param {string[]} [configuredOrigins] the CLIENT_ORIGIN values ('*' already left out)
 */
function frameAncestorsDirective(configuredOrigins = []) {
  /** @type {string[]} */
  const extra = [];
  for (const entry of configuredOrigins) {
    try {
      const u = new URL(String(entry).trim());
      if ((u.protocol === 'https:' || u.protocol === 'http:') && u.origin !== 'null' && !extra.includes(u.origin)) extra.push(u.origin);
    } catch (_) { /* not an origin: nothing to allow */ }
  }
  return extra.length ? `${FRAME_ANCESTORS_SELF} ${extra.join(' ')}` : FRAME_ANCESTORS_SELF;
}

// Types a browser shows inline without ever running anything from them. text/plain is here because
// with nosniff it is only ever shown as text, which is how a shared log or note is expected to open.
const INLINE_TYPE = /^(image|audio|video)\/[a-z0-9.+-]+$/;
// Extensions the stores below produce that the bundled mime table does not know (it would call
// them application/octet-stream, and they would download instead of display).
const TYPE_OVERRIDES = /** @type {Record<string, string>} */ ({ '.avif': 'image/avif' });

/**
 * express.static for a folder of uploaded files, with the headers that keep any of them from ever
 * being active content on this origin (see the top of this file).
 * @param {string} dir
 * @param {string} frameAncestors from frameAncestorsDirective()
 * @param {Record<string, any>} [options] further express.static options
 */
function userFileStatic(dir, frameAncestors, options = {}) {
  const lookup = /** @type {(p: string) => string} */ ((p) => express.static.mime.lookup(p));
  return express.static(dir, {
    ...options,
    /** @param {any} res @param {string} filePath */
    setHeaders(res, filePath) {
      const override = TYPE_OVERRIDES[path.extname(filePath).toLowerCase()];
      const type = String(override || lookup(filePath) || '').split(';')[0].trim().toLowerCase();
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // sandbox with no allow-* at all: opened directly, even an SVG is an opaque-origin document
      // that runs no script. default-src 'none' stops it loading anything either.
      res.setHeader('Content-Security-Policy', `default-src 'none'; sandbox; ${frameAncestors}`);
      if (INLINE_TYPE.test(type) || type === 'text/plain') {
        if (override) res.setHeader('Content-Type', override);
        return;
      }
      // Typed here, so the static server does not type it from the extension (send only sets a
      // Content-Type that is not already there).
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment');
    },
  });
}

// --- What each library accepts, and the extension each accepted type is stored under ---
// Keyed by the declared mime type (parameters dropped, lower case). The *_EXTENSIONS tables are the
// fallback for a client that declares nothing useful (application/octet-stream is common for audio):
// the filename's extension, looked up the same way, so that what is stored is still one of a fixed
// set. Nothing here maps to html, xml, svg or script.

/** The shared GIF library: animated or still raster images. No SVG. */
const GIF_TYPES = Object.freeze({
  'image/gif': '.gif', 'image/png': '.png', 'image/apng': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/avif': '.avif',
});
/** Soundboard clips. */
const SOUND_TYPES = Object.freeze({
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3',
  'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav', 'audio/vnd.wave': '.wav',
  'audio/ogg': '.ogg', 'audio/opus': '.ogg',
  'audio/webm': '.weba',
  'audio/aac': '.aac', 'audio/x-aac': '.aac',
  'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/m4a': '.m4a',
  'audio/flac': '.flac', 'audio/x-flac': '.flac',
});
const SOUND_EXTENSIONS = Object.freeze({
  mp3: '.mp3', wav: '.wav', ogg: '.ogg', oga: '.oga', opus: '.ogg', weba: '.weba', aac: '.aac', m4a: '.m4a', flac: '.flac',
});
/** Entrance clips: what MediaRecorder produces (WebM, Ogg, or MP4 audio on Safari), or a file. */
const ENTRANCE_TYPES = Object.freeze({ ...SOUND_TYPES, 'audio/webm': '.webm', 'video/webm': '.webm' });
const ENTRANCE_EXTENSIONS = Object.freeze({ ...SOUND_EXTENSIONS, webm: '.webm' });
/** Screenshots attached to feedback. */
const FEEDBACK_IMAGE_TYPES = Object.freeze({
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif', 'image/bmp': '.bmp',
});

/**
 * The extension an uploaded file is to be stored under, or null when it is not one of the accepted
 * types. Never taken from the filename as such: only ever a value from `types` or `extensions`.
 * @param {{ mimetype?: string, originalname?: string }} file as multer describes it
 * @param {Readonly<Record<string, string>>} types declared mime type -> extension
 * @param {Readonly<Record<string, string>>} [extensions] filename extension -> extension, the fallback
 * @returns {string | null}
 */
function storedExtension(file, types, extensions = {}) {
  const mime = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
  if (Object.hasOwn(types, mime)) return types[mime];
  const ext = path.extname(String(file.originalname || '')).slice(1).toLowerCase();
  if (ext && Object.hasOwn(extensions, ext)) return extensions[ext];
  return null;
}

module.exports = {
  FRAME_ANCESTORS_SELF, frameAncestorsDirective, userFileStatic,
  GIF_TYPES, SOUND_TYPES, SOUND_EXTENSIONS, ENTRANCE_TYPES, ENTRANCE_EXTENSIONS, FEEDBACK_IMAGE_TYPES, storedExtension,
};
