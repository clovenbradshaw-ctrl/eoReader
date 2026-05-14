// feeds.js — RSS parsing + ingest (URL, file, paste). PDF.js used for .pdf.

function stripHTML(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.textContent || d.innerText || '';
}

function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d) ? null : d;
}

function fmtDate(d) {
  if (!d) return '';
  const now = new Date();
  const diff = now - d;
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return 'just now';
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  if (days < 7) return days + 'd ago';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function parseRSS(xml, source) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');
  const items = [];

  const rssItems = doc.querySelectorAll('item');
  if (rssItems.length > 0) {
    rssItems.forEach(item => {
      const title = item.querySelector('title')?.textContent?.trim() || '';
      const link = item.querySelector('link')?.textContent?.trim() || '';
      const desc = item.querySelector('description')?.textContent || '';
      const content = item.querySelector('content\\:encoded, encoded')?.textContent || desc;
      const bodyText = stripHTML(content);
      const pubDate = item.querySelector('pubDate')?.textContent || item.querySelector('dc\\:date, date')?.textContent || '';
      items.push({
        title, link,
        snippet: bodyText.slice(0, 600),
        body: bodyText,
        date: parseDate(pubDate),
        source: source.key,
        sourceName: source.name,
        sourceHome: source.home,
      });
    });
    return items;
  }

  const entries = doc.querySelectorAll('entry');
  entries.forEach(entry => {
    const title = entry.querySelector('title')?.textContent?.trim() || '';
    const linkEl = entry.querySelector('link[rel="alternate"], link');
    const link = linkEl?.getAttribute('href') || '';
    const summary = entry.querySelector('summary, content')?.textContent || '';
    const bodyText = stripHTML(summary);
    const published = entry.querySelector('published, updated')?.textContent || '';
    items.push({
      title, link,
      snippet: bodyText.slice(0, 600),
      body: bodyText,
      date: parseDate(published),
      source: source.key,
      sourceName: source.name,
      sourceHome: source.home,
    });
  });

  return items;
}

async function fetchFeed(source) {
  try {
    const resp = await fetch(PROXY + encodeURIComponent(source.url));
    if (!resp.ok) throw new Error(resp.status);
    const text = await resp.text();
    const items = parseRSS(text, source);
    loadedCount++;
    return items;
  } catch (e) {
    errorCount++;
    console.warn(`Failed: ${source.name}`, e);
    return [];
  }
}

// --- PDF extraction (uses pdfjs-dist via CDN, loaded lazily) ---
let _pdfjsPromise = null;
function loadPdfJs() {
  if (_pdfjsPromise) return _pdfjsPromise;
  _pdfjsPromise = new Promise((resolve, reject) => {
    if (window.pdfjsLib) { resolve(window.pdfjsLib); return; }
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload = () => {
      if (!window.pdfjsLib) { reject(new Error('PDF.js did not register on window')); return; }
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      resolve(window.pdfjsLib);
    };
    s.onerror = () => reject(new Error('Failed to load PDF.js'));
    document.head.appendChild(s);
  });
  return _pdfjsPromise;
}

async function extractPdfText(arrayBuffer) {
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const chunks = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map(it => it.str).join(' ');
    chunks.push(text);
  }
  return chunks.join('\n\n').replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

async function ingestUrl() {
  const urlInput = document.getElementById('url-ingest');
  const url = urlInput.value.trim();
  if (!url) return;

  const statusEl = document.getElementById('ingest-status');
  statusEl.textContent = 'fetching...';

  try {
    const resp = await fetch(PROXY + encodeURIComponent(url));
    if (!resp.ok) throw new Error('fetch failed: ' + resp.status);
    const html = await resp.text();

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const title = doc.querySelector('title')?.textContent?.trim() ||
      doc.querySelector('h1')?.textContent?.trim() || url;
    const contentEl = doc.querySelector('article') || doc.querySelector('main') || doc.querySelector('.post-content') || doc.body;
    const body = contentEl?.textContent?.replace(/\s+/g, ' ')?.trim() || '';

    if (body.length < 50) { statusEl.textContent = 'too little content extracted'; return; }

    addSource(title, url, new URL(url).hostname, body);
    urlInput.value = '';
    statusEl.textContent = '✓ ingested (' + body.length + ' chars)';
    setTimeout(() => { statusEl.textContent = ''; }, 3000);

  } catch (e) {
    statusEl.textContent = '✗ ' + e.message;
    setTimeout(() => { statusEl.textContent = ''; }, 5000);
  }
}

function ingestFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById('ingest-status');

  const isPdf = file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';
  const isHtml = file.name.endsWith('.html') || file.name.endsWith('.htm');

  if (isPdf) {
    statusEl.textContent = 'loading pdf...';
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const text = await extractPdfText(e.target.result);
        if (!text || text.length < 50) {
          statusEl.textContent = '✗ no extractable text in PDF';
          setTimeout(() => { statusEl.textContent = ''; }, 5000);
          return;
        }
        addSource(file.name.replace(/\.pdf$/i, ''), null, 'file: ' + file.name, text);
        statusEl.textContent = '✓ ' + file.name + ' (' + text.length + ' chars)';
        setTimeout(() => { statusEl.textContent = ''; }, 3000);
      } catch (err) {
        console.error('PDF extraction failed:', err);
        statusEl.textContent = '✗ pdf error: ' + err.message;
        setTimeout(() => { statusEl.textContent = ''; }, 5000);
      }
      event.target.value = '';
    };
    reader.onerror = () => {
      statusEl.textContent = '✗ file read failed';
      setTimeout(() => { statusEl.textContent = ''; }, 3000);
    };
    reader.readAsArrayBuffer(file);
    return;
  }

  const reader = new FileReader();
  reader.onload = function(e) {
    let body = e.target.result;
    if (isHtml) {
      const doc = new DOMParser().parseFromString(body, 'text/html');
      body = doc.body?.textContent?.replace(/\s+/g, ' ')?.trim() || body;
    }
    addSource(file.name.replace(/\.\w+$/, ''), null, 'file: ' + file.name, body);
    statusEl.textContent = '✓ ' + file.name + ' ingested';
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
    event.target.value = '';
  };
  reader.readAsText(file);
}

async function ingestPaste() {
  const res = await showPrompt({
    title: 'Ingest pasted text',
    submitLabel: 'Ingest',
    fields: [
      { name: 'text', label: 'Text', type: 'textarea', placeholder: 'Paste article body, transcript, etc.' },
      { name: 'title', label: 'Title', type: 'text', placeholder: 'Source title' },
    ],
  });
  if (!res) return;
  const text = (res.text || '').trim();
  if (text.length < 20) {
    await showAlert('Text is too short to ingest (need at least 20 characters).');
    return;
  }
  const title = (res.title || '').trim() || text.slice(0, 60) + '...';
  addSource(title, null, 'paste', text);
  document.getElementById('ingest-status').textContent = '✓ pasted text ingested';
  setTimeout(() => { document.getElementById('ingest-status').textContent = ''; }, 3000);
}
