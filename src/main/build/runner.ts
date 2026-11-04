/**
 * The page that runs a build's backend in Keo's preview: inside a sandboxed, network-less Chromium
 * page (no Node.js, no access to Keo or the user's files). The API is written like a Cloudflare
 * Worker (export default { async fetch(request, env) }) with env.DB like Cloudflare D1 (sql.js
 * here), so the same files go online unchanged. Keo talks to it only through window.__keo.
 */
export const RUNNER_HTML = `<!doctype html>
<meta charset="utf-8">
<title>Keo API preview</title>
<script src="/_keo/sql-wasm.js"></script>
<script type="module">
const b64 = {
  to(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); },
  from(s) { const bin = atob(s); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; },
};
let SQL = null, db = null, api = null, env = null, dirty = false;
const value = (x) => (x === undefined ? null : typeof x === 'boolean' ? (x ? 1 : 0) : x instanceof Date ? x.toISOString() : x);
function rows(sql, params) {
  const s = db.prepare(sql);
  try {
    s.bind(params.map(value));
    const out = [];
    while (s.step()) out.push(s.getAsObject());
    if (!/^\\s*(select|with|pragma|explain)\\b/i.test(sql)) dirty = true;
    return out;
  } finally {
    s.free();
  }
}
function meta() {
  const id = db.exec('select last_insert_rowid()')[0]?.values?.[0]?.[0] ?? 0;
  return { changes: db.getRowsModified(), last_row_id: id, duration: 0 };
}
const DB = {
  prepare(sql) {
    const st = {
      params: [],
      bind(...v) { st.params = v; return st; },
      async all() { return { results: rows(sql, st.params), success: true, meta: meta() }; },
      async first(col) { const r = rows(sql, st.params)[0]; return r === undefined ? null : col ? (r[col] ?? null) : r; },
      async run() { rows(sql, st.params); return { success: true, results: [], meta: meta() }; },
      async raw() { return rows(sql, st.params).map((r) => Object.values(r)); },
    };
    return st;
  },
  async batch(list) {
    db.run('BEGIN');
    try { const out = []; for (const s of list) out.push(await s.all()); db.run('COMMIT'); return out; }
    catch (e) { db.run('ROLLBACK'); throw e; }
  },
  async exec(sql) { db.exec(sql); dirty = true; return { count: 1, duration: 0 }; },
  async dump() { return db.export().buffer; },
};
window.__keo = {
  async start(dbB64, schema, vars) {
    SQL = SQL || (await window.initSqlJs({ locateFile: (f) => '/_keo/' + f }));
    db = dbB64 ? new SQL.Database(b64.from(dbB64)) : new SQL.Database();
    let fresh = false;
    if (!dbB64 && schema) { db.exec(schema); fresh = true; }
    env = { ...vars, DB, KEO_PREVIEW: 'true' };
    api = (await import('/api/index.js')).default;
    if (!api || typeof api.fetch !== 'function') throw new Error('api/index.js must export default { async fetch(request, env) { … } }');
    return { fresh, db: fresh ? b64.to(db.export()) : null };
  },
  async handle(req) {
    dirty = false;
    const init = { method: req.method, headers: req.headers };
    if (req.body && req.method !== 'GET' && req.method !== 'HEAD') init.body = b64.from(req.body);
    let res;
    try {
      res = await api.fetch(new Request(req.url, init), env, { waitUntil() {}, passThroughOnException() {} });
      if (!(res instanceof Response)) throw new Error('the API did not return a Response');
    } catch (e) {
      const text = 'The API failed: ' + ((e && e.stack) || e);
      return { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: b64.to(new TextEncoder().encode(text)), error: text.slice(0, 2000), db: dirty ? b64.to(db.export()) : null };
    }
    const body = new Uint8Array(await res.arrayBuffer());
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { status: res.status, headers, body: b64.to(body), db: dirty ? b64.to(db.export()) : null };
  },
};
window.__keoReady = true;
</script>
`;
