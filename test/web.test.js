'use strict';
const { temp } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createTerminal } = require('../server/app');
const data = require('../config/research-snapshot.json');
const built = fs.existsSync(path.join(__dirname, '..', 'web', '.output', 'public', '200.html'));

test('research snapshot: every item is sourced, graded, dated and bilingual', () => {
  const both = (o) => assert.ok(o && o.en && o.ar);
  const urls = (x) => assert.ok((x.urls || [x.url]).every((u) => /^https:/.test(u || '')), JSON.stringify(x));
  for (const x of data.macro) { both(x.label); urls(x); }
  for (const x of data.news) { both(x.title); both(x.why); urls(x); assert.ok(x.date <= data.asOf); }
  for (const x of data.catalysts) { both(x.label); urls(x); assert.ok(x.date >= data.asOf); }
  for (const x of data.trades) {
    urls(x);
    assert.ok(['new', 'add', 'trim', 'exit', 'buy', 'sell'].includes(x.dir) && 'VPMSU'.includes(x.ev) && x.size && x.ticker, JSON.stringify(x));
    if (x.filed) assert.ok(x.filed >= x.date, JSON.stringify(x));
  }
});

test('Nuxt interface: every inline script is allowed by hash, never by unsafe-inline', { skip: !built }, async () => {
  const t = createTerminal({ postgres: temp(), port: 0, env: {} });
  const port = await t.start();
  try {
    for (const p of ['/app/', '/app/research', '/app/sharia', '/app/alerts']) {
      const r = await fetch('http://127.0.0.1:' + port + p);
      assert.equal(r.status, 200, p);
      const html = await r.text();
      const script = /script-src ([^;]*)/.exec(r.headers.get('content-security-policy'))[1];
      assert.ok(!script.includes('unsafe-inline'));
      for (const m of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)) assert.ok(script.includes(crypto.createHash('sha256').update(m[1]).digest('base64')), p);
      const src = /src="(\/app\/_nuxt\/[^"]+)"/.exec(html)[1];
      assert.equal((await fetch('http://127.0.0.1:' + port + src)).status, 200);
    }
    assert.equal((await fetch('http://127.0.0.1:' + port + '/app/_nuxt/..%2f..%2f..%2fpackage.json')).ok, false);
    assert.equal((await (await fetch('http://127.0.0.1:' + port + '/api/research')).json()).asOf, data.asOf);
  } finally { await t.stop(); }
});
