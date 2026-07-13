// docker.js — Фаза 4 (§12 ТЗ v4, DEV_GUIDE §6): комната кодера. Сеть
// контейнера --network none по умолчанию; лимиты --memory/--cpus/--pids-limit;
// смонтирован только workspace. Опциональный слой поверх checkRunner.js —
// если Docker недоступен в среде, вся система продолжает работать через
// локальное исполнение (checkRunner.runCheck), это НЕ жёсткая зависимость.
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { ROOT } from './config.js';

const DOCKERFILE_PATH = path.join(ROOT, 'docker', 'coder.Dockerfile');
const IMAGE_TAG = 'loom-workspace:latest';

let _available = null;

/** Проверяет, что Docker CLI установлен И демон отвечает (docker info). Кэшируется на процесс. */
export function isDockerAvailable() {
  if (_available !== null) return _available;
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    _available = true;
  } catch {
    _available = false;
  }
  return _available;
}

/**
 * Собирает образ комнаты кодера из ТЕКУЩЕГО package.json воркспейса
 * (build context = workspaceDir, Dockerfile — из репозитория LOOM). Нужно
 * пересобирать при каждом изменении packages-плана архитектора (шрам 22).
 */
export function buildWorkspaceImage(workspaceDir, { tag = IMAGE_TAG } = {}) {
  if (!isDockerAvailable()) return { ok: false, error: 'docker недоступен (демон не отвечает)' };
  if (!fs.existsSync(path.join(workspaceDir, 'package.json'))) {
    return { ok: false, error: 'workspace без package.json — сначала ensureWorkspacePackageJson()' };
  }
  try {
    execFileSync('docker', ['build', '-f', DOCKERFILE_PATH, '-t', tag, workspaceDir], { stdio: 'pipe' });
    return { ok: true, tag };
  } catch (e) {
    return { ok: false, error: (e.stderr ? e.stderr.toString() : e.message).slice(0, 1000) };
  }
}

/**
 * runInDocker(cmd, {cwd, timeout, tag}) → {exitCode, output, timedOut}
 * Смонтирован ТОЛЬКО workspace (§12.1: наружу физически нельзя); сеть
 * отключена; лимиты памяти/CPU/процессов (§12.2).
 */
export function runInDocker(cmd, { cwd, timeout = 10000, tag = IMAGE_TAG } = {}) {
  return new Promise((resolve) => {
    const args = [
      'run', '--rm',
      '--network', 'none',
      '--memory', '2g',
      '--cpus', '2',
      '--pids-limit', '256',
      '-v', `${cwd}:/workspace`,
      '-w', '/workspace',
      tag,
      'bash', '-c', cmd,
    ];
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);

    child.stdout.on('data', (d) => { output += d.toString(); });
    child.stderr.on('data', (d) => { output += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exitCode: null, output: `FAIL: docker run не запустился: ${e.message}`, timedOut: false });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? null : code, output, timedOut });
    });
  });
}
