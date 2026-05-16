// matrix.js — Matrix client + persistence layer.
// All globals exposed: matrix* functions, mxApi, setMxStatus, updateMxIndicator,
// scheduleMatrixSave, MX_* constants.

const MX_ROOM_TYPE = 'io.groundtruth.plaintext.graph';
const MX_EO_BATCH = 'io.groundtruth.eo.batch';
const MX_EO_STATE = 'io.groundtruth.eo.state';

function mxApi(method, path, body, retries) {
  retries = retries || 0;
  const opts = {
    method,
    headers: { 'Authorization': 'Bearer ' + mx.accessToken, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  return fetch(mx.homeserver + '/_matrix/client/v3' + path, opts)
    .then(r => r.json())
    .then(data => {
      if (data.errcode === 'M_LIMIT_EXCEEDED' && retries < 3) {
        const wait = (data.retry_after_ms || 5000) + 1000;
        console.warn('Rate limited, retrying in', wait, 'ms');
        return new Promise(resolve => setTimeout(resolve, wait)).then(() => mxApi(method, path, body, retries + 1));
      }
      return data;
    })
    .catch(err => {
      if (retries < 2) {
        console.warn('Matrix request failed, retrying...', err);
        return new Promise(resolve => setTimeout(resolve, 2000)).then(() => mxApi(method, path, body, retries + 1));
      }
      throw err;
    });
}

// Which status element login feedback is routed to — the settings-panel
// form ('mx-status') or the full-screen gate ('gate-mx-status').
let mxActiveStatusEl = 'mx-status';

function setMxStatus(msg, isError) {
  const el = document.getElementById(mxActiveStatusEl) || document.getElementById('mx-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#c06060' : 'var(--text-dim)';
}

// --- login gate: the app is unusable until Matrix is connected ---
function showMxGate() {
  const g = document.getElementById('mx-gate');
  if (g) g.classList.remove('hidden');
}
function hideMxGate() {
  const g = document.getElementById('mx-gate');
  if (g) g.classList.add('hidden');
}

function updateMxIndicator() {
  const el = document.getElementById('matrix-status');
  if (!el) return;
  if (mx.accessToken && mx.roomId) {
    el.innerHTML = '<i class="ph ph-plugs-connected"></i> matrix';
    el.className = 'matrix-indicator connected';
  } else if (mx.accessToken) {
    el.innerHTML = '<i class="ph ph-plug"></i> matrix';
    el.className = 'matrix-indicator connected';
  } else {
    el.innerHTML = '<i class="ph ph-plugs"></i> matrix';
    el.className = 'matrix-indicator disconnected';
  }
}

// --- media JSON helpers ---
// Use application/octet-stream so homeservers that reject 'application/json'
// uploads (most of them) accept the payload. The body is still JSON text.
async function matrixUploadJson(data, filename) {
  try {
    const json = JSON.stringify(data);
    const resp = await fetch(mx.homeserver + '/_matrix/media/v3/upload?filename=' + encodeURIComponent(filename), {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + mx.accessToken,
        'Content-Type': 'application/octet-stream',
      },
      body: json,
    });
    const result = await resp.json();
    return result.content_uri || null;
  } catch (e) {
    console.warn('Media upload failed:', e);
    return null;
  }
}

async function matrixDownloadJson(mxcUri) {
  try {
    const parts = mxcUri.replace('mxc://', '').split('/');
    const url = mx.homeserver + '/_matrix/media/v3/download/' + parts[0] + '/' + parts[1];
    const resp = await fetch(url, { headers: { 'Authorization': 'Bearer ' + mx.accessToken } });
    const text = await resp.text();
    try { return JSON.parse(text); } catch (e) { return null; }
  } catch (e) {
    console.warn('Media download failed:', e);
    return null;
  }
}

// --- full-state save/load (graph + sources + event log) ---
async function matrixSaveFullState() {
  if (!mx.accessToken || !mx.roomId) return;
  try {
    const graphData = { entities: graph.entities, connections: graph.connections, savedAt: new Date().toISOString() };
    const graphJson = JSON.stringify(graphData);
    if (graphJson.length < 60000) {
      await mxApi('PUT', '/rooms/' + encodeURIComponent(mx.roomId) + '/state/io.groundtruth.plaintext.graph/', graphData);
    } else {
      const mxcUri = await matrixUploadJson(graphData, 'plaintext-graph.json');
      if (mxcUri) {
        await mxApi('PUT', '/rooms/' + encodeURIComponent(mx.roomId) + '/state/io.groundtruth.plaintext.graph/', {
          mediaUri: mxcUri,
          siteCount: Object.keys(graph.entities).length,
          connectionCount: graph.connections.length,
          savedAt: new Date().toISOString(),
        });
      }
    }

    if (sources.length > 0) {
      const mxcUri = await matrixUploadJson(sources, 'plaintext-sources.json');
      await mxApi('PUT', '/rooms/' + encodeURIComponent(mx.roomId) + '/state/io.groundtruth.plaintext.sources/', {
        mediaUri: mxcUri || null,
        count: sources.length,
        index: sources.map(s => ({ id: s.id, title: s.title, url: s.url, processed: s.processed })),
        savedAt: new Date().toISOString(),
      });
    }

    // event log — always via media (can grow large)
    if (eventLog.length > 0) {
      const mxcUri = await matrixUploadJson({ events: eventLog, savedAt: new Date().toISOString() }, 'plaintext-eventlog.json');
      if (mxcUri) {
        await mxApi('PUT', '/rooms/' + encodeURIComponent(mx.roomId) + '/state/io.groundtruth.plaintext.eventlog/', {
          mediaUri: mxcUri,
          count: eventLog.length,
          savedAt: new Date().toISOString(),
        });
      }
    }
    console.log('Matrix save complete:', Object.keys(graph.entities).length, 'sites,', sources.length, 'sources,', eventLog.length, 'events');
  } catch (e) {
    console.error('Matrix save failed:', e);
  }
}

async function matrixLoadState() {
  if (!mx.accessToken || !mx.roomId) return;

  // graph
  try {
    const gs = await mxApi('GET', '/rooms/' + encodeURIComponent(mx.roomId) + '/state/io.groundtruth.plaintext.graph/');
    if (gs && !gs.errcode) {
      let payload = gs;
      if (gs.mediaUri) payload = await matrixDownloadJson(gs.mediaUri) || gs;
      if (payload && payload.entities) {
        graph.entities = payload.entities;
        graph.connections = payload.connections || [];
        updateGraphCount();
        console.log('Restored graph from Matrix:', Object.keys(graph.entities).length, 'sites');
      }
    }
  } catch (e) { console.warn('No graph state in Matrix'); }

  // sources — pull bodies from media when present, fall back to local
  try {
    const ss = await mxApi('GET', '/rooms/' + encodeURIComponent(mx.roomId) + '/state/io.groundtruth.plaintext.sources/');
    if (ss && !ss.errcode) {
      let remote = null;
      if (ss.mediaUri) remote = await matrixDownloadJson(ss.mediaUri);
      const list = remote || ss.sources || ss.index || [];
      const localUrls = new Set(sources.map(s => s.url || s.title));
      list.forEach(s => {
        if (!localUrls.has(s.url || s.title)) sources.push(s);
      });
      console.log('Restored sources from Matrix:', sources.length);
    }
  } catch (e) { console.warn('No sources state in Matrix'); }

  // event log
  try {
    const ls = await mxApi('GET', '/rooms/' + encodeURIComponent(mx.roomId) + '/state/io.groundtruth.plaintext.eventlog/');
    if (ls && !ls.errcode) {
      let remote = null;
      if (ls.mediaUri) remote = await matrixDownloadJson(ls.mediaUri);
      const evs = (remote && remote.events) || ls.events;
      if (Array.isArray(evs) && evs.length) {
        const seen = new Set(eventLog.map(e => e.hash));
        for (const ev of evs) if (!seen.has(ev.hash)) eventLog.push(ev);
        eventLog.sort((a, b) => a.ts - b.ts);
        console.log('Restored event log from Matrix:', eventLog.length, 'events');
      }
    }
  } catch (e) { console.warn('No event log in Matrix'); }

  saveGraph();
}

let matrixSaveTimer = null;
function scheduleMatrixSave() {
  if (matrixSaveTimer) clearTimeout(matrixSaveTimer);
  matrixSaveTimer = setTimeout(() => {
    matrixSaveFullState().catch(e => console.warn('Matrix auto-save failed', e));
  }, 30000);
}

// --- login / rooms ---
// prefix '' = settings-panel form, 'gate-' = full-screen login gate.
async function matrixLogin(prefix) {
  prefix = prefix || '';
  mxActiveStatusEl = prefix + 'mx-status';
  const hsInput = document.getElementById(prefix + 'mx-homeserver').value.trim();
  const user = document.getElementById(prefix + 'mx-user').value.trim();
  const pass = document.getElementById(prefix + 'mx-pass').value;
  if (!hsInput || !user || !pass) { setMxStatus('fill all fields', true); return; }

  let hs = hsInput;
  if (!hs.startsWith('http')) hs = 'https://' + hs;
  hs = hs.replace(/\/+$/, '');

  setMxStatus('connecting...');

  try {
    let baseUrl = hs;
    try {
      const wk = await fetch(hs + '/.well-known/matrix/client').then(r => r.json());
      if (wk['m.homeserver'] && wk['m.homeserver'].base_url) {
        baseUrl = wk['m.homeserver'].base_url.replace(/\/+$/, '');
      }
    } catch (e) {}

    const loginResp = await fetch(baseUrl + '/_matrix/client/v3/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: user },
        password: pass,
      }),
    }).then(r => r.json());

    if (loginResp.errcode) { setMxStatus(loginResp.error || loginResp.errcode, true); return; }

    mx.homeserver = baseUrl;
    mx.accessToken = loginResp.access_token;
    mx.userId = loginResp.user_id;

    localStorage.setItem('mx_homeserver', baseUrl);
    localStorage.setItem('mx_access_token', mx.accessToken);
    localStorage.setItem('mx_user_id', mx.userId);
    localStorage.setItem('mx_hs_display', hsInput);

    setMxStatus('logged in, finding room...');
    await matrixFindOrCreateRoom();
    showMxConnected();

    if (mx.roomId) {
      setMxStatus('loading your graph...');
      await matrixLoadState();
      if (typeof renderLibrary === 'function') renderLibrary();
      if (typeof renderEntityList === 'function') renderEntityList();
      if (typeof currentView !== 'undefined' && currentView === 'index' &&
          typeof renderGraphPanel === 'function') renderGraphPanel();
      setMxStatus('');
    }

  } catch (e) {
    console.error('Matrix login error:', e);
    setMxStatus('connection failed: ' + e.message, true);
  }
}

async function matrixFindOrCreateRoom() {
  const joined = await mxApi('GET', '/joined_rooms');
  if (!joined.joined_rooms) return;

  for (const roomId of joined.joined_rooms) {
    try {
      const state = await mxApi('GET', '/rooms/' + encodeURIComponent(roomId) + '/state/' + MX_ROOM_TYPE);
      if (state && !state.errcode) {
        mx.roomId = roomId;
        localStorage.setItem('mx_room_id', roomId);
        return;
      }
    } catch (e) {}
  }

  setMxStatus('creating graph room...');
  const createResp = await mxApi('POST', '/createRoom', {
    name: '{plain text} graph',
    topic: 'EO event graph for {plain text} digest',
    preset: 'private_chat',
    initial_state: [
      { type: MX_ROOM_TYPE, state_key: '', content: { version: 1, created: new Date().toISOString(), format: 'eo-graph' } },
    ],
  });
  if (createResp.errcode) {
    setMxStatus('room creation failed: ' + (createResp.error || createResp.errcode), true);
    return;
  }
  mx.roomId = createResp.room_id;
  localStorage.setItem('mx_room_id', mx.roomId);
}

function showMxConnected() {
  document.getElementById('matrix-login-form').style.display = 'none';
  document.getElementById('matrix-connected').style.display = 'block';
  document.getElementById('mx-connected-info').textContent = mx.userId;
  document.getElementById('mx-room-info').textContent = mx.roomId ? 'active: ' + mx.roomId : 'no room selected';
  updateMxIndicator();
  matrixListRooms();
  // The hard gate only lifts once we have both a session and a room.
  if (mx.accessToken && mx.roomId) hideMxGate();
  else showMxGate();
}

async function matrixListRooms() {
  const el = document.getElementById('mx-room-list');
  if (!el || !mx.accessToken) return;
  el.innerHTML = '<span style="color:var(--text-dim);font-size:10px;">scanning...</span>';

  try {
    const joined = await mxApi('GET', '/joined_rooms');
    if (!joined.joined_rooms) { el.innerHTML = ''; return; }

    const rooms = [];
    for (const roomId of joined.joined_rooms) {
      try {
        const state = await mxApi('GET', '/rooms/' + encodeURIComponent(roomId) + '/state/' + MX_ROOM_TYPE);
        if (state && !state.errcode) {
          let name = roomId;
          try {
            const nameState = await mxApi('GET', '/rooms/' + encodeURIComponent(roomId) + '/state/m.room.name/');
            if (nameState && nameState.name) name = nameState.name;
          } catch (e) {}
          rooms.push({ id: roomId, name: name, active: roomId === mx.roomId });
        }
      } catch (e) {}
    }

    if (!rooms.length) {
      el.innerHTML = '<div style="color:var(--text-dim);font-size:10px;">no research rooms found</div>';
      return;
    }

    el.innerHTML = rooms.map(r =>
      '<div class="lp-item' + (r.active ? ' active' : '') + '" onclick="matrixSwitchRoom(\'' + escapeAttr(r.id) + '\')" style="font-size:10px;">' +
        '<i class="ph ph-' + (r.active ? 'folder-open' : 'folder') + '" style="color:var(--accent);"></i> ' +
        '<span class="lp-title">' + escapeAttr(r.name) + '</span>' +
      '</div>'
    ).join('');

  } catch (e) {
    el.innerHTML = '<span style="color:#c06060;font-size:10px;">error listing rooms</span>';
  }
}

async function matrixSwitchRoom(roomId) {
  await matrixSaveFullState().catch(() => {});

  mx.roomId = roomId;
  localStorage.setItem('mx_room_id', roomId);

  graph.entities = {};
  graph.connections = [];
  sources = [];
  eventLog = [];
  saveGraph();

  await matrixLoadState();
  renderEntityList();
  renderLibrary();
  if (currentView === 'index') renderGraphPanel();
  showMxConnected();
}

async function matrixCreateNewRoom() {
  const nameInput = document.getElementById('mx-new-room-name');
  const name = nameInput.value.trim() || '{plain text} research';

  try {
    const createResp = await mxApi('POST', '/createRoom', {
      name: name,
      topic: 'EO research room for {plain text}',
      preset: 'private_chat',
      initial_state: [
        { type: MX_ROOM_TYPE, state_key: '', content: { version: 1, created: new Date().toISOString(), format: 'plaintext-research' } },
      ],
    });
    if (createResp.errcode) { await showAlert('Room creation failed: ' + (createResp.error || createResp.errcode)); return; }
    nameInput.value = '';
    await matrixSwitchRoom(createResp.room_id);
  } catch (e) {
    await showAlert('Room creation failed: ' + e.message);
  }
}

function matrixLogout() {
  if (mx.accessToken) mxApi('POST', '/logout', {}).catch(() => {});
  mx = { homeserver: null, accessToken: null, userId: null, roomId: null };
  localStorage.removeItem('mx_homeserver');
  localStorage.removeItem('mx_access_token');
  localStorage.removeItem('mx_user_id');
  localStorage.removeItem('mx_room_id');
  localStorage.removeItem('mx_hs_display');

  document.getElementById('matrix-login-form').style.display = 'block';
  document.getElementById('matrix-connected').style.display = 'none';
  document.getElementById('mx-homeserver').value = '';
  document.getElementById('mx-user').value = '';
  document.getElementById('mx-pass').value = '';
  setMxStatus('');
  updateMxIndicator();
  showMxGate();
}

async function matrixRestoreSession() {
  const hs = localStorage.getItem('mx_homeserver');
  const token = localStorage.getItem('mx_access_token');
  const userId = localStorage.getItem('mx_user_id');
  const roomId = localStorage.getItem('mx_room_id');
  const hsDisplay = localStorage.getItem('mx_hs_display');

  if (!hs || !token || !userId) { updateMxIndicator(); showMxGate(); return; }

  mx.homeserver = hs;
  mx.accessToken = token;
  mx.userId = userId;
  mx.roomId = roomId;

  try {
    const whoami = await mxApi('GET', '/account/whoami');
    if (whoami.errcode) { matrixLogout(); return; }
    if (!mx.roomId) await matrixFindOrCreateRoom();
    if (hsDisplay) document.getElementById('mx-homeserver').value = hsDisplay;
    showMxConnected();
  } catch (e) {
    matrixLogout();
  }
}

async function matrixSendEoBatch(events, sourceInfo) {
  if (!mx.accessToken || !mx.roomId) return null;
  const txnId = 'm' + Date.now() + '.' + Math.random().toString(36).slice(2, 8);
  return mxApi('PUT', '/rooms/' + encodeURIComponent(mx.roomId) + '/send/' + MX_EO_BATCH + '/' + txnId, {
    events: events,
    source: sourceInfo,
    batch_ts: Date.now(),
  });
}
