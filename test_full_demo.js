// Full test: register new user -> liveness verify -> login
const descriptors = [new Array(128).fill(0.1)];

console.log('=== STEP 1: Register ===');
fetch('http://localhost:4000/api/auth/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    fullName: 'Demo User',
    phone: '9876543398',
    aadhaarNumber: '123456789998',
    pin: '1234',
    descriptors: descriptors
  })
}).then(r => r.json()).then(data => {
  console.log('Registration:', data.ok ? 'SUCCESS' : 'FAILED', data.message || '');
  if (data.user) {
    testLiveness(data.user.id);
  }
}).catch(console.error);

async function testLiveness(userId) {
  const descriptor = new Array(128).fill(0.1);
  
  console.log('\n=== STEP 2: Get Liveness Challenge ===');
  const challenge = await fetch('http://localhost:4000/api/liveness/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ userIdHint: userId })
  }).then(r => r.json());
  
  console.log('Challenge:', challenge.ok ? 'OK' : 'FAILED');
  
  console.log('\n=== STEP 3: Liveness Verify ===');
  const verify = await fetch('http://localhost:4000/api/liveness/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      descriptor: descriptor,
      blinks: challenge.requiredBlinks,
      durationMs: 5000,
      mode: 'login'
    })
  }).then(r => r.json());
  
  console.log('Verify result:', verify.ok ? 'SUCCESS' : 'FAILED', verify.error, verify.message || '');
  
  if (verify.ok && verify.biometricToken) {
    console.log('\n=== STEP 4: Login with Biometric Token ===');
    const login = await fetch('http://localhost:4000/api/auth/login-biometric', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ biometricToken: verify.biometricToken })
    }).then(r => r.json());
    console.log('Login:', login.ok ? 'SUCCESS' : 'FAILED', login.message || '');
  }
}