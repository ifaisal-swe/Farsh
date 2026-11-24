'use strict';
/** The built Nuxt page and the CSP hashes of its inline scripts (no 'unsafe-inline' for scripts). */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const WEB = path.join(__dirname, '..', 'web', '.output', 'public'); // npm run web:build
const ASSETS = '/app/_nuxt';

function webPage() {
  try {
    const html = fs.readFileSync(path.join(WEB, '200.html'), 'utf8');
    const hashes = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
    return { html, hashes: [...new Set(hashes)].join(' ') };
  } catch { return null; }
}

/** Sends the page; the response must already carry a CSP with "script-src 'self'". */
function sendWebPage(req, res) {
  const page = webPage();
  if (!page) return res.status(503).type('text').send('The Nuxt interface is not built. Run: npm run web:build');
  res.set('Content-Security-Policy', String(res.get('Content-Security-Policy')).replace("script-src 'self'", `script-src 'self' ${page.hashes}`));
  return res.type('html').send(page.html);
}

/** File names contain a content hash, so browsers may keep them. They hold only interface code and fonts. */
const webAssets = () => [express.static(path.join(WEB, 'app', '_nuxt'), { index: false, setHeaders: (res) => res.set('Cache-Control', 'public, max-age=31536000, immutable') }), (req, res) => res.status(404).type('text').send('Not found')];

/** The public brand kit (logos, guidelines). Names carry no hash, so browsers re-check daily. */
const brandAssets = () => [express.static(path.join(WEB, 'brand'), { index: false, setHeaders: (res) => res.set('Cache-Control', 'public, max-age=86400') }), (req, res) => res.status(404).type('text').send('Not found')];

module.exports = { webPage, sendWebPage, webAssets, brandAssets, ASSETS };
