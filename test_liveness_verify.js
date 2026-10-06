const descriptor = new Array(128).fill(0.1);

fetch('http://localhost:4000/api/liveness/challenge', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({ userIdHint: 'ddd7d419-6cdf-4cf5-bbe9-72fea47d39a6' })
}).then(r => r.json())
.then(challenge => {
  console.log('Challenge:', challenge);
  
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
  console.log('Verify result:', JSON.stringify(verifyData, null, 2));
})
.catch(console.error);