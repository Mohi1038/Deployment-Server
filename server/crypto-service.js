/**
 * Devlups Lab — Bank-Grade AES-256-GCM Encryption Service
 * Protects all cloud provider credentials and secrets at rest.
 * Uses native Node.js crypto module (no third-party dependencies).
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENV_PATH = path.resolve(__dirname, '../.env');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;       // 128-bit Initialization Vector
const KEY_LENGTH = 32;      // 256-bit Key
const TAG_LENGTH = 16;      // 128-bit Authentication Tag

/**
 * Ensures a strong 256-bit Master Encryption Key exists in .env
 */
function getMasterKey() {
  let keyHex = process.env.ENCRYPTION_MASTER_KEY;

  if (!keyHex) {
    // Check if .env file exists and read it
    if (fs.existsSync(ENV_PATH)) {
      const content = fs.readFileSync(ENV_PATH, 'utf8');
      const match = content.match(/ENCRYPTION_MASTER_KEY=([a-f0-9]{64})/i);
      if (match) {
        keyHex = match[1];
        process.env.ENCRYPTION_MASTER_KEY = keyHex;
      }
    }

    // If still not found, generate a cryptographically strong 256-bit key
    if (!keyHex) {
      keyHex = crypto.randomBytes(KEY_LENGTH).toString('hex');
      process.env.ENCRYPTION_MASTER_KEY = keyHex;
      const envLine = `\n# Devlups Lab Master AES-256 Encryption Key\nENCRYPTION_MASTER_KEY=${keyHex}\n`;
      fs.appendFileSync(ENV_PATH, envLine, 'utf8');
      console.log('[Security] Generated and stored new AES-256 Master Key in .env');
    }
  }

  return Buffer.from(keyHex, 'hex');
}

export const cryptoService = {
  /** Hex master key (generated and persisted to .env on first use). */
  getMasterKeyHex() {
    return getMasterKey().toString('hex');
  },

  /**
   * Encrypt plaintext string using AES-256-GCM
   * Returns formatted string: "enc:v1:<iv_hex>:<auth_tag_hex>:<ciphertext_hex>"
   */
  encrypt(plaintext) {
    if (!plaintext || typeof plaintext !== 'string') return plaintext;

    // Don't re-encrypt if already encrypted
    if (plaintext.startsWith('enc:v1:')) return plaintext;

    try {
      const masterKey = getMasterKey();
      const iv = crypto.randomBytes(IV_LENGTH);
      const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv);

      let encrypted = cipher.update(plaintext, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      const authTag = cipher.getAuthTag().toString('hex');

      return `enc:v1:${iv.toString('hex')}:${authTag}:${encrypted}`;
    } catch (err) {
      console.error('[Security Error] Encryption failed:', err.message);
      throw new Error('Credential encryption failed.');
    }
  },

  /**
   * Decrypt AES-256-GCM string
   * Backward-compatible: if raw plaintext JSON is passed, returns it safely
   */
  decrypt(ciphertext) {
    if (!ciphertext || typeof ciphertext !== 'string') return ciphertext;

    // Check if not encrypted (backward compatibility with legacy plain JSON)
    if (!ciphertext.startsWith('enc:v1:')) {
      return ciphertext;
    }

    try {
      const masterKey = getMasterKey();
      const parts = ciphertext.split(':');
      if (parts.length !== 5) {
        throw new Error('Malformed encrypted payload format.');
      }

      const iv = Buffer.from(parts[2], 'hex');
      const authTag = Buffer.from(parts[3], 'hex');
      const encryptedHex = parts[4];

      const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (err) {
      console.error('[Security Error] Decryption failed (integrity check violated):', err.message);
      throw new Error('Security integrity failure: Could not decrypt credentials.');
    }
  },

  /**
   * Check if a string is encrypted
   */
  isEncrypted(str) {
    return typeof str === 'string' && str.startsWith('enc:v1:');
  }
};

