// bin/dash.js — дашборд (§22 Фаза 8, П§7.2 DEV_GUIDE part2): node:http на
// 127.0.0.1, НОЛЬ зависимостей. Интерфейс НАБЛЮДЕНИЯ — единственная команда
// записи это /api/ask (существующий runAnalyst, read-only по своей природе);
// управление доской остаётся в talk.js — двух хозяев у доски не бывает.
// Три колонки: статусы (GET /api/tasks), детали задачи + events
// (GET /api/task/:id), чат с аналитиком (POST /api/ask). Один HTML-файл
// строкой, поллинг fetch'ем раз в 2с.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import {
  listTasks, getTask, listEvents, getRootSpec, newRunId,
} from '../core/journal.js';
import { runAnalyst } from '../agents/advisor.js';
import { resolveSingleActiveProject, getProject } from '../core/projects.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.DASH_PORT || 4173);

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const HTML_PAGE = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>LOOM — дашборд</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, sans-serif; background: #0f1117; color: #e6e6e6; }
  header { padding: 10px 16px; background: #171a23; border-bottom: 1px solid #2a2f3a; font-weight: 600; }
  header span { font-weight: 400; color: #8a8f9c; font-size: 13px; }
  main { display: flex; height: calc(100vh - 44px); }
  .col { flex: 1; overflow-y: auto; padding: 12px; border-right: 1px solid #2a2f3a; }
  .col:last-child { border-right: none; }
  .col h2 { font-size: 13px; text-transform: uppercase; color: #8a8f9c; margin: 0 0 10px; }
  .task { padding: 8px 10px; margin-bottom: 6px; border-radius: 6px; background: #171a23; cursor: pointer; border: 1px solid transparent; }
  .task:hover { border-color: #3a4050; }
  .task.selected { border-color: #5b8def; }
  .task .title { font-size: 13px; }
  .task .meta { font-size: 11px; color: #8a8f9c; margin-top: 2px; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: 10px; margin-right: 4px; }
  .b-pending { background: #3a3f4a; } .b-claimed { background: #5b6ddf; }
  .b-done { background: #2e7d4f; } .b-merged { background: #2e7d4f; }
  .b-failed { background: #b04a3a; } .b-blocked_needs_human { background: #c98a1c; }
  .b-merge_pending { background: #7d5ba6; }
  pre { white-space: pre-wrap; word-break: break-word; background: #171a23; padding: 8px; border-radius: 6px; font-size: 12px; }
  textarea { width: 100%; height: 80px; background: #171a23; color: #e6e6e6; border: 1px solid #2a2f3a; border-radius: 6px; padding: 8px; font-family: inherit; }
  button { margin-top: 8px; background: #5b8def; color: #fff; border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  .event { font-size: 11px; color: #8a8f9c; padding: 4px 0; border-top: 1px dashed #2a2f3a; }
  .empty { color: #8a8f9c; font-size: 13px; }
</style>
</head>
<body>
<header>LOOM — дашборд <span>(наблюдение — записи через talk.js; поллинг раз в 2с)</span></header>
<main>
  <div class="col" id="col-tasks"><h2>Задачи</h2><div id="tasks"></div></div>
  <div class="col" id="col-detail"><h2>Детали</h2><div id="detail"><div class="empty">Выберите задачу слева.</div></div></div>
  <div class="col" id="col-chat">
    <h2>Чат с аналитиком</h2>
    <textarea id="question" placeholder="Например: что делает calc.js?"></textarea>
    <button id="ask">Спросить</button>
    <div id="answer"></div>
  </div>
</main>
<script>
let selectedId = null;

function badge(status) {
  return '<span class="badge b-' + status + '">' + status + '</span>';
}

async function refreshTasks() {
  const res = await fetch('/api/tasks');
  const tasks = await res.json();
  const el = document.getElementById('tasks');
  if (!tasks.length) { el.innerHTML = '<div class="empty">Задач пока нет.</div>'; return; }
  el.innerHTML = tasks.map((t) => (
    '<div class="task' + (t.id === selectedId ? ' selected' : '') + '" data-id="' + t.id + '">' +
    '<div class="title">' + badge(t.status) + escapeHtml(t.title || '(без заголовка)') + '</div>' +
    '<div class="meta">' + t.type + ' · попыток: ' + t.attempts + '</div>' +
    '</div>'
  )).join('');
  [...el.querySelectorAll('.task')].forEach((node) => {
    node.addEventListener('click', () => { selectedId = node.dataset.id; refreshDetail(); refreshTasks(); });
  });
}

async function refreshDetail() {
  const el = document.getElementById('detail');
  if (!selectedId) { el.innerHTML = '<div class="empty">Выберите задачу слева.</div>'; return; }
  const res = await fetch('/api/task/' + encodeURIComponent(selectedId));
  if (!res.ok) { el.innerHTML = '<div class="empty">Задача не найдена.</div>'; return; }
  const { task, events } = await res.json();
  el.innerHTML =
    '<div><b>' + escapeHtml(task.title || '') + '</b></div>' +
    '<div class="meta">' + badge(task.status) + task.type + ' · роль: ' + task.role + ' · попыток: ' + task.attempts + '</div>' +
    (task.question ? '<pre>Вопрос: ' + escapeHtml(task.question) + '</pre>' : '') +
    (task.feedback ? '<pre>' + escapeHtml(task.feedback) + '</pre>' : '') +
    '<h2>События (' + events.length + ')</h2>' +
    events.map((e) => '<div class="event">' + e.type + (e.agent ? ' · ' + e.agent : '') + (e.cost_usd ? ' · $' + e.cost_usd.toFixed(4) : '') + '</div>').join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

document.getElementById('ask').addEventListener('click', async () => {
  const btn = document.getElementById('ask');
  const q = document.getElementById('question').value.trim();
  const answerEl = document.getElementById('answer');
  if (!q) return;
  btn.disabled = true;
  answerEl.innerHTML = '<div class="empty">Спрашиваю аналитика...</div>';
  try {
    const res = await fetch('/api/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q }),
    });
    const data = await res.json();
    answerEl.innerHTML = res.ok ? '<pre>' + escapeHtml(data.answer) + '</pre>' : '<pre>Ошибка: ' + escapeHtml(data.error || '') + '</pre>';
  } catch (e) {
    answerEl.innerHTML = '<pre>Ошибка сети: ' + escapeHtml(e.message) + '</pre>';
  } finally {
    btn.disabled = false;
  }
});

refreshTasks();
setInterval(refreshTasks, 2000);
setInterval(() => { if (selectedId) refreshDetail(); }, 2000);
</script>
</body>
</html>
`;

/** createDashServer() — фабрика (не запускает listen сама), чтобы evals/core/mock.js могли поднять сервер на эфемерном порту для смоука. */
export function createDashServer() {
  return http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML_PAGE);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      // §29.1: наблюдение — не запись, поэтому честно показываем ВСЕ
      // проекты (с project_id в каждой задаче), если ?project= не задан
      // явно; ?project=<id> сужает список, как /status в talk.js.
      const projectFilter = url.searchParams.get('project');
      sendJson(res, 200, listTasks(projectFilter ? { project_id: projectFilter } : {}));
      return;
    }

    const taskMatch = url.pathname.match(/^\/api\/task\/([^/]+)$/);
    if (req.method === 'GET' && taskMatch) {
      const task = getTask(taskMatch[1]);
      if (!task) { sendJson(res, 404, { error: 'задача не найдена' }); return; }
      sendJson(res, 200, { task, events: listEvents({ task_id: taskMatch[1] }) });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/ask') {
      const raw = await readBody(req);
      let question = '';
      let projectId = '';
      try { ({ question, project: projectId } = JSON.parse(raw || '{}')); } catch { question = ''; }
      if (typeof question !== 'string' || !question.trim()) {
        sendJson(res, 400, { error: 'question обязателен и должен быть непустой строкой' });
        return;
      }
      // §29.1: /api/ask пишет НЕ на доску, но всё равно должен знать, ЧЕЙ
      // rootSpec читать — явный project в теле запроса или, если он один
      // активный, резолвится сам; неоднозначность — честная 400, не гадание.
      const project = projectId ? getProject(projectId) : resolveSingleActiveProject().project;
      if (!project) {
        sendJson(res, 400, { error: 'не удалось определить проект — передайте {question, project} явно (см. /api/tasks для списка project_id)' });
        return;
      }
      const rootSpec = getRootSpec(project.id);
      const answer = await runAnalyst({
        question, rootSpec: rootSpec?.spec, workspaceDir: project.workspace_dir, runId: newRunId(),
      });
      sendJson(res, 200, { answer });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createDashServer();
  server.listen(PORT, HOST, () => {
    console.log(`[dash] http://${HOST}:${PORT} (только наблюдение — управление доской через npm run talk)`);
  });
}
