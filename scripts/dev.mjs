#!/usr/bin/env node
// Runs the API and the Vite dev server together, so `npm run dev` is the only
// command needed. Either process exiting takes the other down with it.
import { spawn } from 'node:child_process';

const RESET = '\x1b[0m';

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
