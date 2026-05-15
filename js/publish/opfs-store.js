// opfs-store.js — Origin Private File System cache for downloaded JSONL logs and
// folded snapshots. Sites data can grow large, so OPFS is preferred over IndexedDB.
// Falls back to an in-memory map when OPFS is unavailable.
(function (root) {
  'use strict';

  var rootPromise = null;
  var mem = {};
  var hasOPFS = typeof navigator !== 'undefined' && navigator.storage &&
    typeof navigator.storage.getDirectory === 'function';

  function dir() {
    if (!rootPromise) rootPromise = navigator.storage.getDirectory();
    return rootPromise;
  }

  // OPFS exposes a flat-per-directory API; flatten "articles/x.jsonl".
  function flat(name) { return name.replace(/\//g, '__'); }

  async function writeText(name, text) {
    if (!hasOPFS) { mem[name] = text; return; }
    try {
      var d = await dir();
      var fh = await d.getFileHandle(flat(name), { create: true });
      var w = await fh.createWritable();
      await w.write(text);
      await w.close();
    } catch (e) { mem[name] = text; }
  }

  async function readText(name) {
    if (!hasOPFS) return Object.prototype.hasOwnProperty.call(mem, name) ? mem[name] : null;
    try {
      var d = await dir();
      var fh = await d.getFileHandle(flat(name));
      var f = await fh.getFile();
      return await f.text();
    } catch (e) {
      return Object.prototype.hasOwnProperty.call(mem, name) ? mem[name] : null;
    }
  }

  async function remove(name) {
    delete mem[name];
    if (!hasOPFS) return;
    try { (await dir()).removeEntry(flat(name)); } catch (e) {}
  }

  async function getJSON(name) {
    var t = await readText(name);
    if (!t) return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  }

  function setJSON(name, obj) { return writeText(name, JSON.stringify(obj)); }

  root.opfsStore = {
    hasOPFS: hasOPFS, writeText: writeText, readText: readText,
    remove: remove, getJSON: getJSON, setJSON: setJSON,
  };
})(typeof window !== 'undefined' ? window : this);
