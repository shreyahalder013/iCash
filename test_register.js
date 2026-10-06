const descriptors = [new Array(128).fill(0.1)];

fetch('http://localhost:4000/api/auth/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    fullName: 'Test User 2',
    phone: '9876543212',
    aadhaarNumber: '123456789013',
    pin: '1234',
    descriptors: descriptors
  })
}).then(r => r.json()).then(console.log).catch(console.error);