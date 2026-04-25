#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join, basename } from 'path';
import { generateUniqueWordId } from '../util/word-id.js';

// === Config ===
const TOOL_DIR = process.env.AGENT_POOL_TOOL_DIR || join(process.env.HOME!, '.agent-pool');
const DATA_DIR = process.env.AGENT_POOL_DATA_DIR || TOOL_DIR;
const LOOPS_DIR = join(TOOL_DIR, 'loops');
const DB_PATH = join(DATA_DIR, 'agent-pool.db');
const HEARTBEAT_DIR = join(DATA_DIR, 'heartbeats');
const LOGS_DIR = join(TOOL_DIR, 'logs');
const AGENT_POOL_BIN = join(TOOL_DIR, 'agent-pool');
const REFRESH_MS = 2500;
const DEFAULT_PROJECT = 'nebari';
const AGENT_POOL_WORKSPACE = 'workspace:3';

// === Types ===
interface LoopDef { name: string; scriptPath: string; cronExpr: string | null; promptPrefix: string; }
interface RunInfo { id: string; status: string; claimedBy: string | null; createdAt: string; startedAt: string | null; completedAt: string | null; }
interface AgentInfo { id: string; cloneIndex: number; locked: boolean; taskId: string | null; taskPrompt: string | null; heartbeatAge: number | null; heartbeatTool: string | null; cmuxSurface: string | null; }
interface SelectableRow { type: 'loop' | 'run' | 'agent' | 'action' | 'task' | 'task-summary'; loopIndex?: number; runIndex?: number; agentIndex?: number; taskIndex?: number; action?: string; label: string; }
interface TaskRow { id: string; status: string; claimedBy: string | null; prompt: string; priority: number; createdAt: string; startedAt: string | null; completedAt: string | null; }
interface ProjectRow { name: string; isDefault: boolean; }

interface ConfigField {
  key: string;
  label: string;
  value: string;
  editable: boolean;
  type: 'text' | 'select' | 'boolean';
  options?: string[];
  section?: string;
}

interface EnvVarRow { key: string; value: string; }

interface DocsEntry {
  type: 'header' | 'file';
  label: string;
  path?: string;
  indent: number;
  size?: number;
  mtime?: Date;
}

// === ANSI Colors ===
const enabled = process.env.NO_COLOR === undefined;
const code = (n: number) => (s: string) => enabled ? `\x1b[${n}m${s}\x1b[0m` : s;
const bold = code(1);
const dim = code(2);
const red = code(31);
const green = code(32);
const yellow = code(33);
const cyan = code(36);
const white = code(37);
const gray = code(90);
const bgBlue = (s: string) => enabled ? `\x1b[44;37m${s}\x1b[0m` : `> ${s}`;

function statusColor(s: string) { return s === 'pending' ? yellow : s === 'in_progress' ? cyan : s === 'completed' ? green : s === 'blocked' ? red : gray; }
function statusIcon(s: string) { return s === 'completed' ? green('✓') : s === 'in_progress' ? cyan('⟳') : s === 'blocked' ? red('✗') : s === 'pending' ? yellow('◦') : gray('·'); }

// === Helpers ===
function fmtDuration(s: string | null, e: string | null): string {
  if (!s) return '-';
  const secs = Math.floor(((e ? new Date(e).getTime() : Date.now()) - new Date(s).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
}
function fmtAge(ms: number): string { const s = Math.floor(ms / 1000); if (s < 60) return `${s}s ago`; const m = Math.floor(s / 60); return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`; }
function fmtTime(iso: string) { return new Date(iso).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }); }
function fmtDate(iso: string) { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
function isToday(iso: string) { const d = new Date(iso), n = new Date(); return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate(); }
const pad = (s: string, n: number) => { const len = s.replace(/\x1b\[[0-9;]*m/g, '').length; return len >= n ? s : s + ' '.repeat(n - len); };
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
function fmtSize(bytes: number): string { if (bytes < 1024) return `${bytes} B`; return `${(bytes / 1024).toFixed(1)} KB`; }

// === Cron Parser ===
function expandField(f: string, min: number, max: number): number[] {
  const v: Set<number> = new Set();
  for (const p of f.split(',')) {
    if (p === '*') { for (let i = min; i <= max; i++) v.add(i); }
    else if (p.startsWith('*/')) { const s = +p.slice(2); for (let i = min; i <= max; i += s) v.add(i); }
    else if (p.includes('-')) { const [a, b] = p.split('-').map(Number); for (let i = a; i <= b; i++) v.add(i); }
    else v.add(+p);
  }
  return [...v].sort((a, b) => a - b);
}
function nextCronFire(expr: string, after = new Date()): Date | null {
  const f = expr.trim().split(/\s+/); if (f.length !== 5) return null;
  const [mins, hrs, doms, mons, dows] = [expandField(f[0],0,59), expandField(f[1],0,23), expandField(f[2],1,31), expandField(f[3],1,12), expandField(f[4],0,6)];
  const t = new Date(after); t.setSeconds(0,0); t.setMinutes(t.getMinutes()+1);
  for (let i = 0; i < 2880; i++) {
    if (mins.includes(t.getMinutes()) && hrs.includes(t.getHours()) && doms.includes(t.getDate()) && mons.includes(t.getMonth()+1) && dows.includes(t.getDay())) return t;
    t.setMinutes(t.getMinutes()+1);
  }
  return null;
}
function fmtCron(expr: string) { const [m, h] = expr.trim().split(/\s+/); if (m.startsWith('*/') && h === '*') return `every ${m.slice(2)}m`; if (m === '0' && h.startsWith('*/')) return `every ${h.slice(2)}h`; if (m === '0' && /^\d+$/.test(h)) return `daily ${h.padStart(2,'0')}:00`; return expr; }

// === Loop Discovery ===
function discoverLoops(): LoopDef[] {
  if (!existsSync(LOOPS_DIR)) return [];
  const scripts = readdirSync(LOOPS_DIR).filter(f => f.endsWith('.sh'));
  const crons = getCrontab();
  return scripts.map(file => {
    const scriptPath = join(LOOPS_DIR, file);
    const name = basename(file, '.sh');
    const content = readFileSync(scriptPath, 'utf-8');
    let promptPrefix = '';
    const m = content.match(/PROMPT='([^']{1,80})/);
    if (m) promptPrefix = m[1].split('\n')[0].trim().slice(0, 60);
    let cronExpr: string | null = null;
    for (const line of crons) { if (line.includes(scriptPath) || line.includes(`loops/${file}`)) { const parts = line.trim().split(/\s+/); if (parts.length >= 6) cronExpr = parts.slice(0, 5).join(' '); } }
    return { name, scriptPath, cronExpr, promptPrefix };
  });
}
function getCrontab(): string[] { try { const r = Bun.spawnSync(['crontab','-l']); return r.exitCode===0 ? r.stdout.toString().split('\n').filter(l => l.trim() && !l.startsWith('#')) : []; } catch { return []; } }

// === Data Fetching ===
function fetchRuns(db: Database, prefix: string): RunInfo[] {
  if (!prefix) return [];
  return (db.query("SELECT id,status,claimed_by,created_at,started_at,completed_at FROM tasks WHERE prompt LIKE ?||'%' ORDER BY created_at DESC LIMIT 10").all(prefix) as any[])
    .map(r => ({ id:r.id, status:r.status, claimedBy:r.claimed_by, createdAt:r.created_at, startedAt:r.started_at, completedAt:r.completed_at }));
}
function fetchAgents(db: Database, project: string): AgentInfo[] {
  const poolPath = join(DATA_DIR, `pool-${project}.json`);
  const now = Date.now();
  const surfaceMap = discoverCmuxSurfaces();

  let cloneIndices: number[] = [];
  try {
    const pool = JSON.parse(readFileSync(poolPath, 'utf-8'));
    cloneIndices = pool.clones.map((c: any) => c.index as number).sort((a: number, b: number) => a - b);
  } catch {
    const rows = db.query("SELECT clone_index FROM clones WHERE project_name=? ORDER BY clone_index").all(project) as any[];
    cloneIndices = rows.map(r => r.clone_index);
  }

  const inProgressMap = new Map<string, { id: string; prompt: string }>();
  try {
    const tasksPath = join(DATA_DIR, `tasks-${project}.json`);
    const tasksData = JSON.parse(readFileSync(tasksPath, 'utf-8'));
    for (const t of tasksData.tasks) {
      if (t.status === 'in_progress' && t.claimed_by) {
        inProgressMap.set(t.claimed_by, { id: t.id, prompt: (t.prompt || '').slice(0, 80) });
      }
    }
  } catch {}
  try {
    const rows = db.query("SELECT id, claimed_by, substr(prompt,1,80) as prompt FROM tasks WHERE project_name=? AND status='in_progress' AND claimed_by IS NOT NULL").all(project) as any[];
    for (const r of rows) {
      if (!inProgressMap.has(r.claimed_by)) {
        inProgressMap.set(r.claimed_by, { id: r.id, prompt: r.prompt });
      }
    }
  } catch {}

  return cloneIndices.map(idx => {
    const id = `agent-${String(idx).padStart(2, '0')}`;
    let heartbeatAge: number | null = null, heartbeatTool: string | null = null, heartbeatTask: string | null = null;
    try {
      const d = JSON.parse(readFileSync(join(HEARTBEAT_DIR, `${id}.json`), 'utf-8'));
      heartbeatAge = now - new Date(d.timestamp).getTime();
      heartbeatTool = d.last_tool || null;
      heartbeatTask = d.task_id || null;
    } catch {}

    const v1Task = inProgressMap.get(id);
    const taskId = heartbeatTask || (v1Task ? v1Task.id : null);
    const taskPrompt = v1Task ? v1Task.prompt : null;
    const alive = heartbeatAge != null && heartbeatAge < 2 * 60 * 1000;
    const locked = alive || !!taskId;

    return { id, cloneIndex: idx, locked, taskId, taskPrompt, heartbeatAge, heartbeatTool, cmuxSurface: surfaceMap.get(id) || null };
  });
}
function fetchProjects(db: Database): ProjectRow[] {
  return (db.query("SELECT name, is_default FROM projects ORDER BY name").all() as any[])
    .map(r => ({ name: r.name, isDefault: !!r.is_default }));
}
function fetchTasks(db: Database, project: string): TaskRow[] {
  return (db.query("SELECT id,status,claimed_by,prompt,priority,created_at,started_at,completed_at FROM tasks WHERE project_name=? AND status NOT IN ('cancelled') ORDER BY CASE status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'pending' THEN 2 WHEN 'backlogged' THEN 3 WHEN 'completed' THEN 4 ELSE 5 END, priority DESC, created_at DESC LIMIT 50").all(project) as any[])
    .map(r => ({ id:r.id, status:r.status, claimedBy:r.claimed_by, prompt:r.prompt, priority:r.priority, createdAt:r.created_at, startedAt:r.started_at, completedAt:r.completed_at }));
}

interface FullProject {
  name: string; source: string; prefix: string; branch: string; setup: string | null;
  trackingType: string | null; trackingProjectKey: string | null; trackingLabel: string | null; trackingInstructions: string | null;
  workflowType: string | null; workflowInstructions: string | null; workflowAutoMerge: boolean | null; workflowMergeMethod: string | null;
  agentType: string | null; envVars: Record<string, string> | null;
}

function fetchFullProject(db: Database, name: string): FullProject | null {
  const r = db.query("SELECT * FROM projects WHERE name = ?").get(name) as any;
  if (!r) return null;
  return {
    name: r.name, source: r.source, prefix: r.prefix, branch: r.branch, setup: r.setup,
    trackingType: r.tracking_type, trackingProjectKey: r.tracking_project_key,
    trackingLabel: r.tracking_label, trackingInstructions: r.tracking_instructions,
    workflowType: r.workflow_type, workflowInstructions: r.workflow_instructions,
    workflowAutoMerge: r.workflow_auto_merge === null ? null : r.workflow_auto_merge === 1,
    workflowMergeMethod: r.workflow_merge_method,
    agentType: r.agent_type,
    envVars: r.env_vars ? JSON.parse(r.env_vars) : null,
  };
}

// === DB Write Operations ===
function createTask(db: Database, project: string, prompt: string): string {
  const id = generateUniqueWordId((candidate) => {
    const row = db.query("SELECT id FROM tasks WHERE id = ?").get(candidate);
    return row !== null;
  });
  const now = new Date().toISOString();
  db.query("INSERT INTO tasks (id, project_name, prompt, status, priority, created_at, retry_max, retry_count, retry_strategy) VALUES (?, ?, ?, 'pending', 0, ?, 1, 0, 'same')").run(id, project, prompt, now);
  return id;
}
function editTaskPrompt(db: Database, id: string, prompt: string) {
  db.query("UPDATE tasks SET prompt = ? WHERE id = ?").run(prompt, id);
}
function cancelTask(db: Database, id: string) {
  db.query("UPDATE tasks SET status = 'cancelled', completed_at = ? WHERE id = ?").run(new Date().toISOString(), id);
}

const CONFIG_COL_MAP: Record<string, string> = {
  source: 'source', prefix: 'prefix', branch: 'branch', setup: 'setup',
  trackingType: 'tracking_type', trackingProjectKey: 'tracking_project_key',
  trackingLabel: 'tracking_label', trackingInstructions: 'tracking_instructions',
  workflowType: 'workflow_type', workflowInstructions: 'workflow_instructions',
  workflowAutoMerge: 'workflow_auto_merge', workflowMergeMethod: 'workflow_merge_method',
  agentType: 'agent_type', envVars: 'env_vars',
};

function updateProjectField(db: Database, projectName: string, key: string, value: any) {
  const col = CONFIG_COL_MAP[key];
  if (!col) return;
  let dbVal = value;
  if (value === '') dbVal = null;
  if (key === 'workflowAutoMerge') dbVal = value === null || value === '' ? null : value ? 1 : 0;
  if (key === 'envVars') dbVal = value === null ? null : JSON.stringify(value);
  db.query(`UPDATE projects SET ${col} = ? WHERE name = ?`).run(dbVal, projectName);
}

// === Cmux Surface Discovery (cached) ===
let _surfaceCache: Map<string, string> = new Map();
let _surfaceCacheTime = 0;
const SURFACE_CACHE_TTL = 15_000;

function discoverCmuxSurfaces(): Map<string, string> {
  const now = Date.now();
  if (now - _surfaceCacheTime < SURFACE_CACHE_TTL && _surfaceCache.size > 0) return _surfaceCache;
  const map = new Map<string, string>();
  try {
    const paneResult = Bun.spawnSync(['cmux', 'list-panes', '--workspace', AGENT_POOL_WORKSPACE]);
    if (paneResult.exitCode !== 0) return map;
    const panes = paneResult.stdout.toString().match(/pane:\d+/g) || [];
    const surfaceRefs: string[] = [];
    for (const pane of panes) {
      try {
        const surfResult = Bun.spawnSync(['cmux', 'list-pane-surfaces', '--workspace', AGENT_POOL_WORKSPACE, '--pane', pane]);
        if (surfResult.exitCode !== 0) continue;
        for (const line of surfResult.stdout.toString().split('\n')) {
          const surfMatch = line.match(/(surface:\d+)\s+(.*)/);
          if (!surfMatch) continue;
          const [, surfRef, title] = surfMatch;
          const cm = title.match(/nebari-(\d{2})/);
          if (cm) { map.set(`agent-${cm[1]}`, surfRef); continue; }
          const am = title.match(/agent-(\d{2})/);
          if (am) { map.set(`agent-${am[1]}`, surfRef); continue; }
          if (title.includes('loop-dashboard') || title.includes('LOOP DASHBOARD') || title.includes('AGENT POOL') || title.includes('Manage agent pool')) continue;
          surfaceRefs.push(surfRef);
        }
      } catch {}
    }
    const stillUnmatched: string[] = [];
    for (const surfRef of surfaceRefs) {
      try {
        const capture = Bun.spawnSync(['cmux', 'capture-pane', '--workspace', AGENT_POOL_WORKSPACE, '--surface', surfRef]);
        if (capture.exitCode !== 0) continue;
        const text = capture.stdout.toString();
        const am = text.match(/agent-(\d{2})/); if (am) { map.set(`agent-${am[1]}`, surfRef); continue; }
        const cm = text.match(/nebari-(\d{2})/); if (cm) { map.set(`agent-${cm[1]}`, surfRef); continue; }
        stillUnmatched.push(surfRef);
      } catch {}
    }
    for (const surfRef of stillUnmatched) {
      try {
        const capture = Bun.spawnSync(['cmux', 'capture-pane', '--workspace', AGENT_POOL_WORKSPACE, '--surface', surfRef, '--scrollback']);
        if (capture.exitCode !== 0) continue;
        const text = capture.stdout.toString();
        const am = text.match(/agent-(\d{2})/); if (am) { map.set(`agent-${am[1]}`, surfRef); continue; }
        const cm = text.match(/nebari-(\d{2})/); if (cm) map.set(`agent-${cm[1]}`, surfRef);
      } catch {}
    }
  } catch {}
  _surfaceCache = map; _surfaceCacheTime = now;
  return map;
}

function captureAgentScreen(surface: string): string[] {
  try {
    const rows = process.stdout.rows || 24;
    const r = Bun.spawnSync(['cmux', 'capture-pane', '--workspace', AGENT_POOL_WORKSPACE, '--surface', surface, '--lines', String(rows)]);
    if (r.exitCode === 0) { const lines = r.stdout.toString().split('\n'); while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop(); return lines; }
  } catch {}
  return ['(could not capture screen)'];
}

function fetchRunLog(agentId: string, taskId: string): string[] | null {
  try {
    const p = join(LOGS_DIR, agentId, `${taskId}.log`);
    if (!existsSync(p)) return null;
    return readFileSync(p,'utf-8').replace(/\x1b\[[0-9;]*[a-zA-Z]/g,'').replace(/\r/g,'').split('\n').filter(l => l.trim()).slice(-30);
  } catch { return null; }
}

// === Config Field Builder ===
function buildConfigFields(proj: FullProject): ConfigField[] {
  const fields: ConfigField[] = [
    { key: 'name', label: 'Name', value: proj.name, editable: false, type: 'text' },
    { key: 'source', label: 'Source', value: proj.source, editable: true, type: 'text' },
    { key: 'prefix', label: 'Prefix', value: proj.prefix, editable: true, type: 'text' },
    { key: 'branch', label: 'Branch', value: proj.branch, editable: true, type: 'text' },
    { key: 'setup', label: 'Setup', value: proj.setup || '', editable: true, type: 'text' },
    // Tracking
    { key: 'trackingType', label: 'Type', value: proj.trackingType || '', editable: true, type: 'select', options: ['jira', 'linear', 'github', ''], section: 'Tracking' },
    { key: 'trackingProjectKey', label: 'Project Key', value: proj.trackingProjectKey || '', editable: true, type: 'text' },
    { key: 'trackingLabel', label: 'Label', value: proj.trackingLabel || '', editable: true, type: 'text' },
    { key: 'trackingInstructions', label: 'Instructions', value: proj.trackingInstructions || '', editable: true, type: 'text' },
    // Workflow
    { key: 'workflowType', label: 'Type', value: proj.workflowType || '', editable: true, type: 'select', options: ['feature-branch', 'direct-push', ''], section: 'Workflow' },
    { key: 'workflowInstructions', label: 'Instructions', value: proj.workflowInstructions || '', editable: true, type: 'text' },
    { key: 'workflowAutoMerge', label: 'Auto Merge', value: proj.workflowAutoMerge === null ? '' : proj.workflowAutoMerge ? 'yes' : 'no', editable: true, type: 'boolean' },
    { key: 'workflowMergeMethod', label: 'Merge Method', value: proj.workflowMergeMethod || '', editable: true, type: 'select', options: ['squash', 'merge', 'rebase', ''] },
    // Agent
    { key: 'agentType', label: 'Agent Type', value: proj.agentType || 'claude', editable: true, type: 'select', options: ['claude', 'codex', 'pi', ''], section: 'Agent' },
  ];
  return fields;
}

function buildEnvVars(proj: FullProject): EnvVarRow[] {
  if (!proj.envVars) return [];
  return Object.entries(proj.envVars).map(([key, value]) => ({ key, value }));
}

// === Docs Builder ===
function buildDocsEntries(agents: AgentInfo[]): DocsEntry[] {
  const entries: DocsEntry[] = [];
  const docsDir = join(DATA_DIR, 'docs');

  // Shared docs
  const sharedDir = join(docsDir, 'shared');
  entries.push({ type: 'header', label: 'Shared Docs', indent: 0 });
  if (existsSync(sharedDir)) {
    const files = readdirSync(sharedDir).filter(f => { try { return statSync(join(sharedDir, f)).isFile(); } catch { return false; } });
    if (files.length === 0) {
      entries.push({ type: 'header', label: '(empty)', indent: 1 });
    } else {
      for (const f of files) {
        const fp = join(sharedDir, f);
        const st = statSync(fp);
        entries.push({ type: 'file', label: f, path: fp, indent: 1, size: st.size, mtime: st.mtime });
      }
    }
  } else {
    entries.push({ type: 'header', label: '(no shared docs)', indent: 1 });
  }

  // Per-agent docs
  const agentsDocsDir = join(docsDir, 'agents');
  for (const agent of agents) {
    entries.push({ type: 'header', label: agent.id, indent: 0 });
    const agentDir = join(agentsDocsDir, agent.id);
    if (existsSync(agentDir)) {
      const files = readdirSync(agentDir).filter(f => { try { return statSync(join(agentDir, f)).isFile(); } catch { return false; } });
      if (files.length === 0) {
        entries.push({ type: 'header', label: '(no docs)', indent: 1 });
      } else {
        for (const f of files) {
          const fp = join(agentDir, f);
          const st = statSync(fp);
          entries.push({ type: 'file', label: f, path: fp, indent: 1, size: st.size, mtime: st.mtime });
        }
      }
    } else {
      entries.push({ type: 'header', label: '(no docs)', indent: 1 });
    }
  }
  return entries;
}

// === State ===
type Mode = 'main' | 'project-picker' | 'tasks' | 'input' | 'config' | 'config-input' | 'docs' | 'doc-view';
let mode: Mode = 'main';
let selectables: SelectableRow[] = [];
let cursorPos = 0;
let flashMessage: string | null = null;
let flashTimeout: ReturnType<typeof setTimeout> | null = null;
let detailPanel: string[] | null = null;
let detailTitle: string | null = null;
let liveAgentSurface: string | null = null;

// Project picker state
let projects: ProjectRow[] = [];

// Task view state
let taskList: TaskRow[] = [];
let taskCursor = 0;

// Input mode state
let inputBuffer = '';
let inputLabel = '';
let inputTarget: string | null = null;

// Config view state
let configProject: FullProject | null = null;
let configFields: ConfigField[] = [];
let configEnvVars: EnvVarRow[] = [];
let configCursor = 0;
let configInputField: string | null = null;
// For two-step env var creation: 'key' → entering key, 'value' → entering value
let envInputStep: 'key' | 'value' | null = null;
let envInputKey = '';

// Docs view state
let docsEntries: DocsEntry[] = [];
let docsCursor = 0;
let docContent: string[] = [];
let docTitle = '';
let docScrollOffset = 0;

// Main view inline tasks
let mainTasks: TaskRow[] = [];

function flash(msg: string) { flashMessage = msg; if (flashTimeout) clearTimeout(flashTimeout); flashTimeout = setTimeout(() => { flashMessage = null; }, 3000); }

// === Render: Frame wrapper ===
function writeFrame(lines: string[]) {
  const cols = process.stdout.columns || 80;
  const termRows = process.stdout.rows || 24;
  while (lines.length < termRows) lines.push('');
  const output = lines.slice(0, termRows).map(l => {
    const len = stripAnsi(l).length;
    return len < cols ? l + ' '.repeat(cols - len) : l;
  }).join('\n');
  process.stdout.write('\x1b[H' + output);
}

// === Render: Main Dashboard (agents-first) ===
function renderMain(loops: LoopDef[], loopRuns: Map<string, RunInfo[]>, agents: AgentInfo[], project: string) {
  const cols = process.stdout.columns || 80;
  const termRows = process.stdout.rows || 24;
  const lines: string[] = [];
  const newSelectables: SelectableRow[] = [];
  const now = new Date();
  const innerW = cols - 5;
  const aIdW = Math.max(12, Math.floor(innerW * 0.12));
  const aStatW = Math.max(14, Math.floor(innerW * 0.14));
  const sNameW = Math.max(16, Math.floor(innerW * 0.25));
  const sIntW = Math.max(12, Math.floor(innerW * 0.15));
  const sNextW = Math.max(14, Math.floor(innerW * 0.18));

  const pushSel = (row: SelectableRow, line: string) => {
    newSelectables.push(row);
    const isSel = newSelectables.length - 1 === cursorPos;
    lines.push(isSel ? bgBlue(line + ' '.repeat(Math.max(0, cols - stripAnsi(line).length))) : line);
  };

  const timeStr = now.toLocaleTimeString('en-US', { hour12: false });
  lines.push('');
  lines.push(` ${bold('AGENT POOL')} ${dim('—')} ${cyan(project)}${' '.repeat(Math.max(1, cols - 30 - project.length))}${dim(timeStr)}`);
  lines.push('');

  // Agents (first section)
  const working = agents.filter(a => a.taskId).length;
  const idle = agents.filter(a => !a.taskId && a.locked).length;
  const offline = agents.filter(a => !a.taskId && !a.locked).length;
  lines.push(` ${bold('Agents')}  ${dim(`${working} working  ${idle} idle  ${offline} offline`)}`);
  for (let ai = 0; ai < agents.length; ai++) {
    const a = agents[ai]; let status: string, detail: string;
    if (a.taskId) { status = yellow('● working'); detail = a.taskId; if (a.heartbeatAge != null) { detail += `  ${(a.heartbeatAge > 5*60*1000 ? red : dim)(fmtAge(a.heartbeatAge))}`; if (a.heartbeatTool) detail += dim(` ${a.heartbeatTool}`); } }
    else if (a.locked) { status = green('● idle'); detail = dim('waiting for tasks'); }
    else { status = dim('○ offline'); detail = dim('-'); }
    pushSel({ type: 'agent', agentIndex: ai, label: a.id }, `   ${pad(dim(a.id), aIdW)}${pad(status, aStatW)}${detail}`);
  }
  if (agents.length === 0) lines.push(`   ${dim('No agents — run agent-pool init')}`);
  lines.push('');

  // Tasks (inline summary — top non-completed)
  const taskCounts: Record<string, number> = {};
  for (const t of mainTasks) taskCounts[t.status] = (taskCounts[t.status] || 0) + 1;
  // Also count from full task list for the summary line
  const allTaskSummary = fetchTaskCounts();
  const summaryParts: string[] = [];
  for (const [s, n] of Object.entries(allTaskSummary)) {
    if (n > 0) summaryParts.push(`${n} ${s}`);
  }
  lines.push(` ${bold('Tasks')}  ${dim(summaryParts.join('  ') || 'none')}`);

  const maxInlineTasks = Math.min(5, Math.max(2, termRows - agents.length - 12));
  const visibleTasks = mainTasks.slice(0, maxInlineTasks);
  if (visibleTasks.length === 0) {
    lines.push(`   ${dim('No active tasks')}`);
  } else {
    const tIdW = Math.max(16, Math.floor(innerW * 0.18));
    const tStatW = Math.max(14, Math.floor(innerW * 0.14));
    const tAgentW = Math.max(12, Math.floor(innerW * 0.12));
    for (let ti = 0; ti < visibleTasks.length; ti++) {
      const t = visibleTasks[ti];
      const prioStr = t.priority > 0 ? yellow(`P${t.priority}`) : dim('P0');
      const promptSnip = t.prompt.split('\n')[0].slice(0, cols - tIdW - tStatW - tAgentW - 14);
      pushSel({ type: 'task-summary', taskIndex: ti, label: t.id },
        `   ${pad(dim(t.id), tIdW)}${pad(`${statusIcon(t.status)} ${statusColor(t.status)(t.status)}`, tStatW)}${pad(dim(t.claimedBy || '-'), tAgentW)}${dim(promptSnip)}`);
    }
  }
  lines.push('');

  // Schedules (moved below, hidden if none)
  if (loops.length > 0) {
    lines.push(` ${bold('Schedules')}`);
    for (let i = 0; i < loops.length; i++) {
      const loop = loops[i]; const runs = loopRuns.get(loop.name) || []; const last = runs[0];
      let sched = dim('no cron'), next = '';
      if (loop.cronExpr) { sched = dim(fmtCron(loop.cronExpr)); const nf = nextCronFire(loop.cronExpr, now); next = nf ? dim('next ' + fmtTime(nf.toISOString())) : ''; }
      let lastSt = ''; if (last) { lastSt = `${statusIcon(last.status)} ${dim(fmtAge(Date.now() - new Date(last.createdAt).getTime()))}`; }
      pushSel({ type: 'loop', loopIndex: i, label: loop.name }, `   ${pad(cyan(loop.name), sNameW)}${pad(sched, sIntW)}${pad(next, sNextW)}${lastSt}`);
    }
    lines.push('');
  }

  // Actions
  lines.push(` ${bold('Actions')}`);
  pushSel({ type: 'action', action: 'add-agent', label: 'Add agent' }, `   ${green('+')} Add new agent`);
  pushSel({ type: 'action', action: 'restart-all', label: 'Restart all' }, `   ${yellow('↻')} Restart stale agents`);
  lines.push('');

  // Detail Panel
  if (detailPanel && detailPanel.length > 0) {
    lines.push(` ${bold(detailTitle || 'Detail')} ${dim('(esc to close)')}`);
    lines.push(` ${dim('─'.repeat(cols - 4))}`);
    const minDetail = Math.floor(termRows * 0.5);
    const remaining = termRows - lines.length - 2;
    const maxDetail = Math.min(detailPanel.length, Math.max(minDetail, remaining));
    for (let i = 0; i < maxDetail; i++) lines.push(`   ${detailPanel[i].slice(0, cols - 6)}`);
    if (detailPanel.length > maxDetail) lines.push(`   ${dim(`… ${detailPanel.length - maxDetail} more lines`)}`);
    lines.push('');
  }

  // Footer
  if (flashMessage) { lines.push(` ${green(flashMessage)}`); }
  else { lines.push(` ${dim('↑↓ navigate │ enter select │ p project │ t tasks │ c config │ d docs │ r refresh │ q quit')}`); }

  selectables = newSelectables;
  if (cursorPos >= selectables.length) cursorPos = Math.max(0, selectables.length - 1);
  writeFrame(lines);
}

// Helper: count tasks by status for the current project (uses cached data from tick)
let _taskCountsCache: Record<string, number> = {};
function fetchTaskCounts(): Record<string, number> { return _taskCountsCache; }

// === Render: Project Picker ===
function renderProjectPicker(currentProject: string) {
  const cols = process.stdout.columns || 80;
  const lines: string[] = [];
  const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false });
  lines.push('');
  lines.push(` ${bold('SELECT PROJECT')}${' '.repeat(Math.max(1, cols - 32))}${dim(timeStr)}`);
  lines.push('');
  for (let i = 0; i < projects.length && i < 9; i++) {
    const p = projects[i];
    const marker = p.name === currentProject ? cyan(' ●') : '  ';
    const def = p.isDefault ? dim(' (default)') : '';
    lines.push(`   ${dim(`[${i + 1}]`)} ${bold(p.name)}${def}${marker}`);
  }
  lines.push('');
  lines.push(` ${dim('1-' + Math.min(projects.length, 9) + ' select  │  esc cancel')}`);
  writeFrame(lines);
}

// === Render: Task List ===
function renderTasks(project: string, db: Database) {
  const cols = process.stdout.columns || 80;
  const termRows = process.stdout.rows || 24;
  const lines: string[] = [];
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour12: false });

  const idW = Math.max(18, Math.floor(cols * 0.16));
  const prioW = 6;
  const statW = Math.max(14, Math.floor(cols * 0.12));
  const agentW = Math.max(12, Math.floor(cols * 0.10));
  const promptW = cols - idW - prioW - statW - agentW - 8;

  lines.push('');
  lines.push(` ${bold('TASKS')} ${dim('—')} ${cyan(project)}${' '.repeat(Math.max(1, cols - 24 - project.length))}${dim(timeStr)}`);
  lines.push(` ${dim('─'.repeat(cols - 2))}`);

  if (taskList.length === 0) {
    lines.push(`   ${dim('No tasks')}`);
  } else {
    lines.push(`   ${pad(dim('ID'), idW)}${pad(dim('P'), prioW)}${pad(dim('Status'), statW)}${pad(dim('Agent'), agentW)}${dim('Prompt')}`);

    const maxVisible = termRows - 8;
    const startIdx = Math.max(0, taskCursor - maxVisible + 2);
    const endIdx = Math.min(taskList.length, startIdx + maxVisible);

    for (let i = startIdx; i < endIdx; i++) {
      const t = taskList[i];
      const isSel = i === taskCursor;
      const prioStr = t.priority > 0 ? yellow(`P${t.priority}`) : dim('P0');
      const promptSnip = t.prompt.split('\n')[0].slice(0, promptW);
      const line = `   ${pad(dim(t.id), idW)}${pad(prioStr, prioW)}${pad(statusColor(t.status)(t.status), statW)}${pad(dim(t.claimedBy || '-'), agentW)}${dim(promptSnip)}`;
      lines.push(isSel ? bgBlue(line + ' '.repeat(Math.max(0, cols - stripAnsi(line).length))) : line);
    }
  }
  lines.push('');

  if (flashMessage) { lines.push(` ${green(flashMessage)}`); }
  else if (mode === 'input') {
    lines.push(` ${dim('─'.repeat(cols - 2))}`);
    process.stdout.write('\x1b[?25h');
    lines.push(` ${bold(inputLabel)} ${inputBuffer}█`);
  } else {
    lines.push(` ${dim('↑↓ navigate  │  c create  │  e edit  │  d delete  │  esc back')}`);
  }

  writeFrame(lines);
}

// === Render: Project Config ===
function renderConfig(project: string) {
  const cols = process.stdout.columns || 80;
  const lines: string[] = [];
  const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false });

  lines.push('');
  lines.push(` ${bold('PROJECT CONFIG')} ${dim('—')} ${cyan(project)}${' '.repeat(Math.max(1, cols - 32 - project.length))}${dim(timeStr)}`);
  lines.push(` ${dim('─'.repeat(cols - 2))}`);

  if (!configProject) {
    lines.push(`   ${red('Project not found')}`);
    lines.push('');
    lines.push(` ${dim('esc back │ q quit')}`);
    writeFrame(lines);
    return;
  }

  const labelW = 20;
  let selectIdx = 0;
  let lastSection: string | undefined;

  for (let i = 0; i < configFields.length; i++) {
    const f = configFields[i];

    // Section header
    if (f.section && f.section !== lastSection) {
      lines.push('');
      lines.push(` ${bold(f.section)}`);
      lastSection = f.section;
    } else if (i === 0) {
      // First group has no section header
    }

    const isSel = mode !== 'config-input' && selectIdx === configCursor;
    const valueDisplay = f.value || dim('(not set)');
    const editHint = !f.editable ? dim(' (read-only)') : f.type === 'select' ? dim(' ←→') : f.type === 'boolean' ? dim(' toggle') : '';
    let line = `   ${pad(dim(f.label), labelW)}${valueDisplay}${editHint}`;

    if (isSel) {
      lines.push(bgBlue(line + ' '.repeat(Math.max(0, cols - stripAnsi(line).length))));
    } else {
      lines.push(line);
    }
    selectIdx++;
  }

  // Environment Variables section
  lines.push('');
  lines.push(` ${bold('Environment Variables')}`);
  if (configEnvVars.length === 0) {
    lines.push(`   ${dim('(none)')}`);
  } else {
    for (let ei = 0; ei < configEnvVars.length; ei++) {
      const ev = configEnvVars[ei];
      const isSel = mode !== 'config-input' && selectIdx === configCursor;
      const maskedVal = ev.value.length > 8 ? ev.value.slice(0, 4) + '…' + ev.value.slice(-4) : ev.value;
      let line = `   ${pad(dim(ev.key), labelW)}${dim(maskedVal)}`;
      if (isSel) {
        lines.push(bgBlue(line + ' '.repeat(Math.max(0, cols - stripAnsi(line).length))));
      } else {
        lines.push(line);
      }
      selectIdx++;
    }
  }
  // Add env var action
  const addEnvSel = mode !== 'config-input' && selectIdx === configCursor;
  const addLine = `   ${green('+')} Add environment variable`;
  lines.push(addEnvSel ? bgBlue(addLine + ' '.repeat(Math.max(0, cols - stripAnsi(addLine).length))) : addLine);
  selectIdx++;

  lines.push('');

  // Footer / input
  if (mode === 'config-input') {
    lines.push(` ${dim('─'.repeat(cols - 2))}`);
    process.stdout.write('\x1b[?25h');
    lines.push(` ${bold(inputLabel)} ${inputBuffer}█`);
  } else if (flashMessage) {
    lines.push(` ${green(flashMessage)}`);
  } else {
    lines.push(` ${dim('↑↓ navigate │ enter edit │ d delete env │ esc back │ q quit')}`);
  }

  writeFrame(lines);
}

// === Render: Docs Browser ===
function renderDocs(project: string) {
  const cols = process.stdout.columns || 80;
  const termRows = process.stdout.rows || 24;
  const lines: string[] = [];
  const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false });

  lines.push('');
  lines.push(` ${bold('DOCS')} ${dim('—')} ${cyan(project)}${' '.repeat(Math.max(1, cols - 22 - project.length))}${dim(timeStr)}`);
  lines.push(` ${dim('─'.repeat(cols - 2))}`);

  const nameW = Math.max(30, Math.floor(cols * 0.45));
  const dateW = 12;
  const sizeW = 10;

  const maxVisible = termRows - 6;
  const startIdx = Math.max(0, docsCursor - maxVisible + 2);

  for (let i = 0; i < docsEntries.length; i++) {
    if (lines.length > maxVisible + 3) break;
    const entry = docsEntries[i];

    if (entry.type === 'header') {
      if (entry.indent === 0) {
        lines.push('');
        lines.push(` ${bold(entry.label)}`);
      } else {
        lines.push(`   ${dim(entry.label)}`);
      }
    } else {
      const isSel = i === docsCursor;
      const dateStr = entry.mtime ? fmtDate(entry.mtime.toISOString()) : '';
      const sizeStr = entry.size != null ? fmtSize(entry.size) : '';
      const line = `   ${pad(entry.label, nameW)}${pad(dim(dateStr), dateW)}${dim(sizeStr)}`;
      lines.push(isSel ? bgBlue(line + ' '.repeat(Math.max(0, cols - stripAnsi(line).length))) : line);
    }
  }

  lines.push('');
  if (flashMessage) { lines.push(` ${green(flashMessage)}`); }
  else { lines.push(` ${dim('↑↓ navigate │ enter open │ r refresh │ esc back │ q quit')}`); }

  writeFrame(lines);
}

// === Render: Doc View ===
function renderDocView() {
  const cols = process.stdout.columns || 80;
  const termRows = process.stdout.rows || 24;
  const lines: string[] = [];

  lines.push('');
  lines.push(` ${bold(docTitle)}${' '.repeat(Math.max(1, cols - stripAnsi(docTitle).length - 4))}`);
  lines.push(` ${dim('─'.repeat(cols - 2))}`);

  const viewableRows = termRows - 5;
  const endOffset = Math.min(docScrollOffset + viewableRows, docContent.length);

  for (let i = docScrollOffset; i < endOffset; i++) {
    lines.push(`  ${docContent[i].slice(0, cols - 4)}`);
  }

  lines.push('');
  const posStr = docContent.length > 0 ? `[${docScrollOffset + 1}-${endOffset}/${docContent.length}]` : '';
  lines.push(` ${dim('↑↓/j/k scroll │ esc back │ q quit')}${' '.repeat(Math.max(1, cols - 42 - posStr.length))}${dim(posStr)}`);

  writeFrame(lines);
}

// === Main Mode Actions ===
function handleMainEnter(loops: LoopDef[], loopRuns: Map<string, RunInfo[]>, agents: AgentInfo[], project: string) {
  if (cursorPos >= selectables.length) return;
  const sel = selectables[cursorPos];
  if (sel.type === 'loop' && sel.loopIndex != null) {
    // Show recent runs in detail panel instead of triggering
    const runs = loopRuns.get(loops[sel.loopIndex].name) || [];
    if (runs.length > 0) {
      detailTitle = `Runs: ${loops[sel.loopIndex].name}`;
      detailPanel = runs.slice(0, 8).map(r => {
        const dateStr = isToday(r.createdAt) ? '' : fmtDate(r.createdAt) + ' ';
        return `${statusIcon(r.status)} ${dateStr}${fmtTime(r.createdAt)}  ${statusColor(r.status)(r.status.padEnd(12))} ${fmtDuration(r.startedAt, r.completedAt).padEnd(10)} ${dim(r.claimedBy || '-')}`;
      });
    } else {
      Bun.spawn(['bash', loops[sel.loopIndex].scriptPath], { stdout: 'ignore', stderr: 'ignore' });
      flash(`▶ Triggered ${loops[sel.loopIndex].name}`);
    }
  } else if (sel.type === 'agent' && sel.agentIndex != null) {
    const agent = agents[sel.agentIndex]; detailTitle = agent.id;
    if (agent.cmuxSurface) { liveAgentSurface = agent.cmuxSurface; detailPanel = captureAgentScreen(agent.cmuxSurface); }
    else if (agent.taskId) { detailPanel = [`Task: ${agent.taskId}`, `Heartbeat: ${agent.heartbeatAge != null ? fmtAge(agent.heartbeatAge) : '?'}`, `Tool: ${agent.heartbeatTool || '?'}`, '', ...(agent.taskPrompt || '').split('\n').map(l => `  ${l}`), '', dim('(no cmux surface)')]; }
    else { detailPanel = [agent.locked ? 'Idle' : 'Offline']; }
  } else if (sel.type === 'task-summary' && sel.taskIndex != null) {
    const t = mainTasks[sel.taskIndex];
    if (t) {
      detailTitle = `Task: ${t.id}`;
      detailPanel = [
        `ID: ${t.id}`,
        `Status: ${t.status}`,
        `Priority: ${t.priority}`,
        `Agent: ${t.claimedBy || '-'}`,
        `Created: ${t.createdAt}`,
        t.startedAt ? `Started: ${t.startedAt}` : '',
        '',
        ...t.prompt.split('\n').map(l => `  ${l}`),
      ].filter(Boolean);
    }
  } else if (sel.type === 'action') {
    if (sel.action === 'add-agent') addAgent(project);
    else if (sel.action === 'restart-all') restartStaleAgents(agents, project);
  }
}

function addAgent(project: string) {
  try {
    const result = Bun.spawnSync(['cmux', 'new-pane', '--workspace', AGENT_POOL_WORKSPACE]);
    if (result.exitCode !== 0) { flash('✗ Failed to create pane'); return; }
    const surfaceMatch = result.stdout.toString().match(/surface:\d+/);
    const surface = surfaceMatch ? surfaceMatch[0] : null;
    const poolJson = join(DATA_DIR, `pool-${project}.json`);
    let nextIndex = 0;
    if (existsSync(poolJson)) { const pool = JSON.parse(readFileSync(poolJson, 'utf-8')); const indices = pool.clones.map((c: any) => c.index); while (indices.includes(nextIndex)) nextIndex++; }
    const cmd = `cd ${join(DATA_DIR, `${project}-${String(nextIndex).padStart(2, '0')}`)} 2>/dev/null || true && ${AGENT_POOL_BIN} run-agent ${nextIndex} -p ${project}`;
    if (surface) Bun.spawnSync(['cmux', 'send', '--workspace', AGENT_POOL_WORKSPACE, '--surface', surface, cmd + '\n']);
    flash(`▶ Starting agent-${String(nextIndex).padStart(2, '0')}`);
  } catch (e: any) { flash(`✗ ${e.message}`); }
}

function restartStaleAgents(agents: AgentInfo[], project: string) {
  let n = 0;
  for (const a of agents) {
    if (a.taskId) continue;
    if ((!a.locked || (a.locked && (a.heartbeatAge == null || a.heartbeatAge > 5*60*1000))) && a.cmuxSurface) {
      Bun.spawnSync(['cmux', 'send-key', '--workspace', AGENT_POOL_WORKSPACE, '--surface', a.cmuxSurface, 'C-c']);
      const cmd = `${AGENT_POOL_BIN} run-agent ${a.cloneIndex} -p ${project}`;
      setTimeout(() => { Bun.spawnSync(['cmux', 'send', '--workspace', AGENT_POOL_WORKSPACE, '--surface', a.cmuxSurface!, cmd + '\n']); }, 500);
      n++;
    }
  }
  flash(n > 0 ? `↻ Restarting ${n} agent${n > 1 ? 's' : ''}` : 'No agents need restart');
}

// === Config Actions ===
function getConfigTotalItems(): number {
  return configFields.length + configEnvVars.length + 1; // +1 for "Add env var"
}

function handleConfigEnter(db: Database, project: string) {
  const totalFields = configFields.length;
  const totalEnv = configEnvVars.length;

  if (configCursor < totalFields) {
    // Editing a config field
    const field = configFields[configCursor];
    if (!field.editable) return;

    if (field.type === 'boolean') {
      // Toggle: '' → 'yes' → 'no' → ''
      const next = field.value === '' ? 'yes' : field.value === 'yes' ? 'no' : '';
      const dbVal = next === 'yes' ? true : next === 'no' ? false : null;
      updateProjectField(db, project, field.key, dbVal);
      field.value = next;
      flash(`✓ ${field.label} = ${next || '(cleared)'}`);
    } else if (field.type === 'select' && field.options) {
      // Cycle through options
      const idx = field.options.indexOf(field.value);
      const next = field.options[(idx + 1) % field.options.length];
      updateProjectField(db, project, field.key, next || null);
      field.value = next;
      flash(`✓ ${field.label} = ${next || '(cleared)'}`);
    } else {
      // Text input
      mode = 'config-input';
      configInputField = field.key;
      inputLabel = `${field.label}:`;
      inputBuffer = field.value;
      envInputStep = null;
    }
  } else if (configCursor < totalFields + totalEnv) {
    // Editing an existing env var value
    const envIdx = configCursor - totalFields;
    const ev = configEnvVars[envIdx];
    mode = 'config-input';
    configInputField = `env:${ev.key}`;
    inputLabel = `${ev.key}:`;
    inputBuffer = ev.value;
    envInputStep = null;
  } else {
    // "Add env var" action
    mode = 'config-input';
    envInputStep = 'key';
    inputLabel = 'Env var name:';
    inputBuffer = '';
    configInputField = null;
  }
}

function handleConfigInputSubmit(db: Database, project: string) {
  const value = inputBuffer.trim();

  if (envInputStep === 'key') {
    if (!value) { mode = 'config'; envInputStep = null; return; }
    envInputKey = value;
    envInputStep = 'value';
    inputLabel = `${envInputKey}:`;
    inputBuffer = '';
    return;
  }

  if (envInputStep === 'value') {
    if (configProject) {
      const envVars = { ...(configProject.envVars || {}), [envInputKey]: value };
      updateProjectField(db, project, 'envVars', envVars);
      configProject.envVars = envVars;
      configEnvVars = buildEnvVars(configProject);
      flash(`✓ Set ${envInputKey}`);
    }
    mode = 'config';
    envInputStep = null;
    envInputKey = '';
    process.stdout.write('\x1b[?25l');
    return;
  }

  // Regular field edit
  if (configInputField && configInputField.startsWith('env:')) {
    const envKey = configInputField.slice(4);
    if (configProject) {
      const envVars = { ...(configProject.envVars || {}), [envKey]: value };
      updateProjectField(db, project, 'envVars', envVars);
      configProject.envVars = envVars;
      configEnvVars = buildEnvVars(configProject);
      flash(`✓ Updated ${envKey}`);
    }
  } else if (configInputField) {
    updateProjectField(db, project, configInputField, value);
    // Update the field in the list
    const field = configFields.find(f => f.key === configInputField);
    if (field) field.value = value;
    flash(`✓ Updated ${configInputField}`);
  }

  mode = 'config';
  configInputField = null;
  process.stdout.write('\x1b[?25l');
}

function handleConfigDeleteEnv(db: Database, project: string) {
  const totalFields = configFields.length;
  const envIdx = configCursor - totalFields;
  if (envIdx < 0 || envIdx >= configEnvVars.length) return;

  const ev = configEnvVars[envIdx];
  if (configProject) {
    const envVars = { ...(configProject.envVars || {}) };
    delete envVars[ev.key];
    const newVal = Object.keys(envVars).length > 0 ? envVars : null;
    updateProjectField(db, project, 'envVars', newVal);
    configProject.envVars = newVal;
    configEnvVars = buildEnvVars(configProject);
    if (configCursor >= getConfigTotalItems()) configCursor = Math.max(0, getConfigTotalItems() - 1);
    flash(`✗ Deleted ${ev.key}`);
  }
}

// === Main ===
function main() {
  if (!existsSync(DB_PATH)) { console.error(`Database not found: ${DB_PATH}`); process.exit(1); }

  const db = new Database(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');

  let loops = discoverLoops();
  let project = DEFAULT_PROJECT;
  try {
    const row = db.query("SELECT name FROM projects WHERE name = ?").get(project) as any;
    if (!row) { const f = db.query("SELECT name FROM projects LIMIT 1").get() as any; if (f) project = f.name; }
  } catch {}

  process.stdout.write('\x1b[?1049h\x1b[?25l');

  const cleanup = () => { process.stdout.write('\x1b[?25h\x1b[?1049l'); db.close(); process.exit(0); };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  let loopRuns = new Map<string, RunInfo[]>();
  let agents: AgentInfo[] = [];

  function tick() {
    if (mode === 'tasks' || mode === 'input') {
      taskList = fetchTasks(db, project);
      if (taskCursor >= taskList.length) taskCursor = Math.max(0, taskList.length - 1);
      renderTasks(project, db);
    } else if (mode === 'project-picker') {
      renderProjectPicker(project);
    } else if (mode === 'config' || mode === 'config-input') {
      configProject = fetchFullProject(db, project);
      if (configProject) {
        configFields = buildConfigFields(configProject);
        configEnvVars = buildEnvVars(configProject);
      }
      renderConfig(project);
    } else if (mode === 'docs') {
      // Don't rescan filesystem every tick — only re-render
      renderDocs(project);
    } else if (mode === 'doc-view') {
      renderDocView();
    } else {
      // Main mode
      loopRuns = new Map();
      for (const l of loops) loopRuns.set(l.name, fetchRuns(db, l.promptPrefix));
      agents = fetchAgents(db, project);
      mainTasks = fetchTasks(db, project).filter(t => t.status !== 'completed').slice(0, 10);
      // Update task counts cache
      const allTasks = fetchTasks(db, project);
      _taskCountsCache = {};
      for (const t of allTasks) _taskCountsCache[t.status] = (_taskCountsCache[t.status] || 0) + 1;
      if (liveAgentSurface) detailPanel = captureAgentScreen(liveAgentSurface);
      renderMain(loops, loopRuns, agents, project);
    }
  }

  function redraw() {
    if (mode === 'tasks' || mode === 'input') renderTasks(project, db);
    else if (mode === 'project-picker') renderProjectPicker(project);
    else if (mode === 'config' || mode === 'config-input') renderConfig(project);
    else if (mode === 'docs') renderDocs(project);
    else if (mode === 'doc-view') renderDocView();
    else renderMain(loops, loopRuns, agents, project);
  }

  process.stdin.on('data', (buf: Buffer) => {
    // === Input mode (task create/edit) ===
    if (mode === 'input') {
      if (buf[0] === 0x1b) { mode = 'tasks'; inputBuffer = ''; process.stdout.write('\x1b[?25l'); redraw(); }
      else if (buf[0] === 0x0d) {
        if (inputBuffer.trim()) {
          if (inputTarget) { editTaskPrompt(db, inputTarget, inputBuffer.trim()); flash(`✓ Updated ${inputTarget}`); }
          else { const id = createTask(db, project, inputBuffer.trim()); flash(`✓ Created ${id}`); }
          taskList = fetchTasks(db, project);
        }
        mode = 'tasks'; inputBuffer = ''; inputTarget = null; process.stdout.write('\x1b[?25l'); redraw();
      } else if (buf[0] === 0x7f || buf[0] === 0x08) { inputBuffer = inputBuffer.slice(0, -1); redraw(); }
      else if (buf[0] >= 0x20 && buf[0] < 0x7f) { inputBuffer += String.fromCharCode(buf[0]); redraw(); }
      else if (buf.length > 1) { inputBuffer += buf.toString('utf-8'); redraw(); }
      return;
    }

    // === Config input mode ===
    if (mode === 'config-input') {
      if (buf[0] === 0x1b) {
        mode = 'config'; inputBuffer = ''; configInputField = null; envInputStep = null;
        process.stdout.write('\x1b[?25l'); redraw();
      } else if (buf[0] === 0x0d) {
        handleConfigInputSubmit(db, project);
        redraw();
      } else if (buf[0] === 0x7f || buf[0] === 0x08) { inputBuffer = inputBuffer.slice(0, -1); redraw(); }
      else if (buf[0] >= 0x20 && buf[0] < 0x7f) { inputBuffer += String.fromCharCode(buf[0]); redraw(); }
      else if (buf.length > 1) { inputBuffer += buf.toString('utf-8'); redraw(); }
      return;
    }

    // === Project picker mode ===
    if (mode === 'project-picker') {
      if (buf[0] === 0x1b) { mode = 'main'; cursorPos = 0; tick(); }
      else if (buf[0] >= 0x31 && buf[0] <= 0x39) {
        const idx = buf[0] - 0x31;
        if (idx < projects.length) { project = projects[idx].name; mode = 'main'; cursorPos = 0; loops = discoverLoops(); flash(`Switched to ${project}`); tick(); }
      }
      return;
    }

    // === Config mode ===
    if (mode === 'config') {
      if (buf.length === 3 && buf[0] === 0x1b && buf[1] === 0x5b) {
        if (buf[2] === 0x41) { configCursor = Math.max(0, configCursor - 1); redraw(); }
        else if (buf[2] === 0x42) { configCursor = Math.min(getConfigTotalItems() - 1, configCursor + 1); redraw(); }
        return;
      }
      const ch = buf[0];
      if (ch === 0x1b) { mode = 'main'; cursorPos = 0; process.stdout.write('\x1b[?25l'); tick(); }
      else if (ch === 0x71 || ch === 0x03) cleanup();
      else if (ch === 0x0d) { handleConfigEnter(db, project); redraw(); }
      else if (ch === 0x64) { handleConfigDeleteEnv(db, project); redraw(); } // d — delete env
      else if (ch === 0x72) { tick(); } // r — refresh
      return;
    }

    // === Docs browser mode ===
    if (mode === 'docs') {
      if (buf.length === 3 && buf[0] === 0x1b && buf[1] === 0x5b) {
        if (buf[2] === 0x41) { // Up
          let next = docsCursor - 1;
          while (next >= 0 && docsEntries[next].type === 'header') next--;
          if (next >= 0) { docsCursor = next; redraw(); }
        } else if (buf[2] === 0x42) { // Down
          let next = docsCursor + 1;
          while (next < docsEntries.length && docsEntries[next].type === 'header') next++;
          if (next < docsEntries.length) { docsCursor = next; redraw(); }
        }
        return;
      }
      const ch = buf[0];
      if (ch === 0x1b) { mode = 'main'; cursorPos = 0; tick(); }
      else if (ch === 0x71 || ch === 0x03) cleanup();
      else if (ch === 0x72) { // r — refresh
        docsEntries = buildDocsEntries(agents);
        docsCursor = docsEntries.findIndex(e => e.type === 'file');
        if (docsCursor < 0) docsCursor = 0;
        flash('↻ Refreshed');
        redraw();
      }
      else if (ch === 0x0d) { // Enter — open file
        const entry = docsEntries[docsCursor];
        if (entry?.type === 'file' && entry.path) {
          try {
            const raw = readFileSync(entry.path, 'utf-8');
            docContent = raw.split('\n').slice(0, 500);
            docTitle = entry.label;
            docScrollOffset = 0;
            mode = 'doc-view';
            redraw();
          } catch (e: any) {
            flash(`✗ ${e.message}`);
          }
        }
      }
      return;
    }

    // === Doc view mode ===
    if (mode === 'doc-view') {
      if (buf.length === 3 && buf[0] === 0x1b && buf[1] === 0x5b) {
        const viewableRows = (process.stdout.rows || 24) - 5;
        if (buf[2] === 0x41) { docScrollOffset = Math.max(0, docScrollOffset - 1); redraw(); }
        else if (buf[2] === 0x42) { docScrollOffset = Math.min(Math.max(0, docContent.length - viewableRows), docScrollOffset + 1); redraw(); }
        return;
      }
      const ch = buf[0];
      if (ch === 0x1b) { mode = 'docs'; redraw(); }
      else if (ch === 0x71 || ch === 0x03) cleanup();
      else if (ch === 0x6a) { // j
        const viewableRows = (process.stdout.rows || 24) - 5;
        docScrollOffset = Math.min(Math.max(0, docContent.length - viewableRows), docScrollOffset + 1); redraw();
      } else if (ch === 0x6b) { // k
        docScrollOffset = Math.max(0, docScrollOffset - 1); redraw();
      }
      return;
    }

    // === Tasks mode ===
    if (mode === 'tasks') {
      if (buf.length === 3 && buf[0] === 0x1b && buf[1] === 0x5b) {
        if (buf[2] === 0x41) { taskCursor = Math.max(0, taskCursor - 1); redraw(); }
        else if (buf[2] === 0x42) { taskCursor = Math.min(taskList.length - 1, taskCursor + 1); redraw(); }
        return;
      }
      const ch = buf[0];
      if (ch === 0x1b) { mode = 'main'; cursorPos = 0; process.stdout.write('\x1b[?25l'); tick(); }
      else if (ch === 0x71 || ch === 0x03) cleanup();
      else if (ch === 0x63) { // c — create
        mode = 'input'; inputLabel = 'New task:'; inputBuffer = ''; inputTarget = null; redraw();
      } else if (ch === 0x65 && taskList.length > 0) { // e — edit
        const t = taskList[taskCursor];
        mode = 'input'; inputLabel = `Edit ${t.id}:`; inputBuffer = t.prompt.split('\n')[0]; inputTarget = t.id; redraw();
      } else if (ch === 0x64 && taskList.length > 0) { // d — delete (cancel)
        const t = taskList[taskCursor];
        cancelTask(db, t.id);
        taskList = fetchTasks(db, project);
        if (taskCursor >= taskList.length) taskCursor = Math.max(0, taskList.length - 1);
        flash(`✗ Cancelled ${t.id}`);
        redraw();
      } else if (ch === 0x72) { tick(); }
      return;
    }

    // === Main mode ===
    if (buf.length === 3 && buf[0] === 0x1b && buf[1] === 0x5b) {
      if (buf[2] === 0x41) { cursorPos = Math.max(0, cursorPos - 1); detailPanel = null; liveAgentSurface = null; redraw(); }
      else if (buf[2] === 0x42) { cursorPos = Math.min(selectables.length - 1, cursorPos + 1); detailPanel = null; liveAgentSurface = null; redraw(); }
      return;
    }
    const ch = buf[0];
    if (ch === 0x71 || ch === 0x03) cleanup();
    else if (ch === 0x1b) { detailPanel = null; detailTitle = null; liveAgentSurface = null; redraw(); }
    else if (ch === 0x0d) { handleMainEnter(loops, loopRuns, agents, project); redraw(); }
    else if (ch === 0x72) { loops = discoverLoops(); flash('↻ Refreshed'); tick(); }
    else if (ch === 0x70) { // p — project picker
      projects = fetchProjects(db);
      if (projects.length > 0) { mode = 'project-picker'; redraw(); }
      else flash('No projects found');
    }
    else if (ch === 0x74) { // t — tasks view
      mode = 'tasks'; taskList = fetchTasks(db, project); taskCursor = 0; redraw();
    }
    else if (ch === 0x63) { // c — config view
      configProject = fetchFullProject(db, project);
      if (configProject) {
        configFields = buildConfigFields(configProject);
        configEnvVars = buildEnvVars(configProject);
        configCursor = 0;
        mode = 'config';
        redraw();
      } else {
        flash('No project to configure');
      }
    }
    else if (ch === 0x64) { // d — docs view
      docsEntries = buildDocsEntries(agents);
      docsCursor = docsEntries.findIndex(e => e.type === 'file');
      if (docsCursor < 0) docsCursor = 0;
      mode = 'docs';
      redraw();
    }
  });

  process.stdout.on('resize', redraw);
  tick();
  setInterval(tick, REFRESH_MS);
}

main();
