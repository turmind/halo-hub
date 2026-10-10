// Kernel connection over Halo's Jupyter proxy (Halo ≥ 1.6.1, only used when init.jupyter is present):
// REST under /api/jupyter, one WebSocket per kernel speaking Jupyter's legacy JSON text frames (messages carry
// `channel`), messaging protocol 5.3. The iframe is same-origin with the admin, so the login cookie rides along.

const API = '/api/jupyter';
const RECONNECTS = 3; // after a dropped socket: 1 s, 2 s, 4 s, then the kernel shows as dead

async function api(method, path, body, keepalive = false) {
  const r = await fetch(API + path, {
    method, keepalive, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* empty or non-JSON body */ }
  if (!r.ok) {
    const e = new Error(data?.error || `HTTP ${r.status}`);
    e.status = r.status;
    e.hint = data?.hint;
    throw e;
  }
  return data;
}

export const jupyterStatus = () => api('GET', '/status');
export const kernelSpecs = () => api('GET', '/kernelspecs');

const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

export class Kernel {
  /**
   * @param {{ projectId: string, path: string, name: string,
   *   onStatus: (s: 'starting'|'idle'|'busy'|'restarting'|'dead'|'gone') => void,
   *   onMessage: (msg: object) => void, onReconnect: () => void }} opts
   * 'restarting' = the kernel died and Jupyter is restarting it; 'gone' = shut down upstream (idle cull), id is dead.
   */
  constructor(opts) {
    this.opts = opts;
    this.name = opts.name;
    this.id = null;
    this.ws = null;
    this.outbox = [];
    this.tries = 0;
    this.closed = false;
    this.session = hex(16);
    this.seq = 0;
    this.ready = null; // promise of the started kernel (shared by everything queued before it is up)
  }

  /** Start the kernel once; resolves when its id is known (messages sent before the socket opens wait in outbox). */
  start() {
    this.ready ??= (async () => {
      this.opts.onStatus('starting');
      const k = await api('POST', '/kernels', { projectId: this.opts.projectId, path: this.opts.path, name: this.name });
      this.id = k.id;
      this.connect();
    })();
    this.ready.catch(() => { this.ready = null; this.opts.onStatus('dead'); });
    return this.ready;
  }

  connect() {
    if (this.closed) return;
    // The server nudges every new connection with kernel_info, so a status busy → idle pair tells us the state.
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${API}/channels?kernel=${encodeURIComponent(this.id)}`);
    const again = this.tries > 0;
    this.ws = ws;
    ws.onopen = () => {
      this.tries = 0;
      for (const m of this.outbox.splice(0)) ws.send(m);
      if (again) this.opts.onReconnect();
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return; // binary frames carry comm buffers (widgets), which this viewer doesn't use
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.channel === 'iopub' && msg.header?.msg_type === 'status') {
        const s = msg.content?.execution_state;
        if (['starting', 'idle', 'busy', 'restarting', 'dead'].includes(s)) this.opts.onStatus(s);
      }
      this.opts.onMessage(msg);
    };
    ws.onclose = (e) => {
      if (this.closed || this.ws !== ws) return;
      // 1000 = the proxy saw the kernel shut down upstream (culled): its id is gone, only a new kernel helps.
      if (e.code === 1000) { this.ws = null; this.gone = true; this.opts.onStatus('gone'); return; }
      if (this.tries < RECONNECTS) { setTimeout(() => { if (this.ws === ws) this.connect(); }, 1000 * 2 ** this.tries++); return; }
      this.ws = null;
      this.opts.onStatus('dead');
    };
  }

  /** Send a request; returns its msg_id (replies and iopub messages carry it as parent_header.msg_id). */
  send(channel, msgType, content) {
    const msgId = `${this.session}_${++this.seq}`;
    const frame = JSON.stringify({
      header: { msg_id: msgId, msg_type: msgType, username: 'halo', session: this.session, date: new Date().toISOString(), version: '5.3' },
      parent_header: {}, metadata: {}, content, buffers: [], channel,
    });
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame); else this.outbox.push(frame);
    return msgId;
  }

  interrupt() { return this.id && !this.gone ? api('POST', `/kernels/${encodeURIComponent(this.id)}/interrupt`) : Promise.resolve(); }

  /** Restart in place (same socket); a kernel the server no longer has (culled, server restarted) is started fresh. */
  async restart() {
    this.outbox = [];
    if (this.id && !this.gone) {
      try {
        this.opts.onStatus('starting');
        await api('POST', `/kernels/${encodeURIComponent(this.id)}/restart`);
        if (!this.ws) { this.tries = 0; this.connect(); }
        return;
      } catch (e) {
        if (e.status !== 404) { this.opts.onStatus('dead'); throw e; }
      }
    }
    const old = this.ws;
    this.ws = null;
    old?.close();
    this.id = null;
    this.gone = false;
    this.ready = null;
    this.tries = 0;
    return this.start();
  }

  /** Best effort; the server also shuts a kernel down 60 s after its last socket closes. */
  shutdown() {
    this.closed = true;
    this.ws?.close();
    if (this.id && !this.gone) api('DELETE', `/kernels/${encodeURIComponent(this.id)}`, null, true).catch(() => {});
  }
}
