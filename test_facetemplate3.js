require('dotenv').config({ path: './.env' });
const crypto = require('crypto');
const { faceTemplateService } = require('./backend/src/services/faceTemplateService');

// Manual test
const keyHex = process.env.FACE_TEMPLATE_KEY;
const key = Buffer.from(keyHex, 'hex');
console.log('Key length:', key.length);

const descriptor = new Float32Array(new Array(128).fill(0.1));
console.log('Original Float32Array:', descriptor.slice(0, 5));
console.log('Byte length:', descriptor.byteLength);
console.log('Buffer length:', descriptor.buffer.byteLength);

// Encrypt manually
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const plaintext = Buffer.from(descriptor.buffer);
console.log('Plaintext length:', plaintext.length);

const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const authTag = cipher.getAuthTag();
console.log('Encrypted length:', encrypted.length);
console.log('Auth tag length:', authTag.length);

// Decrypt manually
const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
decipher.setAuthTag(authTag);
const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
console.log('Decrypted length:', decrypted.length);

const result = new Float32Array(decrypted.buffer);
console.log('Result:', result.slice(0, 5));
console.log('Match:', result.every((v, i) => Math.abs(v - descriptor[i]) < 0.0001));