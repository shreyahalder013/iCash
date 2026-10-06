// Test liveness verify for Test User 6
const descriptor = new Array(128).fill(0.1);

// First get a challenge
fetch('http://localhost:4000/api/liveness/challenge', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({ userIdHint: '17ec0dcc-848a-42b9-aae7-1b9dfa073ca8' })
}).then(r => r.json())
.then(challenge => {
  console.log('Challenge:', challenge);
  
  // Now verify
  return fetch('http://localhost:4000/api/liveness/verify', {
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
})
.then(verifyData => {
  console.log('Verify result:', JSON.stringify(verifyData, null, 2));
})
.catch(console.error);