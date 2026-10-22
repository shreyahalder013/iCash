/* =========================================================
   ICASH — Template Encryption (AES-256-GCM)
   Encrypts biometric templates at rest with versioned keys.
   ========================================================= */
const crypto = require('crypto');

/**
 * Current encryption key version.
 * Increment when rotating keys. Old versions must be kept for decryption.
 */
const CURRENT_KEY_VERSION = 1;

/**
 * Get encryption key for a version.
 * In production, keys should come from a secure key management system (HSM, Vault, etc.).
 * For this demo, keys are derived from environment variable.
 */
function getEncryptionKey(version) {
  const masterKey = process.env.BIOMETRIC_ENCRYPTION_KEY;
  if (!masterKey) {
    throw new Error('BIOMETRIC_ENCRYPTION_KEY environment variable is required');
  }
  
  // Derive version-specific key using HKDF
  return crypto.hkdfSync('sha256', masterKey, Buffer.from(`icash-biometric-v${version}`), 'aes-256-gcm', 32);
}

/**
 * Encrypt a biometric template (or any JSON-serializable object).
 * @param {object|string} plaintext - Data to encrypt
 * @returns {string} - Base64 encoded: version:iv:ciphertext:authTag
 */
function encryptTemplate(plaintext) {
  const version = CURRENT_KEY_VERSION;
  const key = getEncryptionKey(version);
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  const data = typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext);
  const ciphertext = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  
  // Format: version:iv:ciphertext:authTag (all base64)
  return `${version}:${iv.toString('base64')}:${ciphertext.toString('base64')}:${authTag.toString('base64')}`;
}

/**
 * Decrypt a biometric template.
 * @param {string} encrypted - Base64 encoded encrypted data
 * @returns {object} - Decrypted template object
 */
function decryptTemplate(encrypted) {
  if (!encrypted || typeof encrypted !== 'string') {
    throw new Error('Invalid encrypted data');
  }
  
  // Check if it's already plaintext (legacy unencrypted template)
  if (!encrypted.includes(':')) {
    try {
      const parsed = JSON.parse(encrypted);
      if (Array.isArray(parsed) && parsed.length === 128) {
        // Legacy unencrypted template - return as-is for migration
        return parsed;
      }
    } catch (_e) {
      // Not valid JSON, treat as encrypted
    }
  }
  
  const parts = encrypted.split(':');
  if (parts.length !== 4) {
    throw new Error('Invalid encrypted format');
  }
  
  const version = parseInt(parts[0], 10);
  const iv = Buffer.from(parts[1], 'base64');
  const ciphertext = Buffer.from(parts[2], 'base64');
  const authTag = Buffer.from(parts[3], 'base64');
  
  const key = getEncryptionKey(version);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

/**
 * Check if a template is encrypted.
 * @param {string} template - Template string
 * @returns {boolean}
 */
function isTemplateEncrypted(template) {
  if (!template || typeof template !== 'string') {return false;}
  return template.includes(':') && /^\d+:/.test(template);
}

/**
 * Migrate legacy unencrypted template to encrypted format.
 * @param {number[]} plainTemplate - 128-dimension descriptor array
 * @returns {string} - Encrypted template string
 */
function migrateTemplate(plainTemplate) {
  if (!Array.isArray(plainTemplate) || plainTemplate.length !== 128) {
    throw new Error('Invalid template for migration');
  }
  return encryptTemplate(plainTemplate);
}

module.exports = {
  encryptTemplate,
  decryptTemplate,
  isTemplateEncrypted,
  migrateTemplate,
  CURRENT_KEY_VERSION
};