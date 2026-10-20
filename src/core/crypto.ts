import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 0x01;
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = 1 + IV_LEN + TAG_LEN;

function checkKey(key: Buffer): void {
  if (key.length !== KEY_LEN) throw new Error(`Encryption key must be ${KEY_LEN} bytes.`);
}

// Format: 1-byte version 0x01 + 12-byte IV + 16-byte GCM tag + ciphertext.
export function seal(key: Buffer, plaintext: Buffer): Buffer {
  checkKey(key);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ct]);
}

export function open(key: Buffer, sealed: Buffer): Buffer {
  checkKey(key);
  if (sealed.length < HEADER_LEN) throw new Error('Sealed data is truncated.');
  if (sealed[0] !== VERSION) throw new Error(`Unsupported sealed data version ${sealed[0]}.`);
  const iv = sealed.subarray(1, 1 + IV_LEN);
  const tag = sealed.subarray(1 + IV_LEN, HEADER_LEN);
  const ct = sealed.subarray(HEADER_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error('Decryption failed: wrong key or data has been tampered with.');
  }
}
