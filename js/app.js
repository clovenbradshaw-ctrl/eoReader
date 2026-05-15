// app.js — boot. Wires the global state into the DOM after all modules load.

async function init() {
  loadSettings();
  if (typeof loadModelsSettings === 'function') loadModelsSettings();
  loadGraph();
  loadCustomFeeds();
  loadDreamCandidates();
  if (typeof hydrateQueue === 'function') hydrateQueue();
  customFeeds.forEach(f => SOURCES.push(f));
  renderSourcesList();
  renderLibrary();

  matrixRestoreSession().then(() => {
    if (mx.accessToken && mx.roomId) matrixLoadState().then(() => {
      renderLibrary();
      if (currentView === 'index') renderGraphPanel();
    });
  });

  // fetch RSS feeds in parallel
  const results = await Promise.all(SOURCES.map(fetchFeed));
  allItems = results.flat();
  hydrateProcessedFlags();
  renderItems();
  renderLibrary();
  if (typeof renderSummarizeLpList === 'function') renderSummarizeLpList();

  document.getElementById('search').addEventListener('input', applyFilters);

  // Resume any queue items that were running at shutdown — their walks
  // checkpoint per sentence so they pick up where they left off.
  if (typeof tickScheduler === 'function') tickScheduler();
  if (typeof updateProcessTabBadge === 'function') updateProcessTabBadge();
}

window.addEventListener('DOMContentLoaded', init);
