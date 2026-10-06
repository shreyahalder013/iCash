// Test biometric verify endpoint (uses biometricService with threshold 0.6)
const descriptor = new Array(128).fill(0.1);

fetch('http://localhost:4000/api/biometric/verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    liveDescriptor: descriptor,
    userId: '041129ad-c0f0-4c3e-b634-a58654e14259'
  })
}).then(r => r.json()).then(console.log).catch(console.error);