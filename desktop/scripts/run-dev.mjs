#!/usr/bin/env node
/**
 * Cursor 等が ELECTRON_RUN_AS_NODE=1 を付けると Electron が Node として起き、
 * BrowserWindow が無い。検証起動では必ず外す。
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.bin', 'electron-vite');
const child = spawn(bin, ['dev', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
