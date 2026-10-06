// Debug: mimic liveness verify distance calculation
const faceTemplateService = {
  distance(a, b) {
    const arrA = a instanceof Float32Array ? a : new Float32Array(a);
    const arrB = b instanceof Float32Array ? b : new Float32Array(b);
    if (arrA.length !== arrB.length) return Infinity;
    let sum = 0;
    for (let i = 0; i < arrA.length; i++) {
      const d = arrA[i] - arrB[i];
      sum += d * d;
    }
    return Math.sqrt(sum / arrA.length);
  }
};

// Simulate stored descriptors from biometricProfile
const storedDescriptors = [new Array(128).fill(0.1)]; // What was registered
const liveDescriptor = new Array(128).fill(0.1); // What we're sending

console.log('Stored descriptors:', storedDescriptors);
console.log('Stored descriptor length:', storedDescriptors[0].length);
console.log('Live descriptor length:', liveDescriptor.length);

let bestDistance = Infinity;
for (const storedVec of storedDescriptors) {
  const dist = faceTemplateService.distance(storedVec, liveDescriptor);
  console.log('Distance:', dist);
  if (dist < bestDistance) {
    bestDistance = dist;
  }
}

console.log('Best distance:', bestDistance);
console.log('MatchMax (0.085):', 0.085);
console.log('Matches:', bestDistance < 0.085);