// modal.js — minimal in-page modal replacing native alert/confirm/prompt.
// Exposes showAlert, showConfirm, showPrompt on window. Each returns a Promise.
// Markup target: <div id="modal-root" hidden></div> in index.html.

(function () {
  let activeClose = null;

  function ensureRoot() {
    let root = document.getElementById('modal-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'modal-root';
      root.hidden = true;
      document.body.appendChild(root);
    }
    return root;
  }

  function close(result, resolver) {
    const root = document.getElementById('modal-root');
    if (root) {
      root.innerHTML = '';
      root.hidden = true;
    }
    document.removeEventListener('keydown', activeClose && activeClose.keyHandler);
    activeClose = null;
    resolver(result);
  }

  function buildShell(title) {
    const root = ensureRoot();
    root.hidden = false;
    root.innerHTML = '';

    const backdrop = document.createElement('div');
    backdrop.style.cssText = [
      'position:fixed','inset:0','background:rgba(0,0,0,0.65)',
      'display:flex','align-items:center','justify-content:center',
      'z-index:1000','padding:16px',
    ].join(';');

    const panel = document.createElement('div');
    panel.style.cssText = [
      'background:var(--surface)','border:1px solid var(--border)',
      'border-radius:4px','min-width:320px','max-width:560px','width:100%',
      'max-height:90vh','overflow:auto','padding:16px','color:var(--text)',
      'font-family:inherit','font-size:13px','box-shadow:0 8px 24px rgba(0,0,0,0.5)',
    ].join(';');

    if (title) {
      const h = document.createElement('div');
      h.textContent = title;
      h.style.cssText = 'font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:var(--accent);margin-bottom:12px;';
      panel.appendChild(h);
    }

    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    return { root, backdrop, panel };
  }

  function makeButtonRow() {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px;';
    return row;
  }

  function makeButton(label, primary) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = [
      'font-family:inherit','font-size:12px','padding:6px 14px',
      'border-radius:3px','cursor:pointer','border:1px solid var(--border)',
      primary ? 'background:var(--accent);color:#1a1a1a;border-color:var(--accent);font-weight:600;'
              : 'background:var(--bg);color:var(--text);',
    ].join(';');
    return b;
  }

  function bindClose(backdrop, resolveWith) {
    const keyHandler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); resolveWith.cancel(); }
    };
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) resolveWith.cancel();
    });
    document.addEventListener('keydown', keyHandler);
    activeClose = { keyHandler };
  }

  // --- showAlert ---
  function showAlert(message, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const { backdrop, panel } = buildShell(opts.title || '');
      const body = document.createElement('div');
      body.textContent = message || '';
      body.style.cssText = 'white-space:pre-wrap;color:var(--text-bright);';
      panel.appendChild(body);

      const row = makeButtonRow();
      const ok = makeButton(opts.okLabel || 'OK', true);
      ok.addEventListener('click', () => close(undefined, resolve));
      row.appendChild(ok);
      panel.appendChild(row);

      bindClose(backdrop, { cancel: () => close(undefined, resolve) });
      setTimeout(() => ok.focus(), 0);
    });
  }

  // --- showConfirm ---
  function showConfirm(message, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const { backdrop, panel } = buildShell(opts.title || '');
      const body = document.createElement('div');
      body.textContent = message || '';
      body.style.cssText = 'white-space:pre-wrap;color:var(--text-bright);';
      panel.appendChild(body);

      const row = makeButtonRow();
      const cancel = makeButton(opts.cancelLabel || 'Cancel', false);
      const ok = makeButton(opts.okLabel || 'OK', true);
      cancel.addEventListener('click', () => close(false, resolve));
      ok.addEventListener('click', () => close(true, resolve));
      row.appendChild(cancel);
      row.appendChild(ok);
      panel.appendChild(row);

      bindClose(backdrop, { cancel: () => close(false, resolve) });
      setTimeout(() => ok.focus(), 0);
    });
  }

  // --- showPrompt ---
  // fields: [{name, label, type:'text'|'textarea'|'chips', default?, placeholder?, options?}]
  function showPrompt(spec) {
    spec = spec || {};
    const fields = spec.fields || [];
    return new Promise((resolve) => {
      const { backdrop, panel } = buildShell(spec.title || '');

      const inputs = {};
      const values = {};
      let firstInput = null;

      fields.forEach((f) => {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'margin-bottom:10px;';
        const lbl = document.createElement('div');
        lbl.textContent = f.label || f.name;
        lbl.style.cssText = 'font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim);margin-bottom:4px;';
        wrap.appendChild(lbl);

        if (f.type === 'textarea') {
          const ta = document.createElement('textarea');
          ta.value = f.default || '';
          ta.placeholder = f.placeholder || '';
          ta.rows = 5;
          ta.style.cssText = 'width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text-bright);padding:6px 8px;border-radius:3px;font-family:inherit;font-size:12px;resize:vertical;';
          ta.addEventListener('focus', () => { ta.style.outline = '1px solid var(--accent)'; ta.style.borderColor = 'var(--accent)'; });
          ta.addEventListener('blur', () => { ta.style.outline = 'none'; ta.style.borderColor = 'var(--border)'; });
          wrap.appendChild(ta);
          inputs[f.name] = () => ta.value;
          if (!firstInput) firstInput = ta;
        } else if (f.type === 'chips') {
          values[f.name] = f.default || (f.options && f.options[0]) || '';
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
          (f.options || []).forEach((opt) => {
            const c = document.createElement('button');
            c.type = 'button';
            c.textContent = opt;
            c.dataset.value = opt;
            const paint = () => {
              const active = values[f.name] === opt;
              c.style.cssText = [
                'font-family:inherit','font-size:11px','padding:4px 10px',
                'border-radius:12px','cursor:pointer',
                active ? 'background:var(--accent);color:#1a1a1a;border:1px solid var(--accent);font-weight:600;'
                       : 'background:var(--bg);color:var(--text);border:1px solid var(--border);',
              ].join(';');
            };
            paint();
            c.addEventListener('click', () => {
              values[f.name] = opt;
              row.querySelectorAll('button').forEach((btn) => {
                const a = values[f.name] === btn.dataset.value;
                btn.style.cssText = [
                  'font-family:inherit','font-size:11px','padding:4px 10px',
                  'border-radius:12px','cursor:pointer',
                  a ? 'background:var(--accent);color:#1a1a1a;border:1px solid var(--accent);font-weight:600;'
                    : 'background:var(--bg);color:var(--text);border:1px solid var(--border);',
                ].join(';');
              });
            });
            row.appendChild(c);
          });
          wrap.appendChild(row);
          inputs[f.name] = () => values[f.name];
        } else {
          const ip = document.createElement('input');
          ip.type = 'text';
          ip.value = f.default || '';
          ip.placeholder = f.placeholder || '';
          ip.style.cssText = 'width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text-bright);padding:6px 8px;border-radius:3px;font-family:inherit;font-size:12px;';
          ip.addEventListener('focus', () => { ip.style.outline = '1px solid var(--accent)'; ip.style.borderColor = 'var(--accent)'; });
          ip.addEventListener('blur', () => { ip.style.outline = 'none'; ip.style.borderColor = 'var(--border)'; });
          wrap.appendChild(ip);
          inputs[f.name] = () => ip.value;
          if (!firstInput) firstInput = ip;
        }

        panel.appendChild(wrap);
      });

      const collect = () => {
        const out = {};
        Object.keys(inputs).forEach((k) => { out[k] = inputs[k](); });
        return out;
      };

      const row = makeButtonRow();
      const cancel = makeButton(spec.cancelLabel || 'Cancel', false);
      const submit = makeButton(spec.submitLabel || 'OK', true);
      cancel.addEventListener('click', () => close(null, resolve));
      submit.addEventListener('click', () => close(collect(), resolve));
      row.appendChild(cancel);
      row.appendChild(submit);
      panel.appendChild(row);

      // Enter submits unless inside multiline textarea (use Shift+Enter for newline anyway)
      panel.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          if (e.target && e.target.tagName === 'TEXTAREA') {
            if (!(e.ctrlKey || e.metaKey)) return; // textarea: Enter inserts newline; Ctrl/Cmd+Enter submits
          }
          e.preventDefault();
          close(collect(), resolve);
        }
      });

      bindClose(backdrop, { cancel: () => close(null, resolve) });
      setTimeout(() => { if (firstInput) firstInput.focus(); else submit.focus(); }, 0);
    });
  }

  window.showAlert = showAlert;
  window.showConfirm = showConfirm;
  window.showPrompt = showPrompt;
})();
