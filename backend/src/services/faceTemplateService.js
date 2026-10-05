/**
 * FaceTemplateService
 * 
 * Handles AES-256-GCM encryption/decryption of face descriptors at rest.
 * Each template gets a unique random IV and auth tag.
 * 
 * Encryption: AES-256-GCM with per-record random IV (12 bytes) and auth tag (16 bytes)
 * Key: FACE_TEMPLATE_KEY from environment (32 bytes / 256 bits)
 */

const crypto = require('crypto');

function getEncryptionKey() {
  const keyHex = process.env.FACE_TEMPLATE_KEY;
  if (!keyHex) {
    throw new Error('FACE_TEMPLATE_KEY environment variable is required. Generate with: openssl rand -hex 32');
  }
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error('FACE_TEMPLATE_KEY must be 32 bytes (64 hex characters)');
  }
  return key;
}

/**
 * Encrypt a face descriptor (Float32Array or number[]) for storage
 * @param {Float32Array|number[]} descriptor - 128+ dimensional face descriptor
 * @returns {Object} { encrypted: Buffer, iv: Buffer, authTag: Buffer }
 */
function encrypt(descriptor) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  // Convert descriptor to bytes (Float32Array -> Buffer)
  const descriptorArray = descriptor instanceof Float32Array 
    ? descriptor 
    : new Float32Array(descriptor);
  const plaintext = Buffer.from(descriptorArray.buffer);
  
  const encrypted = Buffer.concat([
    cipher.update(plaintext),
    cipher.final()
  ]);
  
  const authTag = cipher.getAuthTag();
  
  return { encrypted, iv, authTag };
}

/**
 * Decrypt a face descriptor from storage
 * @param {Buffer|string} encrypted - Encrypted descriptor (hex string or Buffer)
 * @param {Buffer|string} iv - Initialization vector (hex string or Buffer)
 * @param {Buffer|string} authTag - Authentication tag (hex string or Buffer)
 * @returns {Float32Array|null} Decrypted descriptor or null on failure
 */
function decrypt(encrypted, iv, authTag) {
  try {
    const key = getEncryptionKey();
    const encBuf = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted, 'hex');
    const ivBuf = Buffer.isBuffer(iv) ? iv : Buffer.from(iv, 'hex');
    const tagBuf = Buffer.isBuffer(authTag) ? authTag : Buffer.from(authTag, 'hex');
    
    if (ivBuf.length !== 12 || tagBuf.length !== 16) {
      throw new Error('Invalid IV or auth tag length');
    }
    
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, ivBuf);
    decipher.setAuthTag(tagBuf);
    
    const decrypted = Buffer.concat([
      decipher.update(encBuf),
      decipher.final()
    ]);
    
    // Convert back to Float32Array
    return new Float32Array(decrypted.buffer);
  } catch (e) {
    console.warn('[FaceTemplateService] Decryption failed:', e.message);
    return null;
  }
}

/**
 * Compute RMS (Euclidean) distance between two descriptors
 * @param {Float32Array|number[]} a 
 * @param {Float32Array|number[]} b 
 * @returns {number} RMS distance (0 = identical)
 */
function distance(a, b) {
  const arrA = a instanceof Float32Array ? a : new Float32Array(a);
  const arrB = b instanceof Float32Array ? b : new Float32Array(b);
  
  if (arrA.length !== arrB.length) return Infinity;
  
  let sum = 0;
  for (let i = 0; i < arrA.length; i++) {
    const d = arrA[i] - arrB[i];
    sum += d * d;
  }
  return Math.sqrt(sum / arrA.length);
}

/**
 * Validate descriptor format
 * @param {*} descriptor 
 * @returns {boolean}
 */
function isValidDescriptor(descriptor) {
  if (!descriptor) return false;
  const arr = descriptor instanceof Float32Array ? descriptor : 
    (Array.isArray(descriptor) ? new Float32Array(descriptor) : null);
  return arr !== null && arr.length >= 128 && arr.every(v => Number.isFinite(v));
}

module.exports = {
  faceTemplateService: {
    encrypt,
    decrypt,
    distance,
    isValidDescriptor,
  },
};