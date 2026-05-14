// app.js — boot. Wires the global state into the DOM after all modules load.

async function init() {
  loadSettings();
  loadGraph();
  loadCustomFeeds();
  loadDreamCandidates();
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

  document.getElementById('search').addEventListener('input', applyFilters);
}

window.addEventListener('DOMContentLoaded', init);
