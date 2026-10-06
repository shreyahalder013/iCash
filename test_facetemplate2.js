require('dotenv').config({ path: './.env' });

const { faceTemplateService } = require('./backend/src/services/faceTemplateService');

console.log('FACE_TEMPLATE_KEY from env:', process.env.FACE_TEMPLATE_KEY ? 'SET (' + process.env.FACE_TEMPLATE_KEY.length + ' chars)' : 'NOT SET');

// Test encrypt/decrypt roundtrip
const descriptor = new Float32Array(new Array(128).fill(0.1));
console.log('Original descriptor (first 5):', Array.from(descriptor.slice(0, 5)));

try {
  const encrypted = faceTemplateService.encrypt(descriptor);
  console.log('Encrypted OK:', {
    encryptedLength: encrypted.encrypted.length,
    ivLength: encrypted.iv.length,
    authTagLength: encrypted.authTag.length
  });

  const decrypted = faceTemplateService.decrypt(encrypted.encrypted, encrypted.iv, encrypted.authTag);
  console.log('Decrypted (first 5):', Array.from(decrypted.slice(0, 5)));
  console.log('Match:', decrypted.every((v, i) => Math.abs(v - descriptor[i]) < 0.0001));
} catch (e) {
  console.error('Error:', e.message);
}