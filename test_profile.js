// Check biometric profile for the test user
fetch('http://localhost:4000/api/biometric/profile/041129ad-c0f0-4c3e-b634-a58654e14259', {
  method: 'GET',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include'
}).then(r => r.json()).then(console.log).catch(console.error);