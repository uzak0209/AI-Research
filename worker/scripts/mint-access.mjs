#!/usr/bin/env node
/**
 * ローカル検証用の access JWT。IdP 未決の間、curl で BFF を叩くため。
 * 署名鍵は標準出力に出さない。トークンだけ出す。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vars = readFileSync(join(root, '.dev.vars'), 'utf8');
const secret = vars
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => l.split('='))
  .find(([k]) => k === 'JWT_SIGNING_KEY')?.[1];

if (!secret) {
  console.error('JWT_SIGNING_KEY が .dev.vars に無い。./scripts/local-env.sh を先に。');
  process.exit(1);
}

const sub = process.argv[2] ?? 'local-dev';
const token = await new SignJWT({ typ: 'access' })
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject(sub)
  .setIssuedAt()
  .setExpirationTime('15m')
  .sign(new TextEncoder().encode(secret));

process.stdout.write(`${token}\n`);
