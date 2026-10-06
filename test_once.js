// Test: liveness verify -> login biometric (single test, fresh token)
const descriptors = [new Array(128).fill(0.1)];

async function testOnce() {
  console.log('=== STEP 1: Register ===');
  const reg = await fetch('http://localhost:4000/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      fullName: 'Demo User',
      phone: '9876543599',
      aadhaarNumber: '123456789599',
      pin: '1234',
      descriptors: descriptors
    })
  }).then(r => r.json());
  
  console.log('Registration:', reg.ok ? 'SUCCESS' : 'FAILED', reg.message || '');
  if (!reg.user) return;
  
  console.log('\n=== STEP 2: Liveness Challenge ===');
  const challenge = await fetch('http://localhost:4000/api/liveness/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ userIdHint: reg.user.id })
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
      descriptor: descriptors[0],
      blinks: challenge.requiredBlinks,
      durationMs: 5000,
      mode: 'login'
    })
  }).then(r => r.json());
  console.log('Verify:', verify.ok ? 'SUCCESS' : 'FAILED', verify.error, verify.message || '');
  
  if (verify.ok && verify.biometricToken) {
    console.log('\n=== STEP 4: Login Biometric ===');
    const login = await fetch('http://localhost:4000/api/auth/login-biometric', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ biometricToken: verify.biometricToken })
    }).then(r => r.json());
    console.log('Login:', login.ok ? 'SUCCESS' : 'FAILED', login.message || '');
    if (login.ok) {
      console.log('User:', login.user);
    }
  }
}

testOnce().catch(console.error);