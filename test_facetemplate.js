// Check if faceTemplate was created for the new user
// We can't directly query, but we can test the biometric verify which uses biometricProfile
// and also test the faceTemplateService decrypt

const { faceTemplateService } = require('./backend/src/services/faceTemplateService');

// Test encrypt/decrypt roundtrip
const descriptor = new Float32Array(new Array(128).fill(0.1));
console.log('Original descriptor:', descriptor.slice(0, 5));

const encrypted = faceTemplateService.encrypt(descriptor);
console.log('Encrypted:', {
  encryptedLength: encrypted.encrypted.length,
  ivLength: encrypted.iv.length,
  authTagLength: encrypted.authTag.length
});

const decrypted = faceTemplateService.decrypt(encrypted.encrypted, encrypted.iv, encrypted.authTag);
console.log('Decrypted:', decrypted.slice(0, 5));
console.log('Match:', decrypted.every((v, i) => v === descriptor[i]));