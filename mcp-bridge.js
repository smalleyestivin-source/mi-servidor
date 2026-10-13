/**
 * mcp-bridge.js — Puente  IDE (navegador)  ⇄  servidor de Render  ⇄  tu IA (MCP)
 *
 * QUÉ HACE
 *  1) El IDE abre un WebSocket en  wss://TU-SERVIDOR/ide-bridge  y recibe un CÓDIGO.
 *  2) Este módulo publica un servidor MCP remoto en  https://TU-SERVIDOR/mcp/<CÓDIGO>
 *     (MCP "Streamable HTTP": JSON-RPC por POST, sin sesiones).
 *  3) Cuando tu IA llama una herramienta (crear archivo, responder en el panel...),
 *     se reenvía por el WebSocket al IDE, que la ejecuta y devuelve el resultado.
 *
 * INSTALAR (en el proyecto del servidor, que debe usar Express):
 *     npm install ws
 *
 * USAR (en tu archivo principal, DESPUÉS de crear `app` y ANTES de cualquier ruta
 * "catch-all" / 404):
 *     const { attachMcpBridge } = require('./mcp-bridge');
 *     const server = app.listen(PORT, () => console.log('listo'));   // el http.Server
 *     attachMcpBridge(app, server);
 *
 *  Si ya usas http.createServer(app), pasa ese mismo `server`.
 *  Variable opcional:  MCP_PUBLIC_URL=https://mi-servidor-v2.onrender.com
 *  (si no existe, se deduce del encabezado Host).
 */
'use strict';

const crypto = require('crypto');

// ───────────────────────── Configuración ─────────────────────────
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'codeide-bridge', version: '1.0.0' };
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I
const TIMEOUT_READ_MS = 20000;     // herramientas de lectura
const TIMEOUT_WRITE_MS = 125000;   // crear/editar/eliminar: el usuario puede tardar en aprobar
const TIMEOUT_WAIT_MS = 55000;     // wait_for_user_message (el IDE espera hasta 45 s)
const MAX_PENDING_PER_SESSION = 20;
const BAD_CODE_LIMIT = 30;         // intentos con código inválido por minuto y por IP
const MAX_BODY = '6mb';

// ───────────────────────── Herramientas expuestas a la IA ─────────────────────────
const S = (props, required) => ({ type: 'object', properties: props, required: required || [] });
const str = (d) => ({ type: 'string', description: d });

const TOOLS = [
  {
    name: 'list_files',
    description: "List every file in the user's CodeIDE project (path, language, size, which one is open).",
    inputSchema: S({}),
    annotations: { readOnlyHint: true },
    timeout: TIMEOUT_READ_MS,
  },
  {
    name: 'get_active_file',
    description: 'Return the path and full content of the file currently open in the editor.',
    inputSchema: S({}),
    annotations: { readOnlyHint: true },
    timeout: TIMEOUT_READ_MS,
  },
  {
    name: 'read_file',
    description: 'Read a project file. Optionally pass start_line/end_line (1-based) to read only a range.',
    inputSchema: S(
      {
        path: str('File path, e.g. "index.html" or "src/app.js"'),
        start_line: { type: 'integer', description: 'First line to read (1-based)' },
        end_line: { type: 'integer', description: 'Last line to read (inclusive)' },
      },
      ['path']
    ),
    annotations: { readOnlyHint: true },
    timeout: TIMEOUT_READ_MS,
  },
  {
    name: 'write_file',
    description:
      'Create a file or completely overwrite an existing one. Folders are created automatically from the path (e.g. "src/utils/math.js"). The user may be asked to approve.',
    inputSchema: S(
      { path: str('File path, e.g. "src/app.js"'), content: str('Full file content') },
      ['path', 'content']
    ),
    timeout: TIMEOUT_WRITE_MS,
  },
  {
    name: 'edit_file',
    description:
      'Replace one exact piece of text in a file. old_str must appear exactly once (add surrounding context to make it unique). Read the file first. The user may be asked to approve.',
    inputSchema: S(
      {
        path: str('File path'),
        old_str: str('Exact text to replace (must be unique in the file)'),
        new_str: str('Replacement text (empty string deletes the match)'),
      },
      ['path', 'old_str', 'new_str']
    ),
    timeout: TIMEOUT_WRITE_MS,
  },
  {
    name: 'delete_file',
    description: 'Delete a project file. The user is ALWAYS asked to approve.',
    inputSchema: S({ path: str('File path') }, ['path']),
    annotations: { destructiveHint: true },
    timeout: TIMEOUT_WRITE_MS,
  },
  {
    name: 'open_file',
    description: 'Open a file in the editor so the user sees it.',
    inputSchema: S({ path: str('File path') }, ['path']),
    timeout: TIMEOUT_READ_MS,
  },
  {
    name: 'send_to_assistant',
    description:
      "Show a message inside the IDE's Assistant panel (the user's chat). Supports Markdown-style text, ```code blocks``` (the panel adds Insert/Replace buttons) and images. Use this to ANSWER the user in assistant mode.",
    inputSchema: S({
      text: str('Message text'),
      images: {
        type: 'array',
        maxItems: 6,
        items: { type: 'string' },
        description: 'Images as https URLs or data:image/(png|jpeg|gif|webp);base64,... URIs',
      },
    }),
    timeout: TIMEOUT_READ_MS,
  },
  {
    name: 'wait_for_user_message',
    description:
      'ASSISTANT MODE: block up to ~25 s waiting for the user to type in the IDE Assistant panel. Returns {messages:[...]} or {timeout:true}. After answering with send_to_assistant, call this again to keep listening. Keep looping until the user tells you to stop.',
    inputSchema: S({
      timeout_seconds: { type: 'integer', minimum: 1, maximum: 45, description: 'Max seconds to wait (default 25)' },
    }),
    annotations: { readOnlyHint: true },
    timeout: TIMEOUT_WAIT_MS,
  },
  {
    name: 'get_user_messages',
    description: 'Non-blocking: return and clear any messages the user already typed in the Assistant panel.',
    inputSchema: S({}),
    annotations: { readOnlyHint: true },
    timeout: TIMEOUT_READ_MS,
  },
];
const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
const PUBLIC_TOOLS = TOOLS.map(({ timeout, ...rest }) => rest); // sin el campo interno

// ───────────────────────── Núcleo (sin dependencias, testeable) ─────────────────────────
function newCode() {
  let a = '', b = '';
  for (let i = 0; i < 4; i++) a += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  for (let i = 0; i < 4; i++) b += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return `${a}-${b}`;
}
const CODE_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;

function createBridge(opts) {
  opts = opts || {};
  const sessions = new Map(); // code -> { ws, pending:Map, aiName }
  const badCodes = new Map(); // ip -> { n, t }

  function tooManyBadCodes(ip) {
    const now = Date.now();
    const e = badCodes.get(ip);
    if (!e || now - e.t > 60000) return false;
    return e.n >= BAD_CODE_LIMIT;
  }
  function noteBadCode(ip) {
    const now = Date.now();
    const e = badCodes.get(ip);
    if (!e || now - e.t > 60000) badCodes.set(ip, { n: 1, t: now });
    else e.n++;
    if (badCodes.size > 5000) for (const [k, v] of badCodes) if (now - v.t > 60000) badCodes.delete(k);
  }

  function rejectAll(session, why) {
    for (const [, p] of session.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(why));
    }
    session.pending.clear();
  }

  // ── Conexión del IDE (WebSocket). `sock` necesita: send(str), close(), on('message'|'close'|'error') ──
  function onIdeSocket(sock, publicBase) {
    let session = null;
    let alive = true;

    function send(o) {
      try { sock.send(JSON.stringify(o)); } catch (_) {}
    }

    sock.on('message', (data) => {
      let m;
      try { m = JSON.parse(String(data)); } catch (_) { return; }
      if (!m || typeof m.type !== 'string') return;

      if (m.type === 'hello') {
        if (session) return;
        let code = typeof m.resume === 'string' ? m.resume.toUpperCase() : '';
        const prev = CODE_RE.test(code) ? sessions.get(code) : null;
        if (!CODE_RE.test(code)) code = '';
        // Reanudar el mismo código (la URL de la IA sigue valiendo). Si había otra conexión
        // con ese código, la reemplazamos.
        if (code) {
          if (prev) {
            rejectAll(prev, 'El IDE se reconectó');
            try { prev.ws.close(); } catch (_) {}
          }
        } else {
          do { code = newCode(); } while (sessions.has(code));
        }
        session = { code, ws: { close: () => sock.close(), send }, pending: new Map(), aiName: '' };
        sessions.set(code, session);
        const mcpUrl = `${publicBase}/mcp/${code}`;
        send({ type: 'paired', code, mcpUrl });
      } else if (!session) {
        send({ type: 'error', message: 'Falta el mensaje hello' });
      } else if (m.type === 'ping') {
        send({ type: 'pong' });
      } else if (m.type === 'result' && m.id != null) {
        const p = session.pending.get(m.id);
        if (!p) return;
        session.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.data);
        else p.reject(new Error(String(m.error || 'Error en el IDE')));
      }
    });

    function cleanup() {
      if (!alive) return;
      alive = false;
      if (session && sessions.get(session.code) === session) {
        rejectAll(session, 'El IDE se desconectó');
        sessions.delete(session.code);
      }
    }
    sock.on('close', cleanup);
    sock.on('error', cleanup);
  }

  // ── Llamar una herramienta del IDE ──
  function callIde(session, tool, args) {
    return new Promise((resolve, reject) => {
      if (session.pending.size >= MAX_PENDING_PER_SESSION) return reject(new Error('Demasiadas llamadas pendientes'));
      const id = crypto.randomUUID();
      const def = TOOL_BY_NAME[tool];
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error('El IDE no respondió a tiempo (¿rechazó el permiso o se durmió el teléfono?)'));
      }, def.timeout);
      session.pending.set(id, { resolve, reject, timer });
      try {
        session.ws.send({ type: 'call', id, tool, args: args || {} });
      } catch (e) {
        clearTimeout(timer);
        session.pending.delete(id);
        reject(e);
      }
    });
  }

  // ── JSON-RPC de MCP. Devuelve la respuesta, o null si era una notificación ──
  async function handleRpc(session, msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return { jsonrpc: '2.0', id: msg && msg.id != null ? msg.id : null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const isNotification = msg.id === undefined || msg.id === null;
    const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });

    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params && msg.params.protocolVersion;
        const version = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
        const ci = msg.params && msg.params.clientInfo;
        if (ci && ci.name) {
          session.aiName = String(ci.name).slice(0, 60);
          try { session.ws.send({ type: 'ai', name: session.aiName }); } catch (_) {}
        }
        return ok({
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "You are connected to the user's CodeIDE (a code editor on their phone). Use the file tools to read/create/edit project files. " +
            'ASSISTANT MODE: when the user asks you to "listen" to their IDE assistant, loop: wait_for_user_message → answer with send_to_assistant (use file tools if needed) → wait_for_user_message again, until told to stop.',
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: PUBLIC_TOOLS });
      case 'tools/call': {
        const name = msg.params && msg.params.name;
        if (!TOOL_BY_NAME[name]) return fail(-32602, `Unknown tool: ${name}`);
        try {
          const data = await callIde(session, name, (msg.params && msg.params.arguments) || {});
          return ok({
            content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }],
            isError: false,
          });
        } catch (e) {
          // Errores de la herramienta van como resultado (la IA puede leerlos y corregir)
          return ok({ content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true });
        }
      }
      default:
        return isNotification ? null : fail(-32601, `Method not found: ${msg.method}`);
    }
  }

  return { sessions, onIdeSocket, handleRpc, tooManyBadCodes, noteBadCode };
}

// ───────────────────────── Pegamento con Express + ws ─────────────────────────
function attachMcpBridge(app, server) {
  const express = require('express');
  const { WebSocketServer } = require('ws');
  const bridge = createBridge();

  const baseFromReq = (req) => {
    if (process.env.MCP_PUBLIC_URL) return process.env.MCP_PUBLIC_URL.replace(/\/+$/, '');
    const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    return `${proto}://${req.headers.host}`;
  };

  // WebSocket del IDE: /ide-bridge
  const wss = new WebSocketServer({ noServer: true, maxPayload: 6 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch (_) {}
    if (pathname !== '/ide-bridge') return; // otros listeners de upgrade siguen funcionando
    wss.handleUpgrade(req, socket, head, (ws) => {
      bridge.onIdeSocket(ws, baseFromReq(req));
    });
  });

  // Servidor MCP remoto: POST /mcp/<CÓDIGO>
  const router = express.Router();
  router.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, mcp-protocol-version, mcp-session-id');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  router.post('/:code', express.json({ limit: MAX_BODY }), async (req, res) => {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || '?';
    if (bridge.tooManyBadCodes(ip)) return res.status(429).json({ error: 'Too many attempts' });
    const code = String(req.params.code || '').toUpperCase();
    const session = CODE_RE.test(code) ? bridge.sessions.get(code) : null;
    if (!session) {
      bridge.noteBadCode(ip);
      return res.status(404).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Código inválido o IDE desconectado' } });
    }
    try {
      const body = req.body;
      if (Array.isArray(body)) {
        const out = (await Promise.all(body.map((m) => bridge.handleRpc(session, m)))).filter(Boolean);
        return out.length ? res.json(out) : res.sendStatus(202);
      }
      const out = await bridge.handleRpc(session, body);
      return out ? res.json(out) : res.sendStatus(202);
    } catch (e) {
      return res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
    }
  });
  // GET no se usa (no hay stream del servidor al cliente): 405 es válido según la especificación
  router.get('/:code', (req, res) => res.status(405).set('Allow', 'POST').end());

  app.use('/mcp', router);
  console.log('[mcp-bridge] listo: WebSocket /ide-bridge  ·  MCP /mcp/<código>');
  return bridge;
}

module.exports = { attachMcpBridge, createBridge, TOOLS };
