// Password hashing (PBKDF2-SHA256) and token helpers. Works in Workers and Node 20+.
const ITERATIONS = 100000; // Workers' WebCrypto caps PBKDF2 at 100k iterations
const enc = new TextEncoder();

const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = hex => new Uint8Array(hex.match(/../g).map(h => parseInt(h, 16)));

async function derive(password, saltBytes) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: ITERATIONS }, key, 256);
  return toHex(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: await derive(password, salt), salt: toHex(salt) };
}

export async function verifyPassword(password, saltHex, expectedHex) {
  const got = await derive(password, fromHex(saltHex));
  if (got.length !== expectedHex.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  return diff === 0;
}

export function randomToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}
