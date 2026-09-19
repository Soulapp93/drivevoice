import { createHmac, timingSafeEqual } from 'node:crypto';

export type ToolSessionClaims = {
  conversationId: string;
  restaurantId: string;
  issuedAt: number;
  expiresAt: number;
};

const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64url');
const decode = (value: string) => Buffer.from(value, 'base64url').toString('utf8');

function secret() {
  const value = process.env.DRIVEVOICE_SESSION_SECRET || process.env.OPENAI_API_KEY;
  if (!value) throw new Error('DRIVEVOICE_SESSION_SECRET is not configured');
  return value;
}

export function createToolSessionToken(input: { conversationId: string; restaurantId: string; ttlMs?: number }) {
  const issuedAt = Date.now();
  const claims: ToolSessionClaims = {
    conversationId: input.conversationId,
    restaurantId: input.restaurantId,
    issuedAt,
    expiresAt: issuedAt + (input.ttlMs ?? 30 * 60 * 1000),
  };
  const encoded = encode(JSON.stringify(claims));
  const signature = createHmac('sha256', secret()).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyToolSessionToken(token: string): ToolSessionClaims | null {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  try {
    const expected = createHmac('sha256', secret()).update(encoded).digest('base64url');
    const actualBuffer = Buffer.from(signature, 'base64url');
    const expectedBuffer = Buffer.from(expected, 'base64url');
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
    const claims = JSON.parse(decode(encoded)) as ToolSessionClaims;
    if (!claims.conversationId || !claims.restaurantId || !claims.expiresAt || claims.expiresAt < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}