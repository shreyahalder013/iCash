const descriptors = [new Array(128).fill(0.1)];

fetch('http://localhost:4000/api/auth/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    fullName: 'Test User 6',
    phone: '9876543216',
    aadhaarNumber: '123456789017',
    pin: '1234',
    descriptors: descriptors
  })
}).then(r => r.json()).then(data => {
  console.log('Registration:', data);
  if (data.user) {
    testLiveness(data.user.id);
  }
}).catch(console.error);

async function testLiveness(userId) {
  const descriptor = new Array(128).fill(0.1);
  
  const challenge = await fetch('http://localhost:4000/api/liveness/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ userIdHint: userId })
  }).then(r => r.json());
  
  console.log('Challenge:', challenge);
  
  // Use the requiredBlinks from the challenge
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
  
  console.log('Verify result:', JSON.stringify(verify, null, 2));
}