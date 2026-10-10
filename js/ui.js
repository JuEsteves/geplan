// Componentes e utilitários de interface compartilhados pelas telas.
import * as store from './store.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
export const I = {
  up: svg('<path d="m18 15-6-6-6 6"/>'),
  down: svg('<path d="m6 9 6 6 6-6"/>'),
  right: svg('<path d="m9 18 6-6-6-6"/>'),
  trash: svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
  more: svg('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
  alert: svg('<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'),
  upload: svg('<path d="M12 15V3M7 8l5-5 5 5M5 21h14"/>'),
  link: svg('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>'),
};

export const ui = {
  zoom: localStorage.getItem('planobras:zoom') || 'semana',
  showCrit: true, showBase: true,
  compFilter: '', orcFilter: '', vincFilter: 'todos', ativFilter: '', ativSoAlertas: false,
  curvaPeriodo: 'mes',
  statusDate: null,
  pendingFocus: null,
  expandidos: {},
};

export function toast(msg, ms = 3200) {
  const el = document.createElement('div');
  el.textContent = msg;
  document.getElementById('toast').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** Formulário em janela. Resolve com os valores ou null (cancelar). */
export function formDialog({ title, fields, ok = 'Salvar', text = '', html = '' }) {
  const dlg = document.getElementById('dlg');
  const field = (f) => {
    const attrs = `name="${f.name}" ${f.required ? 'required' : ''} ${f.step ? `step="${f.step}"` : ''} ${f.min != null ? `min="${f.min}"` : ''} ${f.list ? `list="${f.list}"` : ''} placeholder="${esc(f.placeholder || '')}"`;
    let input;
    if (f.type === 'select') input = `<select ${attrs}>${f.options.map((o) => `<option value="${esc(o.value)}" ${o.value === f.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    else if (f.type === 'checkbox') return `<label class="check"><input type="checkbox" name="${f.name}" ${f.value ? 'checked' : ''}> ${esc(f.label)}</label>`;
    else if (f.type === 'textarea') input = `<textarea ${attrs} rows="3">${esc(f.value ?? '')}</textarea>`;
    else input = `<input type="${f.type || 'text'}" value="${esc(f.value ?? '')}" ${attrs}>`;
    return `<label class="field">${esc(f.label)}${input}${f.hint ? `<span class="muted small" style="font-weight:400">${esc(f.hint)}</span>` : ''}</label>`;
  };
  dlg.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2>${text ? `<p class="muted">${esc(text)}</p>` : ''}${html}
    <div class="stack" style="margin-top:14px">${fields.map(field).join('')}</div>
    <div class="actions"><button type="button" class="btn" value="cancel">Cancelar</button><button class="btn primary" value="ok">${esc(ok)}</button></div></form>`;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; if (dlg.open) dlg.close(); resolve(v); };
    const form = dlg.querySelector('form');
    form.onsubmit = (e) => {
      e.preventDefault();
      if (e.submitter?.value !== 'ok') return finish(null);
      const fd = new FormData(form);
      const vals = Object.fromEntries(fd);
      for (const f of fields) if (f.type === 'checkbox') vals[f.name] = fd.has(f.name);
      finish(vals);
    };
    dlg.querySelector('button[value="cancel"]').onclick = () => finish(null);
    dlg.oncancel = () => finish(null);
    dlg.onclose = () => finish(null);
    dlg.showModal();
    dlg.querySelector('input, select, textarea')?.focus();
  });
}

/** Confirmação própria (o confirm() nativo é bloqueado em alguns navegadores embutidos). */
export function ask(message, ok = 'Confirmar') {
  const dlg = document.getElementById('dlg');
  dlg.innerHTML = `<form method="dialog"><h2>Confirmar</h2><p style="margin:12px 0 0;white-space:pre-line">${esc(message)}</p>
    <div class="actions"><button type="button" class="btn" value="cancel">Cancelar</button><button type="button" class="btn primary" value="ok">${esc(ok)}</button></div></form>`;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; if (dlg.open) dlg.close(); resolve(v); };
    dlg.querySelector('button[value="ok"]').onclick = () => finish(true);
    dlg.querySelector('button[value="cancel"]').onclick = () => finish(false);
    dlg.oncancel = () => finish(false);
    dlg.onclose = () => finish(false);
    dlg.showModal();
    dlg.querySelector('button[value="ok"]').focus();
  });
}

/** Janela só informativa. */
export function info(title, html) {
  const dlg = document.getElementById('dlg');
  dlg.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2><div style="margin-top:12px">${html}</div>
    <div class="actions"><button type="button" class="btn primary" value="ok">Fechar</button></div></form>`;
  return new Promise((resolve) => {
    const finish = () => { if (dlg.open) dlg.close(); resolve(); };
    dlg.querySelector('button[value="ok"]').onclick = finish;
    dlg.oncancel = finish;
    dlg.showModal();
  });
}

/* ---------- renderização ---------- */
let renderer = () => {};
export const setRenderer = (fn) => { renderer = fn; };
let renderQueued = false;
export function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; renderer(); }, 0);
}
export function commit(...docs) {
  docs.forEach((d) => store.touch(d));
  queueRender();
}

/** Número digitado (aceita vírgula). Vazio → null. */
export const parseNum = (v) => {
  if (v === '' || v == null) return null;
  let s = String(v).trim().replace(/\s|R\$|%/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // "1.040" = mil e quarenta
  const n = Number(s);
  return isNaN(n) ? null : n;
};

/** Número para campo de edição: vírgula decimal, sem separador de milhar ("1040", "10,3"). */
export const fmtIn = (n, dec = 4) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString('pt-BR', { useGrouping: false, maximumFractionDigits: dec }));
