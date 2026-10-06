// Test biometric verify for Test User 6
const descriptor = new Array(128).fill(0.1);

fetch('http://localhost:4000/api/biometric/verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    liveDescriptor: descriptor,
    userId: '17ec0dcc-848a-42b9-aae7-1b9dfa073ca8'
  })
}).then(r => r.json()).then(console.log).catch(console.error);