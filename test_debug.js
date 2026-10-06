// Debug: Check if faceTemplate exists and test decrypt
require('dotenv').config({ path: './.env' });
const { PrismaClient } = require('@prisma/client');
const { faceTemplateService } = require('./backend/src/services/faceTemplateService');

const prisma = new PrismaClient();

async function testDebug() {
  const userId = '17ec0dcc-848a-42b9-aae7-1b9dfa073ca8';
  
  // Check if faceTemplate exists
  const template = await prisma.faceTemplate.findUnique({ where: { user_id: userId } });
  console.log('faceTemplate record:', template ? 'EXISTS' : 'NOT FOUND');
  
  if (template) {
    console.log('Encrypted length:', template.encrypted_descriptor.length);
    console.log('IV length:', template.iv.length);
    console.log('Auth tag length:', template.auth_tag.length);
    
    // Try decrypt
    const decrypted = faceTemplateService.decrypt(
      template.encrypted_descriptor,
      template.iv,
      template.auth_tag
    );
    
    console.log('Decrypted:', decrypted ? 'SUCCESS' : 'FAILED');
    if (decrypted) {
      console.log('Decrypted length:', decrypted.length);
      console.log('First 5:', Array.from(decrypted.slice(0, 5)));
    }
  }
  
  // Also check biometricProfile
  const profile = await prisma.biometricProfile.findUnique({ where: { user_id: userId } });
  console.log('biometricProfile:', profile ? 'EXISTS' : 'NOT FOUND');
  if (profile) {
    console.log('face_descriptors:', profile.face_descriptors ? profile.face_descriptors.length + ' descriptors' : 'none');
    if (profile.face_descriptors && profile.face_descriptors.length > 0) {
      console.log('First descriptor (first 5):', Array.from(profile.face_descriptors[0].slice(0, 5)));
    }
  }
  
  await prisma.$disconnect();
}

testDebug().catch(console.error);