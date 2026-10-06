// Test: Check if faceTemplate exists for the newly registered user
const { PrismaClient } = require('@prisma/client');
const { faceTemplateService } = require('./backend/src/services/faceTemplateService');
const prisma = new PrismaClient();

async function checkTemplate() {
  // Find the most recent user
  const users = await prisma.user.findMany({
    orderBy: { created_at: 'desc' },
    take: 1
  });
  
  if (users.length === 0) {
    console.log('No users found');
    return;
  }
  
  const user = users[0];
  console.log('Latest user:', user.id, user.phone);
  
  // Check biometricProfile
  const profile = await prisma.biometricProfile.findUnique({ where: { user_id: user.id } });
  console.log('biometricProfile:', profile ? 'EXISTS' : 'NOT FOUND');
  
  // Check faceTemplate
  const template = await prisma.faceTemplate.findUnique({ where: { user_id: user.id } });
  console.log('faceTemplate:', template ? 'EXISTS' : 'NOT FOUND');
  
  if (template) {
    console.log('Template encrypted length:', template.encrypted_descriptor.length);
    console.log('Template iv length:', template.iv.length);
    console.log('Template auth_tag length:', template.auth_tag.length);
    
    // Try decrypt
    const decrypted = faceTemplateService.decrypt(
      template.encrypted_descriptor,
      template.iv,
      template.auth_tag
    );
    console.log('Decrypt:', decrypted ? 'SUCCESS' : 'FAILED');
    if (decrypted) {
      console.log('Decrypted length:', decrypted.length);
      console.log('First 5:', Array.from(decrypted.slice(0, 5)));
    }
  }
  
  await prisma.$disconnect();
}

checkTemplate().catch(console.error);