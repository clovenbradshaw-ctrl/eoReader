// api.js — n8n publishing client + raw GitHub reads for the {plain text} system.
// Writes go through the authenticated n8n webhooks; public reads bypass n8n
// entirely via raw.githubusercontent.com.
(function (root) {
  'use strict';

  var N8N = 'https://n8n.intelechia.com/webhook';
  var TOKEN = 'Provoking0-Cranium7-Penpal4-Childlike0-Uranium9';
  var RAW = 'https://raw.githubusercontent.com/clovenbradshaw-ctrl/plain-text/main';

  async function withRetry(fn) {
    var delay = 2000;
    for (var i = 0; i < 4; i++) {
      try { return await fn(); }
      catch (e) {
        if (i === 3) throw e;
        await new Promise(function (r) { setTimeout(r, delay); });
        delay *= 2;
      }
    }
  }

  function post(path, body) {
    return withRetry(async function () {
      var r = await fetch(N8N + path, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(path + ' ' + r.status);
      return r.json();
    });
  }

  // Append one line to the log. `filename` is passed through for the n8n
  // workflow; the file is created on first append. The server adds `ts`.
  function publish(filename, entry) {
    var body = { filename: filename };
    for (var k in entry) if (entry.hasOwnProperty(k)) body[k] = entry[k];
    return post('/site/publish', body);
  }

  // Public read — raw GitHub, no auth. Returns null on 404 (file not yet created).
  async function readRaw(filename) {
    var r = await fetch(RAW + '/' + filename + '?t=' + Date.now(), { cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('read ' + filename + ' ' + r.status);
    return r.text();
  }

  root.PublishAPI = {
    publish: publish, readRaw: readRaw, N8N: N8N, RAW: RAW,
  };
})(typeof window !== 'undefined' ? window : this);
