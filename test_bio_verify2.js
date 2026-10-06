// Test biometric verify for Test User 4
const descriptor = new Array(128).fill(0.1);

fetch('http://localhost:4000/api/biometric/verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    liveDescriptor: descriptor,
    userId: '10fd3317-b5b2-4b81-961e-c3c6a331a70a'
  })
}).then(r => r.json()).then(console.log).catch(console.error);