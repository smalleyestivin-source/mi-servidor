/**
 * mcp-team.js — Equipo de varias IAs sobre el mismo IDE (se usa desde mcp-bridge.js)
 *
 * CÓMO SE CONECTA CADA IA (una URL distinta por IA, mismo código del IDE):
 *     https://TU-SERVIDOR/mcp/<CÓDIGO>/<rol>/<nombre>
 *   roles:  lider · constructor · revisor        (también: leader · builder · reviewer)
 *   ej.:    /mcp/ACT3-XN89/lider/Claude
 *           /mcp/ACT3-XN89/constructor/Gemini
 *           /mcp/ACT3-XN89/revisor/GPT
 *   Sin rol ni nombre (/mcp/<CÓDIGO>) funciona como antes: una sola IA, sin equipo.
 *
 * QUÉ ES CADA ROL
 *   lider        planifica (crea y asigna tareas), es la ÚNICA que escucha al usuario.
 *   constructor  toma tareas, bloquea archivos, escribe código y entrega.
 *   revisor      SOLO LEE: revisa lo entregado, aprueba o rechaza, y crea tareas por fallos.
 *
 * AVISO: el rol lo decide la URL. Es orden, no seguridad: quien tenga el código del IDE
 * puede usar cualquier rol. Comparte el código solo con IAs en las que confíes.
 *
 * Todo vive en memoria del servidor: si el servidor se reinicia, el tablero se vacía.
 */
'use strict';

const ROLE_ALIASES = {
  lider: 'lider', leader: 'lider', lead: 'lider',
  constructor: 'constructor', builder: 'constructor', dev: 'constructor',
  revisor: 'revisor', reviewer: 'revisor',
};
const NAME_RE = /^[A-Za-z0-9_\-\u00C0-\u017F]{1,24}$/;
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file']);
const USER_TOOLS = new Set(['wait_for_user_message', 'get_user_messages']);
const LIMITS = {
  members: 8, tasks: 200, log: 300,
  title: 120, detail: 2000, text: 2000,
  lockMs: 10 * 60 * 1000, idleMs: 6 * 60 * 60 * 1000,
  waitDefault: 25, waitMax: 45,
};

const S = (props, required) => ({ type: 'object', properties: props, required: required || [] });
const str = (d) => ({ type: 'string', description: d });
const num = (d) => ({ type: 'integer', description: d });

// ───────────────────────── Herramientas del equipo ─────────────────────────
const TEAM_TOOLS = [
  { name: 'team_status', roles: ['lider', 'constructor', 'revisor'], annotations: { readOnlyHint: true },
    description: 'Team overview: who is in the team (role), task counts per state, locked files and how many unread events you have. Call it first.',
    inputSchema: S({}) },
  { name: 'board_list', roles: ['lider', 'constructor', 'revisor'], annotations: { readOnlyHint: true },
    description: 'List the tasks of the board. Optional filter by estado: pendiente | en_curso | en_revision | aprobada.',
    inputSchema: S({ estado: str('pendiente | en_curso | en_revision | aprobada') }) },
  { name: 'task_create', roles: ['lider', 'constructor', 'revisor'],
    description: 'Create a task. Optional asignar_a = name of a team member (see team_status). Unassigned tasks can be taken by any builder with task_claim.',
    inputSchema: S({ titulo: str('Short title'), detalle: str('What exactly must be done / acceptance criteria'), asignar_a: str('Member name (optional)') }, ['titulo']) },
  { name: 'task_claim', roles: ['lider', 'constructor'],
    description: 'Take a pending task (it becomes en_curso and yours). Fails if it is assigned to someone else.',
    inputSchema: S({ id: num('Task id') }, ['id']) },
  { name: 'task_submit', roles: ['lider', 'constructor'],
    description: 'Deliver your task for review (en_revision). Give a summary and the files you changed. Your locks on those files are released.',
    inputSchema: S({ id: num('Task id'), resumen: str('What you did'), archivos: { type: 'array', items: { type: 'string' }, description: 'Paths you changed' } }, ['id', 'resumen']) },
  { name: 'task_review', roles: ['lider', 'revisor'],
    description: 'Review a task that is en_revision. decision = "aprobar" or "rechazar". If you reject, the comment must say exactly what to fix (the task goes back to its owner). You cannot review your own task.',
    inputSchema: S({ id: num('Task id'), decision: str('aprobar | rechazar'), comentario: str('Feedback') }, ['id', 'decision']) },
  { name: 'task_assign', roles: ['lider'],
    description: 'Leader only: (re)assign a task to a member.',
    inputSchema: S({ id: num('Task id'), a: str('Member name') }, ['id', 'a']) },
  { name: 'team_say', roles: ['lider', 'constructor', 'revisor'],
    description: 'Send a message to the team chat. para = member name, or omit to tell everyone.',
    inputSchema: S({ texto: str('Message'), para: str('Member name (optional)') }, ['texto']) },
  { name: 'team_wait', roles: ['lider', 'constructor', 'revisor'], annotations: { readOnlyHint: true },
    description: 'Block up to ~25 s until something addressed to you happens (new task, delivery to review, review result, message). Returns {eventos:[...]} or {timeout:true}. Keep calling it in a loop while you are on duty.',
    inputSchema: S({ timeout_seconds: num('1-45, default 25') }) },
  { name: 'lock_file', roles: ['lider', 'constructor'],
    description: 'Reserve a file before editing it so another AI does not overwrite it. Locks expire after 10 minutes. Fails if someone else holds it.',
    inputSchema: S({ path: str('File path') }, ['path']) },
  { name: 'unlock_file', roles: ['lider', 'constructor'],
    description: 'Release a file you locked.',
    inputSchema: S({ path: str('File path') }, ['path']) },
];
const TEAM_TOOL_NAMES = new Set(TEAM_TOOLS.map((t) => t.name));
const isTeamTool = (n) => TEAM_TOOL_NAMES.has(n);

// ───────────────────────── Identidad (viene de la URL) ─────────────────────────
function parseRole(s) { return ROLE_ALIASES[String(s || '').toLowerCase()] || null; }

/** Devuelve { rol, nombre, team } o null si la URL es inválida. */
function whoFromParams(rol, nombre) {
  if (!rol) return { rol: 'constructor', nombre: 'constructor', team: false };
  const r = parseRole(rol);
  if (!r) return null;
  if (nombre && !NAME_RE.test(nombre)) return null;
  return { rol: r, nombre: nombre || r, team: true };
}
const defaultWho = () => ({ rol: 'constructor', nombre: 'constructor', team: false });

// ───────────────────────── Estado del equipo ─────────────────────────
function newTeam() {
  return { members: new Map(), tasks: [], nextTask: 1, log: [], nextEv: 1, waiters: [], locks: new Map(), touched: Date.now() };
}

function createStore() {
  const teams = new Map(); // código -> team
  function gc() {
    const now = Date.now();
    for (const [k, t] of teams) if (now - t.touched > LIMITS.idleMs) teams.delete(k);
  }
  return {
    get(code) {
      if (teams.size > 200) gc();
      let t = teams.get(code);
      if (!t) { t = newTeam(); teams.set(code, t); }
      return t;
    },
    peek: (code) => teams.get(code) || null,
  };
}

function touch(team, who) {
  team.touched = Date.now();
  let m = team.members.get(who.nombre);
  if (!m) {
    if (team.members.size >= LIMITS.members) throw new Error('El equipo está lleno (máx. ' + LIMITS.members + ' IAs).');
    m = { nombre: who.nombre, rol: who.rol, cursor: 0, seen: Date.now() };
    team.members.set(who.nombre, m);
  } else if (m.rol !== who.rol) {
    throw new Error(`El nombre "${who.nombre}" ya está usado con el rol ${m.rol}. Usa otro nombre en la URL.`);
  }
  m.seen = Date.now();
  return m;
}

const lider = (team) => [...team.members.values()].find((m) => m.rol === 'lider') || null;

// ───────────────────────── Eventos ─────────────────────────
function recipients(team, pred, exclude) {
  return [...team.members.values()].filter((m) => m.nombre !== exclude && pred(m)).map((m) => m.nombre);
}
function pushEvent(team, tipo, de, para, texto, extra) {
  const ev = Object.assign({ id: team.nextEv++, t: new Date().toISOString(), tipo, de, para, texto }, extra || {});
  team.log.push(ev);
  if (team.log.length > LIMITS.log) team.log.splice(0, team.log.length - LIMITS.log);
  for (let i = team.waiters.length - 1; i >= 0; i--) {
    const w = team.waiters[i];
    if (para.includes(w.name)) { team.waiters.splice(i, 1); w.wake(); }
  }
  return ev;
}
function pendingFor(team, m) { return team.log.filter((e) => e.id > m.cursor && e.para.includes(m.nombre)); }

// ───────────────────────── Permisos ─────────────────────────
const deny = (reason) => ({ ok: false, reason });
function canCall(who, name, team) {
  if (WRITE_TOOLS.has(name) && who.rol === 'revisor')
    return deny('Your role is reviewer (read-only): you cannot modify files. Report problems with task_review (reject) or task_create.');
  if (USER_TOOLS.has(name)) {
    const l = lider(team);
    if (l && who.rol !== 'lider') return deny(`Only the leader (${l.nombre}) talks to the user. Use team_say to talk to the team.`);
  }
  if (isTeamTool(name)) {
    const def = TEAM_TOOLS.find((t) => t.name === name);
    if (!def.roles.includes(who.rol)) return deny(`The tool ${name} is not available for the role ${who.rol}.`);
  }
  return { ok: true };
}

/** Lista de herramientas visible para este rol (IDE + equipo). */
function toolsFor(who, ideTools) {
  const ide = who.rol === 'revisor' ? ideTools.filter((t) => !WRITE_TOOLS.has(t.name)) : ideTools;
  const mine = TEAM_TOOLS.filter((t) => t.roles.includes(who.rol)).map(({ roles, ...rest }) => rest);
  return ide.concat(mine);
}

// ───────────────────────── Bloqueos de archivos ─────────────────────────
function lockOwner(team, path, who) {
  if (!path) return null;
  const l = team.locks.get(path);
  if (!l) return null;
  if (Date.now() > l.until) { team.locks.delete(path); return null; }
  return l.owner !== who.nombre ? l.owner : null;
}
function activeLocks(team) {
  const out = [];
  for (const [p, l] of team.locks) { if (Date.now() > l.until) team.locks.delete(p); else out.push({ archivo: p, por: l.owner }); }
  return out;
}

// ───────────────────────── Lógica de las herramientas ─────────────────────────
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const taskView = (t) => ({ id: t.id, titulo: t.titulo, detalle: t.detalle, estado: t.estado, creador: t.creador, asignado: t.asignado, resumen: t.resumen, archivos: t.archivos, revision: t.revision, rechazos: t.rechazos });
function findTask(team, id) {
  const t = team.tasks.find((x) => x.id === Number(id));
  if (!t) throw new Error(`No existe la tarea #${id}. Usa board_list.`);
  return t;
}
const stamp = (who) => `${who.nombre} (${who.rol})`;

async function callTeamTool(team, who, name, args, hooks) {
  args = args || {};
  const notify = (hooks && hooks.notify) || (() => {});
  const me = touch(team, who);

  switch (name) {
    case 'team_status': {
      const counts = { pendiente: 0, en_curso: 0, en_revision: 0, aprobada: 0 };
      team.tasks.forEach((t) => counts[t.estado]++);
      const l = lider(team);
      return {
        tu: { nombre: who.nombre, rol: who.rol },
        lider: l ? l.nombre : null,
        miembros: [...team.members.values()].map((m) => ({ nombre: m.nombre, rol: m.rol, visto_hace_s: Math.round((Date.now() - m.seen) / 1000) })),
        tareas: counts,
        archivos_bloqueados: activeLocks(team),
        eventos_sin_leer: pendingFor(team, me).length,
      };
    }
    case 'board_list': {
      const f = args.estado ? String(args.estado) : null;
      return { tareas: team.tasks.filter((t) => !f || t.estado === f).map(taskView) };
    }
    case 'task_create': {
      const titulo = clip(args.titulo, LIMITS.title).trim();
      if (!titulo) throw new Error('Falta el título.');
      if (team.tasks.length >= LIMITS.tasks) throw new Error('El tablero está lleno.');
      let asignado = '';
      if (args.asignar_a) {
        asignado = String(args.asignar_a);
        const m = team.members.get(asignado);
        if (!m) throw new Error(`"${asignado}" no está en el equipo. Mira team_status.`);
        if (m.rol === 'revisor') throw new Error('Un revisor no puede recibir tareas de construcción.');
      }
      const t = { id: team.nextTask++, titulo, detalle: clip(args.detalle, LIMITS.detail), estado: 'pendiente', creador: who.nombre, asignado, resumen: '', archivos: [], revision: null, rechazos: 0 };
      team.tasks.push(t);
      const para = asignado ? [asignado] : recipients(team, (m) => m.rol !== 'revisor', who.nombre);
      pushEvent(team, 'tarea_nueva', who.nombre, para, `Nueva tarea #${t.id}: ${t.titulo}${asignado ? ' → ' + asignado : ''}`, { tarea: t.id });
      notify(`📋 **Tarea #${t.id}** creada por ${stamp(who)}: ${t.titulo}${asignado ? ' → ' + asignado : ''}`);
      return { ok: true, tarea: taskView(t) };
    }
    case 'task_claim': {
      const t = findTask(team, args.id);
      if (t.estado !== 'pendiente') throw new Error(`La tarea #${t.id} está ${t.estado}, no se puede tomar.`);
      if (t.asignado && t.asignado !== who.nombre) throw new Error(`La tarea #${t.id} está asignada a ${t.asignado}.`);
      t.estado = 'en_curso'; t.asignado = who.nombre;
      const l = lider(team);
      if (l && l.nombre !== who.nombre) pushEvent(team, 'tarea_tomada', who.nombre, [l.nombre], `${who.nombre} tomó la tarea #${t.id}`, { tarea: t.id });
      notify(`🔨 ${stamp(who)} empezó la tarea #${t.id}: ${t.titulo}`);
      return { ok: true, tarea: taskView(t) };
    }
    case 'task_submit': {
      const t = findTask(team, args.id);
      if (t.asignado !== who.nombre || t.estado !== 'en_curso') throw new Error(`Solo puedes entregar tus tareas en_curso (la #${t.id} está ${t.estado}, de ${t.asignado || 'nadie'}).`);
      t.resumen = clip(args.resumen, LIMITS.detail);
      t.archivos = Array.isArray(args.archivos) ? args.archivos.slice(0, 30).map((p) => clip(p, 200)) : [];
      t.estado = 'en_revision';
      t.archivos.forEach((p) => { const lk = team.locks.get(p); if (lk && lk.owner === who.nombre) team.locks.delete(p); });
      const para = recipients(team, (m) => m.rol === 'revisor' || m.rol === 'lider', who.nombre);
      pushEvent(team, 'entrega', who.nombre, para, `Tarea #${t.id} lista para revisar: ${t.titulo}`, { tarea: t.id });
      notify(`📦 ${stamp(who)} entregó la tarea #${t.id} para revisión: ${t.titulo}`);
      return { ok: true, nota: para.length ? 'Entregada. Un revisor la verá.' : 'Entregada, pero todavía no hay revisor conectado.', tarea: taskView(t) };
    }
    case 'task_review': {
      const t = findTask(team, args.id);
      if (t.estado !== 'en_revision') throw new Error(`La tarea #${t.id} no está en revisión (está ${t.estado}).`);
      if (t.asignado === who.nombre) throw new Error('No puedes revisar tu propia tarea.');
      const d = String(args.decision || '').toLowerCase();
      if (!['aprobar', 'rechazar'].includes(d)) throw new Error('decision debe ser "aprobar" o "rechazar".');
      const comentario = clip(args.comentario, LIMITS.detail);
      if (d === 'rechazar' && !comentario.trim()) throw new Error('Al rechazar, explica qué hay que arreglar en "comentario".');
      t.revision = { por: who.nombre, decision: d === 'aprobar' ? 'aprobada' : 'rechazada', comentario };
      if (d === 'aprobar') t.estado = 'aprobada'; else { t.estado = 'en_curso'; t.rechazos++; }
      const l = lider(team);
      const para = [...new Set([t.asignado, l && l.nombre].filter((n) => n && n !== who.nombre))];
      pushEvent(team, 'revision', who.nombre, para, `Tarea #${t.id} ${t.revision.decision} por ${who.nombre}${comentario ? ': ' + comentario : ''}`, { tarea: t.id });
      notify(`${d === 'aprobar' ? '✅' : '↩️'} ${stamp(who)} ${t.revision.decision} la tarea #${t.id}${comentario ? ': ' + comentario : ''}`);
      return { ok: true, tarea: taskView(t) };
    }
    case 'task_assign': {
      const t = findTask(team, args.id);
      const m = team.members.get(String(args.a || ''));
      if (!m) throw new Error(`"${args.a}" no está en el equipo.`);
      if (m.rol === 'revisor') throw new Error('Un revisor no puede recibir tareas de construcción.');
      if (t.estado === 'en_revision' || t.estado === 'aprobada') throw new Error(`La tarea #${t.id} ya está ${t.estado}.`);
      t.asignado = m.nombre;
      pushEvent(team, 'tarea_asignada', who.nombre, [m.nombre], `Te asignaron la tarea #${t.id}: ${t.titulo}`, { tarea: t.id });
      notify(`👉 ${stamp(who)} asignó la tarea #${t.id} a ${m.nombre}`);
      return { ok: true, tarea: taskView(t) };
    }
    case 'team_say': {
      const texto = clip(args.texto, LIMITS.text).trim();
      if (!texto) throw new Error('Falta el texto.');
      let para;
      if (args.para && args.para !== 'todos') {
        if (!team.members.has(String(args.para))) throw new Error(`"${args.para}" no está en el equipo.`);
        para = [String(args.para)];
      } else para = recipients(team, () => true, who.nombre);
      pushEvent(team, 'mensaje', who.nombre, para, texto);
      return { ok: true, entregado_a: para };
    }
    case 'team_wait': {
      let s = Number(args.timeout_seconds) || LIMITS.waitDefault;
      s = Math.max(1, Math.min(LIMITS.waitMax, s));
      let ev = pendingFor(team, me);
      if (!ev.length) {
        await new Promise((resolve) => {
          const w = { name: who.nombre, wake: () => { clearTimeout(timer); resolve(); } };
          const timer = setTimeout(() => { const i = team.waiters.indexOf(w); if (i >= 0) team.waiters.splice(i, 1); resolve(); }, s * 1000);
          team.waiters.push(w);
        });
        ev = pendingFor(team, me);
      }
      team.touched = Date.now(); me.seen = Date.now();
      if (!ev.length) return { timeout: true, nota: 'Sin novedades. Llama team_wait otra vez para seguir de guardia.' };
      me.cursor = ev[ev.length - 1].id;
      return { eventos: ev.map((e) => ({ id: e.id, tipo: e.tipo, de: e.de, texto: e.texto, tarea: e.tarea })) };
    }
    case 'lock_file': {
      const p = clip(args.path, 200).trim();
      if (!p) throw new Error('Falta path.');
      const other = lockOwner(team, p, who);
      if (other) throw new Error(`${p} está bloqueado por ${other}. Trabaja en otra cosa o pídele que lo libere (team_say).`);
      team.locks.set(p, { owner: who.nombre, until: Date.now() + LIMITS.lockMs });
      return { ok: true, nota: 'Bloqueado 10 min. Libéralo con unlock_file o entregando la tarea.' };
    }
    case 'unlock_file': {
      const p = clip(args.path, 200).trim();
      const l = team.locks.get(p);
      if (l && l.owner === who.nombre) team.locks.delete(p);
      return { ok: true };
    }
    default:
      throw new Error('Herramienta de equipo desconocida: ' + name);
  }
}

// ───────────────────────── Instrucciones por rol ─────────────────────────
function instructionsFor(who, base) {
  if (!who.team) return base;
  const common =
    `TEAM MODE: you are "${who.nombre}", role "${who.rol}", in a team of several AIs working on the user's CodeIDE project. ` +
    'Start with team_status. Coordinate ONLY through the board (board_list, task_*), team_say and team_wait; never assume the others saw something you did not post. ' +
    'Reply to the user in the language they use. Your messages in the IDE panel are auto-labelled with your name. ';
  const roles = {
    lider:
      'LEADER: you are the only one who listens to the user (wait_for_user_message → answer with send_to_assistant). Split each request into small tasks with task_create (use asignar_a with member names). ' +
      'Between user messages, call team_wait to follow progress, approve/reject deliveries with task_review if no reviewer is around, and tell the user what is happening.',
    constructor:
      'BUILDER: loop team_wait → task_claim → lock_file the files you will touch → write code with the file tools → task_submit (summary + files). If your task comes back rejected, read the comment, fix it and submit again. Never review your own work.',
    revisor:
      'REVIEWER (read-only): loop team_wait; when a delivery arrives read the files (read_file) and judge them against the task. Use task_review: "aprobar" or "rechazar" with a concrete comment saying what to fix. For bugs outside the task use task_create. You cannot modify files.',
  };
  return common + roles[who.rol] + ' ' + (base || '');
}

// ───────────────────────── Vista para la futura "zona de proyectos" ─────────────────────────
function snapshot(team) {
  return {
    miembros: [...team.members.values()].map((m) => ({ nombre: m.nombre, rol: m.rol, visto_hace_s: Math.round((Date.now() - m.seen) / 1000) })),
    tareas: team.tasks.map(taskView),
    archivos_bloqueados: activeLocks(team),
    eventos: team.log.slice(-50).map((e) => ({ id: e.id, t: e.t, tipo: e.tipo, de: e.de, para: e.para, texto: e.texto })),
  };
}

module.exports = { TEAM_TOOLS, isTeamTool, whoFromParams, defaultWho, createStore, touch, canCall, toolsFor, lockOwner, callTeamTool, instructionsFor, snapshot, WRITE_TOOLS };
