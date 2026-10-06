// Step 1: Get liveness challenge
fetch('http://localhost:4000/api/liveness/challenge', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({ userIdHint: '041129ad-c0f0-4c3e-b634-a58654e14259' })
}).then(r => r.json())
.then(challenge => {
  console.log('Challenge:', challenge);
  
  // Step 2: Verify with a descriptor (should match since we registered with similar descriptor)
  const descriptor = new Array(128).fill(0.1); // Same as registration
  
  return fetch('http://localhost:4000/api/liveness/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      descriptor: descriptor,
      blinks: 2,
      durationMs: 5000,
      mode: 'login'
    })
  }).then(r => r.json());
})
.then(verifyData => {
  console.log('Verify:', verifyData);
  
  if (verifyData.biometricToken) {
    // Step 3: Login with biometricToken
    return fetch('http://localhost:4000/api/auth/login-biometric', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ biometricToken: verifyData.biometricToken })
    }).then(r => r.json());
  }
})
.then(loginData => {
  console.log('Login:', loginData);
})
.catch(console.error);