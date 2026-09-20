import { describe, expect, it } from 'vitest';
import { bearerFrom, signAccessToken, signRefreshToken, verifyToken } from '../src/auth/jwt';

const SECRET = 'test-signing-key-at-least-32-chars';

describe('JWT（Bearer。Cookie は使わない）', () => {
  it('access を署名して sub が読める', async () => {
    const token = await signAccessToken(SECRET, 'user-1');
    const payload = await verifyToken(SECRET, token);
    expect(payload.sub).toBe('user-1');
    expect(payload.typ).toBe('access');
  });

  it('refresh は typ が違う', async () => {
    const token = await signRefreshToken(SECRET, 'user-1');
    const payload = await verifyToken(SECRET, token);
    expect(payload.typ).toBe('refresh');
  });

  it('Authorization: Bearer から取り出す', () => {
    const req = new Request('https://api.test/runs', {
      headers: { Authorization: 'Bearer abc.def.ghi' },
    });
    expect(bearerFrom(req)).toBe('abc.def.ghi');
    expect(bearerFrom(new Request('https://api.test/runs'))).toBeNull();
  });
});
