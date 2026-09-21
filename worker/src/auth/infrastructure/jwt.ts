import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { TokenIssuer, TokenVerifier } from '../application/ports';

/**
 * Worker は Bearer JWT を検証するだけ。Cookie セッションは持たない（ADR-0004）。
 * クライアント側の置き場は ADR-0001（refresh = safeStorage、access = メモリ）。
 */

const encoder = new TextEncoder();

function key(secret: string): Uint8Array {
  return encoder.encode(secret);
}

export async function signAccessToken(secret: string, sub: string): Promise<string> {
  return new SignJWT({ typ: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(key(secret));
}

export async function signRefreshToken(secret: string, sub: string): Promise<string> {
  return new SignJWT({ typ: 'refresh' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(key(secret));
}

export async function verifyToken(secret: string, token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, key(secret));
  return payload;
}

export function bearerFrom(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

export function joseTokens(): TokenVerifier & TokenIssuer {
  return {
    verify: verifyToken,
    bearerFrom,
    signAccess: signAccessToken,
    signRefresh: signRefreshToken,
  };
}
