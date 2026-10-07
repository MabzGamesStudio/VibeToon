#!/usr/bin/env node
// Runs the API and the Vite dev server together, so `npm run dev` is the only
// command needed. Either process exiting takes the other down with it.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RESET = '\x1b[0m';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Whether a package is installed where Node would look for it from `from`: its own node_modules, or any above it. */
function installed(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', name, 'package.json'))) return true;
    if (dirname(dir) === dir) return false;
  }
}

/**
 * The packages the workspaces ask for that are not installed. After pulling a
 * change that adds one, the dev server would otherwise start and fail on the
 * first import of it ("Failed to resolve import").
 */
function missingPackages() {
  const { workspaces = [] } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const missing = [];
  for (const workspace of ['.', ...workspaces]) {
    const dir = join(ROOT, workspace);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      if (!installed(name, dir)) missing.push(`${name} (${workspace === '.' ? 'root' : workspace})`);
    }
  }
  return missing;
}

const missing = missingPackages();
if (missing.length > 0) {
  process.stdout.write(`Not installed yet: ${missing.join(', ')}. Running npm install first…\n`);
  const install = spawnSync(process.execPath, [process.env.npm_execpath ?? 'npm', 'install'], { cwd: ROOT, stdio: 'inherit' });
  if (install.status !== 0) {
    process.stderr.write('npm install failed; run it yourself, then npm run dev again.\n');
    process.exit(install.status ?? 1);
  }
}

const targets = [
  { name: 'api', args: ['run', 'dev', '-w', '@vibetoon/server'], color: '\x1b[36m' },
  { name: 'web', args: ['run', 'dev', '-w', '@vibetoon/client'], color: '\x1b[35m' },
];

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code ?? 0;
}

for (const target of targets) {
  const child = spawn(process.execPath, [process.env.npm_execpath ?? 'npm', ...target.args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  children.push(child);

  const prefix = `${target.color}[${target.name}]${RESET} `;
  const forward = (stream, out) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(`${prefix}${line}\n`);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  child.on('exit', (code) => {
    process.stdout.write(`${prefix}exited (${code})\n`);
    shutdown(code ?? 0);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
