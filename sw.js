/* Klarkommen – Service Worker (spec/01 §C.7, Skill §5a)
   - Shell-Cache "kk-shell-<VERSION>": index, JSON, Fonts, brand/, Experimente – network-first
   - Medien-Cache "kk-medien" (ohne Version): alles aus medien.json – cache-first,
     Range-Anfragen werden aus dem Cache als 206 beantwortet (iOS-Audio).
   Bei jedem App-Update VERSION hochzählen (und APP_VERSION in index.html). */
const VERSION = 'v18';
const SHELL = 'kk-shell-' + VERSION;
const MEDIEN = 'kk-medien';
const CORE = [
  './', 'index.html', 'manifest.webmanifest', 'medien.json',
  'brand/brand.json', 'brand/start.webp', 'brand/rubrik/rubrik-einstieg.webp', 'brand/rubrik/rubrik-brainfact.webp', 'brand/rubrik/rubrik-mindhack.webp', 'brand/rubrik/rubrik-mission.webp', 'brand/rubrik/rubrik-quellen.webp', 'brand/icons/zw-kettenglied.webp', 'brand/icons/zw-anker.webp', 'brand/icons/zw-wegweiser.webp', 'brand/icons/bonus-schatztruhe.webp', 'brand/icons/zzz.webp', 'brand/icon-192.png', 'brand/icon-512.png', 'brand/icon-maskable-512.png', 'brand/apple-touch-icon.png',
  'brand/getcon/hero.webp', 'brand/getcon/logo-weiss.png',
  'fonts/fonts.css', 'inhalte/kapitel.json', 'experimente/index.json'
];
const NET_TIMEOUT = 5000;

/* spec/01 §C.7 – einzelne Datei in den Cache legen, Fehler ignorieren */
async function addSafe(cache, url) {
  try {
    const r = await fetch(new Request(url, { cache: 'reload' }));
    if (r.ok) await cache.put(url, r);
  } catch (e) { /* optional */ }
}
/* experimente/index.json tolerant lesen: [..] oder {experimente:[..]}; Eintrag = "id" oder {id, dateien?} */
function expUrls(j) {
  const arr = Array.isArray(j) ? j : (j && (j.experimente || j.liste)) || [];
  const out = [];
  for (const e of arr) {
    const id = typeof e === 'string' ? e : (e && (e.id || e.ordner));
    if (!id) continue;
    out.push(`experimente/${id}/index.html`);
    for (const d of (e && e.dateien) || []) out.push(d.startsWith('experimente/') ? d : `experimente/${id}/${d}`);
  }
  return out;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.all(CORE.map(u => addSafe(c, u)));
    try { /* Schriften aus fonts.css */
      const css = await (await fetch('fonts/fonts.css', { cache: 'reload' })).text();
      const fs = [...css.matchAll(/url\(\.\/([^)]+)\)/g)].map(m => 'fonts/' + m[1]);
      await Promise.all([...new Set(fs)].map(u => addSafe(c, u)));
    } catch (e) {}
    try { /* Inhalte der freien Kapitel */
      const kj = await (await fetch('inhalte/kapitel.json', { cache: 'reload' })).json();
      for (const k of kj.kapitel || []) {
        if (k.status !== 'frei') continue;
        const u = k.inhalt || `inhalte/${k.id}.json`;   /* slides + toolbox (Kap. 7) */
        await addSafe(c, u);
      }
    } catch (e) {}
    try { /* Experimente (optional) */
      const r = await fetch('experimente/index.json', { cache: 'reload' });
      if (r.ok) await Promise.all(expUrls(await r.json()).map(u => addSafe(c, u)));
      else await addSafe(c, 'experimente/focus/index.html');
    } catch (e) {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const n of await caches.keys()) if (n.startsWith('kk-shell-') && n !== SHELL) await caches.delete(n);
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const base = new URL(self.registration.scope).pathname;
  const rel = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
  if (rel.startsWith('medien/') && !rel.endsWith('.json')) event.respondWith(medien(req));
  else event.respondWith(shell(req, rel));
});

/* Shell: network-first (mit Zeitlimit, wenn eine Cache-Kopie existiert) */
async function shell(req, rel) {
  const c = await caches.open(SHELL);
  const nav = req.mode === 'navigate';
  const isStart = nav && (rel === '' || rel === 'index.html');   /* iframe-Navigationen (Experimente) behalten ihre URL */
  const key = isStart ? './' : req.url.split('#')[0].split('?')[0];
  const cached = await c.match(key, { ignoreSearch: true });
  const range = req.headers.get('range');
  if (cached && range && !nav) return ranged(cached, range);   /* z. B. Audios in Experimenten (iOS) */
  const net = fetch(nav ? new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }) : new Request(req, { cache: 'no-cache' }))
    .then(res => { if (res.ok && res.status === 200 && res.type === 'basic') c.put(key, res.clone()); return res; });
  if (!cached) {
    return net.catch(async () => (await caches.match(req, { ignoreSearch: true })) ||
      new Response('Offline – diese Datei ist noch nicht gespeichert.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
  }
  return Promise.race([
    net.then(r => (r.ok ? r : cached)).catch(() => cached),
    new Promise(res => setTimeout(() => res(cached), NET_TIMEOUT))
  ]);
}

/* Medien: cache-first; Range → 206 aus dem Cache */
async function medien(req) {
  const c = await caches.open(MEDIEN);
  const key = req.url.split('#')[0].split('?')[0];
  const range = req.headers.get('range');
  const cached = await c.match(key, { ignoreSearch: true, ignoreVary: true });
  if (cached) return range ? ranged(cached, range) : cached;
  if (range) {
    try { return await fetch(req); }
    catch (e) { return new Response('', { status: 503 }); }
  }
  try {
    const res = await fetch(req);
    if (res.ok && res.status === 200) c.put(key, res.clone());
    return res;
  } catch (e) {
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

async function ranged(resp, range) {
  const blob = await resp.blob();
  const size = blob.size;
  const m = /bytes=(\d*)-(\d*)/.exec(range || '');
  let start, end;
  if (!m) { start = 0; end = size - 1; }
  else if (m[1] === '' && m[2] !== '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1] || 0); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
  if (start >= size || start > end) {
    return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206, statusText: 'Partial Content',
    headers: {
      'Content-Type': resp.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes'
    }
  });
}
