// Codex·OpenCode 대화 기록을 훅 없는 세션과 같은 모양으로 읽는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { baseName } from './paths.mjs';
import { describe, LOG_N, MAX_READ, oneLine, shellAct } from './activity.mjs';

function json(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function readRange(fd, start, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, start);
  return buf.subarray(0, n);
}

const CODEX_TAIL = 1024 * 1024; // 꼬리 1MB면 최근 활동 8개·마지막 상태엔 충분 — 20MB 넘는 기록도 있다
const codexCache = new Map(); // file → { size, mtimeMs, s } — 안 바뀐 파일은 3초마다 다시 읽지 않는다

function codexFile(file, st, now, workingMs) {
  const hit = codexCache.get(file);
  const s = hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs ? hit.s : codexRead(file, st);
  if (s !== hit?.s) {
    if (codexCache.size > 300) codexCache.clear();
    codexCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, s });
  }
  if (!s) return null;
  // 조용한 시간은 매번 다시 잰다(캐시 뒤에도 working → rest 로 넘어가게)
  const status = s.done || now - st.mtimeMs >= workingMs ? 'rest' : 'working';
  return { cwd: s.cwd, agent: 'gpt', status, ask: '', at: st.mtimeMs, source: 'transcript', info: s.info };
}

function codexRead(file, st) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    let head = Buffer.alloc(0);
    while (head.indexOf(10) < 0 && head.length < Math.min(st.size, MAX_READ)) {
      const chunk = readRange(fd, head.length, Math.min(65536, st.size - head.length, MAX_READ - head.length));
      if (!chunk.length) break;
      head = Buffer.concat([head, chunk]);
    }
    const newline = head.indexOf(10);
    if (newline < 0) return null;
    const meta = json(head.subarray(0, newline).toString());
    if (meta?.type !== 'session_meta' || typeof meta.payload?.cwd !== 'string' || !meta.payload.cwd) return null;
    const start = Math.max(0, st.size - CODEX_TAIL);
    const tail = start === 0 && head.length === st.size ? head : readRange(fd, start, st.size - start);
    let lines = tail.toString().split('\n');
    if (start) lines.shift();
    if (!tail.length || tail[tail.length - 1] !== 10) lines.pop();
    let last = null;
    const log = [];
    for (const line of lines) {
      const e = json(line);
      const p = e?.payload;
      if (!p || typeof p !== 'object') continue;
      const at = Number.isFinite(Date.parse(e.timestamp)) ? new Date(e.timestamp).toISOString() : new Date(st.mtimeMs).toISOString();
      if (e.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted', 'user_message', 'agent_message'].includes(p.type)) last = p.type;
      if (e.type !== 'response_item') continue;
      let acts = [];
      if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
        last = 'message';
        if (p.role === 'assistant' && Array.isArray(p.content)) acts = p.content.filter((b) => b?.type === 'output_text').map((b) => describe({ type: 'text', text: b.text }));
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        last = 'tool';
        const name = typeof p.name === 'string' ? p.name : '';
        const raw = p.arguments ?? p.input;
        const input = (typeof raw === 'string' ? json(raw) : raw) || {};
        if (name === 'exec' && typeof raw === 'string') acts = codeModeActs(raw);
        else if (/^(shell|shell_command|exec|exec_command|local_shell)$/.test(name)) {
          const c = input.command ?? input.cmd ?? '';
          acts = [shellAct(Array.isArray(c) ? (/^(ba|z)?sh$/.test(c[0]) && c[1] === '-lc' ? c[2] : c.join(' ')) : c)];
        } else if (name === 'apply_patch') {
          const patch = typeof raw === 'string' ? raw : input.patch || input.input || '';
          const filename = String(patch).match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/m)?.[1];
          acts = [{ k: 'edit', a: baseName(filename || input.path || input.file_path) }];
        } else if (name) acts = [{ k: 'tool', a: oneLine(name, 24) }];
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') last = 'tool';
      for (const act of acts) if (act) log.push({ at, ...act });
    }
    const recent = log.slice(-LOG_N);
    return { cwd: meta.payload.cwd, done: !last || ['task_complete', 'turn_aborted'].includes(last), info: { log: recent, doing: recent.length ? { k: recent.at(-1).k, a: recent.at(-1).a } : null } };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* 무시 */ }
  }
}

/** codex 코드 모드(exec 에 JS 로 tools.exec_command({cmd:"…"}) 를 부른다) → 그 안의 명령들 */
function codeModeActs(js) {
  const acts = [];
  for (const m of js.matchAll(/\bcmd\s*:\s*("(?:[^"\\]|\\.)*")/g)) acts.push(shellAct(json(m[1]) || ''));
  if (!acts.length && /tools\.write_stdin\b/.test(js)) acts.push({ k: 'wait', a: '' }); // 돌던 명령 결과 기다림
  return acts.length ? acts : [{ k: 'shell', a: '' }];
}

function codexSessions(minutes, now, workingMs) {
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const found = [];
  for (let day = 0; day < 3; day++) {
    const date = new Date(now);
    date.setDate(date.getDate() - day);
    const dir = path.join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (!st.isFile() || now - st.mtimeMs >= minutes * 60000) continue;
        const session = codexFile(file, st, now, workingMs);
        if (session) found.push(session);
      } catch { /* 사라진 파일은 건너뛴다 */ }
    }
  }
  return found;
}

function openCodeAct(block) {
  if (!block || typeof block !== 'object') return null;
  if (block.type === 'text') return describe(block);
  if (block.type !== 'tool' || typeof block.name !== 'string' || !block.name) return null;
  const input = block.state?.input || {};
  const names = { shell: 'Bash', bash: 'Bash', read: 'Read', edit: 'Edit', write: 'Write', grep: 'Grep', glob: 'Glob' };
  const name = names[block.name.toLowerCase()];
  return name ? describe({ type: 'tool_use', name, input: { ...input, file_path: input.file_path || input.filePath || input.path } }) : { k: 'tool', a: oneLine(block.name, 24) };
}

async function openCodeSessions(minutes, now, workingMs) {
  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const file = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'opencode.db');
    if (!fs.existsSync(file)) return [];
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare('SELECT id, directory, time_updated, time_idle, model FROM session_v2 WHERE time_updated > ? AND time_archived IS NULL').all(now - minutes * 60000);
    const messages = db.prepare('SELECT type, data, time_created FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT 20');
    return rows.filter((s) => typeof s.directory === 'string' && s.directory).map((s) => {
      const log = [];
      for (const row of messages.all(s.id).reverse()) {
        if (row.type !== 'assistant') continue;
        const content = json(row.data)?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          const act = openCodeAct(block);
          if (act) log.push({ at: new Date(Number(row.time_created) || Number(s.time_updated)).toISOString(), ...act });
        }
      }
      const recent = log.slice(-LOG_N);
      // shortcut: OpenCode 의 모든 모델을 deepseek 로 표시, 모델별 표시가 필요하면 구분한다.
      return { cwd: s.directory, agent: 'deepseek', status: (s.time_idle != null && s.time_idle >= s.time_updated) || now - s.time_updated >= workingMs ? 'rest' : 'working', ask: '', at: s.time_updated, source: 'transcript', info: { log: recent, doing: recent.length ? { k: recent.at(-1).k, a: recent.at(-1).a } : null } };
    });
  } catch {
    return [];
  } finally {
    if (db) try { db.close(); } catch { /* 무시 */ }
  }
}

export async function otherSessions(minutes, now, workingMs) {
  return [...codexSessions(minutes, now, workingMs), ...await openCodeSessions(minutes, now, workingMs)];
}
