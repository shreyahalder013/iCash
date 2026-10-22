/**
 * Phase 1: Face Matching Evaluation Script
 * 
 * Computes genuine vs impostor distance distributions using face-api.js
 * Reports FAR/FRR at thresholds 0.35 to 0.65 in 0.025 steps
 * 
 * Usage: node scripts/eval-face-matching.js [--data-dir <path>] [--output <csv>] [--synthetic <count>]
 * 
 * Note: On Windows without Visual Studio, use --synthetic flag to run without native TFJS bindings
 */

const fs = require('fs');
const path = require('path');

// Use dynamic import for face-api.js (ESM)
async function main() {
  // Parse arguments
  const args = process.argv.slice(2);
  
  function getArgValue(flag, defaultValue) {
    const idx = args.indexOf(flag);
    if (idx === -1 || idx + 1 >= args.length) return defaultValue;
    const val = args[idx + 1];
    if (val.startsWith('--')) return defaultValue; // Next arg is another flag
    return val;
  }
  
  const dataDir = getArgValue('--data-dir', null);
  const outputCsv = getArgValue('--output', 'eval-results.csv');
  const syntheticCount = parseInt(getArgValue('--synthetic', '0')) || 0;
  const useSynthetic = syntheticCount > 0 || !dataDir;

  console.log('══════════════════════════════════════════════════════════════');
  console.log('  iCash Biometric Evaluation — Phase 1');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(`Mode: ${useSynthetic ? 'Synthetic (Gaussian clusters)' : 'Real images from ' + dataDir}`);
  if (useSynthetic) console.log(`Synthetic identities: ${syntheticCount || 50}`);
  console.log('');

  // For synthetic mode, we don't need face-api models - we generate mathematically
  // For real image mode, we need face-api with models
  let identityDescriptors = {};

  if (useSynthetic) {
    identityDescriptors = await generateSyntheticDescriptors(syntheticCount || 50);
  } else {
    // Import face-api.js and tfjs (WASM backend to avoid native build)
    const { Canvas, Image, ImageData } = await import('canvas');
    const faceapi = await import('@vladmandic/face-api');
    const tf = await import('@tensorflow/tfjs');
    
    // Use WASM backend to avoid native compilation
    await tf.setBackend('wasm');
    await tf.ready();
    
    // Patch face-api to use node canvas
    faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

    // Model paths
    const modelPath = path.resolve(__dirname, '..', 'models');
    console.log(`Loading models from: ${modelPath}`);

    // Load models
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromDisk(modelPath),
      faceapi.nets.faceLandmark68Net.loadFromDisk(modelPath),
      faceapi.nets.faceRecognitionNet.loadFromDisk(modelPath),
    ]);
    console.log('Models loaded successfully\n');

    identityDescriptors = await loadDescriptorsFromDirectory(dataDir, faceapi);
  }

  // Compute distance matrices
  const { genuineDistances, impostorDistances } = computeDistances(identityDescriptors);

  // Evaluate thresholds
  const thresholds = [];
  for (let t = 0.35; t <= 0.65; t += 0.025) {
    thresholds.push(parseFloat(t.toFixed(3)));
  }

  const results = evaluateThresholds(genuineDistances, impostorDistances, thresholds);

  // Print results table
  printResultsTable(results, genuineDistances, impostorDistances);

  // Write CSV
  writeCsv(results, outputCsv);

  // Recommend threshold
  recommendThreshold(results);

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Evaluation Complete');
  console.log('══════════════════════════════════════════════════════════════');
}

async function generateSyntheticDescriptors(numIdentities) {
  console.log(`Generating ${numIdentities} synthetic identities with 5-7 samples each...`);
  
  const descriptors = {};
  const samplesPerIdentity = 7;
  const descriptorDim = 128;
  
  // Generate cluster centroids with realistic separation
  // Real face-api: typical inter-identity distances 0.6-1.4
  // ~2-5% of pairs are "lookalikes" at 0.55-0.75 distance (not extreme)
  const centroids = [];
  const numLookalikePairs = Math.floor(numIdentities * 0.03); // ~3% lookalike pairs
  
  for (let i = 0; i < numIdentities; i++) {
    let centroid;
    
    if (i < numLookalikePairs * 2 && i % 2 === 1) {
      // Create a lookalike for the previous identity
      const baseCentroid = centroids[i - 1];
      // Add a moderate angle to create a lookalike (not extreme)
      const lookalikeAngle = 0.5 + Math.random() * 0.3; // 0.5-0.8 rad → distance ~0.5-0.75
      
      const tangent = new Array(descriptorDim).fill(0).map(() => (Math.random() - 0.5) * 2);
      let dot = 0;
      for (let k = 0; k < descriptorDim; k++) dot += tangent[k] * baseCentroid[k];
      for (let k = 0; k < descriptorDim; k++) tangent[k] -= dot * baseCentroid[k];
      
      const tangentNorm = Math.sqrt(tangent.reduce((sum, v) => sum + v * v, 0));
      if (tangentNorm > 0) {
        for (let k = 0; k < descriptorDim; k++) tangent[k] /= tangentNorm;
      }
      
      for (let k = 0; k < descriptorDim; k++) tangent[k] *= lookalikeAngle;
      
      centroid = new Array(descriptorDim);
      const cosA = Math.cos(lookalikeAngle);
      const sinA = Math.sin(lookalikeAngle);
      for (let k = 0; k < descriptorDim; k++) {
        centroid[k] = baseCentroid[k] * cosA + tangent[k] * sinA;
      }
      
      const norm = Math.sqrt(centroid.reduce((sum, v) => sum + v * v, 0));
      centroid = centroid.map(v => v / norm);
    } else {
      // Regular random centroid
      centroid = new Array(descriptorDim).fill(0).map(() => (Math.random() - 0.5) * 2);
      const norm = Math.sqrt(centroid.reduce((sum, v) => sum + v * v, 0));
      centroid = centroid.map(v => v / norm);
    }
    
    centroids.push(centroid);
  }

  // Verify centroid separation
  let minCentroidDist = Infinity;
  let maxCentroidDist = 0;
  let lookalikeCount = 0;
  for (let i = 0; i < numIdentities; i++) {
    for (let j = i + 1; j < numIdentities; j++) {
      const dist = euclideanDistance(centroids[i], centroids[j]);
      minCentroidDist = Math.min(minCentroidDist, dist);
      maxCentroidDist = Math.max(maxCentroidDist, dist);
      if (dist < 0.7) lookalikeCount++;
    }
  }
  console.log(`  Centroid distances: min=${minCentroidDist.toFixed(4)}, max=${maxCentroidDist.toFixed(4)}, lookalike pairs (<0.7): ${lookalikeCount}`);

  // Generate samples around each centroid with REALISTIC variance
  // Based on face-api.js empirical data from literature:
  // - Genuine distances (same person): mean ~0.35-0.45, std ~0.05-0.08
  // - Impostor distances (different people): mean ~0.9-1.1, std ~0.08-0.12
  // - Some impostor pairs can be as low as 0.55-0.75 (lookalikes)
  
  for (let i = 0; i < numIdentities; i++) {
    const identityName = `identity_${i.toString().padStart(3, '0')}`;
    descriptors[identityName] = [];
    
    for (let s = 0; s < samplesPerIdentity; s++) {
      // Generate sample with realistic intra-person variance
      // Target genuine distance BETWEEN SAMPLES: mean ~0.4, std ~0.07
      // On unit sphere: for two samples at angle θ from centroid,
      // expected pairwise distance ≈ sqrt(2) * 2*sin(θ/2) ≈ sqrt(2)*θ (small θ)
      // For mean pairwise d=0.4: θ ≈ 0.4 / sqrt(2) ≈ 0.283 rad
      // Sample-to-centroid chord distance = 2*sin(θ/2) ≈ 0.283
      
      const centroid = centroids[i];
      // Sample from distribution centered at ~0.283 with std ~0.05
      let targetDistance;
      do {
        targetDistance = 0.283 + (Math.random() - 0.5) * 0.1; // ~N(0.283, 0.05)
      } while (targetDistance < 0.1 || targetDistance > 0.5);
      const targetAngle = 2 * Math.asin(targetDistance / 2);
      
      // Generate random tangent vector
      const tangent = new Array(descriptorDim).fill(0).map(() => (Math.random() - 0.5) * 2);
      // Project onto tangent space (orthogonal to centroid)
      let dot = 0;
      for (let k = 0; k < descriptorDim; k++) dot += tangent[k] * centroid[k];
      for (let k = 0; k < descriptorDim; k++) tangent[k] -= dot * centroid[k];
      
      // Normalize tangent (unit vector in tangent space)
      const tangentNorm = Math.sqrt(tangent.reduce((sum, v) => sum + v * v, 0));
      if (tangentNorm > 0) {
        for (let k = 0; k < descriptorDim; k++) tangent[k] /= tangentNorm;
      }
      
      // Project back to sphere: new = centroid * cos(θ) + tangent * sin(θ)
      // tangent is unit vector; θ = targetAngle; cosA=cos(θ), sinA=sin(θ)
      const sample = new Array(descriptorDim);
      const cosA = Math.cos(targetAngle);
      const sinA = Math.sin(targetAngle);
      for (let k = 0; k < descriptorDim; k++) {
        sample[k] = centroid[k] * cosA + tangent[k] * sinA;
      }
      
      // Verify normalization
      const norm = Math.sqrt(sample.reduce((sum, v) => sum + v * v, 0));
      descriptors[identityName].push(sample.map(v => v / norm));
    }
  }

  console.log(`  Generated ${Object.keys(descriptors).length} identities with ${samplesPerIdentity} samples each\n`);
  return descriptors;
}

async function loadDescriptorsFromDirectory(dataDir, faceapi) {
  console.log(`Loading images from: ${dataDir}`);
  
  const descriptors = {};
  const entries = fs.readdirSync(dataDir, { withFileTypes: true });
  
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    
    const identityName = entry.name;
    const identityPath = path.join(dataDir, identityName);
    const files = fs.readdirSync(identityPath).filter(f => 
      /\.(jpg|jpeg|png|webp)$/i.test(f)
    );
    
    if (files.length < 2) {
      console.warn(`  Skipping ${identityName}: only ${files.length} image(s)`);
      continue;
    }
    
    descriptors[identityName] = [];
    
    for (const file of files) {
      const imgPath = path.join(identityPath, file);
      try {
        const img = await loadImage(imgPath);
        const detection = await faceapi.detectSingleFace(img)
          .withFaceLandmarks()
          .withFaceDescriptor();
        
        if (detection && detection.descriptor) {
          const desc = Array.from(detection.descriptor);
          if (desc.length === 128) {
            descriptors[identityName].push(desc);
          }
        }
      } catch (e) {
        console.warn(`  Failed to process ${file}: ${e.message}`);
      }
    }
    
    console.log(`  ${identityName}: ${descriptors[identityName].length} valid descriptors`);
  }
  
  console.log('');
  return descriptors;
}

function loadImage(imgPath) {
  const { Canvas, Image } = require('canvas');
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = imgPath;
  });
}

function euclideanDistance(a, b) {
  if (a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function computeDistances(identityDescriptors) {
  console.log('Computing distance matrices...');
  
  const genuineDistances = [];
  const impostorDistances = [];
  const identities = Object.keys(identityDescriptors);
  
  // Genuine distances: within same identity
  for (const identity of identities) {
    const samples = identityDescriptors[identity];
    for (let i = 0; i < samples.length; i++) {
      for (let j = i + 1; j < samples.length; j++) {
        genuineDistances.push(euclideanDistance(samples[i], samples[j]));
      }
    }
  }
  
  // Impostor distances: between different identities
  // Sample a subset if too many combinations
  const maxImpostorPairs = 100000;
  let pairCount = 0;
  
  for (let i = 0; i < identities.length; i++) {
    for (let j = i + 1; j < identities.length; j++) {
      const samplesA = identityDescriptors[identities[i]];
      const samplesB = identityDescriptors[identities[j]];
      
      // Compare first few samples from each identity
      for (let si = 0; si < Math.min(3, samplesA.length); si++) {
        for (let sj = 0; sj < Math.min(3, samplesB.length); sj++) {
          impostorDistances.push(euclideanDistance(samplesA[si], samplesB[sj]));
          pairCount++;
          if (pairCount >= maxImpostorPairs) break;
        }
        if (pairCount >= maxImpostorPairs) break;
      }
      if (pairCount >= maxImpostorPairs) break;
    }
    if (pairCount >= maxImpostorPairs) break;
  }
  
  console.log(`  Genuine pairs: ${genuineDistances.length}`);
  console.log(`  Impostor pairs: ${impostorDistances.length} (capped at ${maxImpostorPairs})\n`);
  
  return { genuineDistances, impostorDistances };
}

function evaluateThresholds(genuineDistances, impostorDistances, thresholds) {
  const results = [];
  
  for (const threshold of thresholds) {
    // False Accept Rate: impostor distance <= threshold (wrongly accepted)
    const falseAccepts = impostorDistances.filter(d => d <= threshold).length;
    const FAR = falseAccepts / impostorDistances.length;
    
    // False Reject Rate: genuine distance > threshold (wrongly rejected)
    const falseRejects = genuineDistances.filter(d => d > threshold).length;
    const FRR = falseRejects / genuineDistances.length;
    
    // True Accept Rate
    const TAR = 1 - FRR;
    
    // Accuracy
    const total = genuineDistances.length + impostorDistances.length;
    const correct = (genuineDistances.length - falseRejects) + (impostorDistances.length - falseAccepts);
    const accuracy = correct / total;
    
    results.push({
      threshold,
      FAR,
      FRR,
      TAR,
      accuracy,
      falseAccepts,
      falseRejects,
      genuineCount: genuineDistances.length,
      impostorCount: impostorDistances.length
    });
  }
  
  return results;
}

function printResultsTable(results, genuineDistances, impostorDistances) {
  console.log('════════════════════════════════════════════════════════════════════════════════');
  console.log('  THRESHOLD ANALYSIS');
  console.log('════════════════════════════════════════════════════════════════════════════════');
  console.log('');
  console.log('Distance Statistics:');
  console.log(`  Genuine   — mean: ${mean(genuineDistances).toFixed(4)}, std: ${std(genuineDistances).toFixed(4)}, min: ${Math.min(...genuineDistances).toFixed(4)}, max: ${Math.max(...genuineDistances).toFixed(4)}`);
  console.log(`  Impostor  — mean: ${mean(impostorDistances).toFixed(4)}, std: ${std(impostorDistances).toFixed(4)}, min: ${Math.min(...impostorDistances).toFixed(4)}, max: ${Math.max(...impostorDistances).toFixed(4)}`);
  console.log(`  Separation (d'): ${dPrime(genuineDistances, impostorDistances).toFixed(4)}`);
  console.log('');
  
  console.log('┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐');
  console.log('│ Threshold│    FAR   │    FRR   │    TAR   │ Accuracy │  FA/Total│  FR/Total│');
  console.log('├──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤');
  
  for (const r of results) {
    const farStr = (r.FAR * 100).toFixed(4).padStart(8) + '%';
    const frrStr = (r.FRR * 100).toFixed(4).padStart(8) + '%';
    const tarStr = (r.TAR * 100).toFixed(4).padStart(8) + '%';
    const accStr = (r.accuracy * 100).toFixed(4).padStart(8) + '%';
    const faStr = `${r.falseAccepts}/${r.impostorCount}`.padStart(10);
    const frStr = `${r.falseRejects}/${r.genuineCount}`.padStart(10);
    const thStr = r.threshold.toFixed(3).padStart(8);
    
    console.log(`│ ${thStr} │ ${farStr} │ ${frrStr} │ ${tarStr} │ ${accStr} │ ${faStr} │ ${frStr} │`);
  }
  
  console.log('└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘');
  console.log('');
}

function recommendThreshold(results) {
  // Find threshold with FAR <= 0.1% (0.001)
  const farTarget = 0.001;
  let bestResult = null;
  
  for (const r of results) {
    if (r.FAR <= farTarget) {
      if (!bestResult || r.FRR < bestResult.FRR) {
        bestResult = r;
      }
    }
  }
  
  console.log('════════════════════════════════════════════════════════════════════════════════');
  console.log('  RECOMMENDED THRESHOLD');
  console.log('════════════════════════════════════════════════════════════════════════════════');
  console.log('');
  
  if (bestResult) {
    console.log(`  Target FAR: ≤ ${(farTarget * 100).toFixed(3)}%`);
    console.log(`  Selected threshold: ${bestResult.threshold.toFixed(3)}`);
    console.log(`  Actual FAR: ${(bestResult.FAR * 100).toFixed(4)}% (${bestResult.falseAccepts}/${bestResult.impostorCount})`);
    console.log(`  Resulting FRR: ${(bestResult.FRR * 100).toFixed(4)}% (${bestResult.falseRejects}/${bestResult.genuineCount})`);
    console.log(`  True Accept Rate: ${(bestResult.TAR * 100).toFixed(4)}%`);
    console.log('');
    console.log(`  → Set FACE_MATCH_THRESHOLD=${bestResult.threshold.toFixed(3)} in .env`);
  } else {
    console.log(`  No threshold achieves FAR ≤ ${(farTarget * 100).toFixed(3)}%`);
    console.log('  Lowest FAR achieved:', Math.min(...results.map(r => r.FAR)).toFixed(6));
    console.log('');
    // Show closest
    const closest = results.reduce((a, b) => Math.abs(a.FAR - farTarget) < Math.abs(b.FAR - farTarget) ? a : b);
    console.log(`  Closest: threshold=${closest.threshold}, FAR=${(closest.FAR * 100).toFixed(4)}%, FRR=${(closest.FRR * 100).toFixed(4)}%`);
  }
  
  // Also show EER (Equal Error Rate)
  let eerResult = results[0];
  for (const r of results) {
    if (Math.abs(r.FAR - r.FRR) < Math.abs(eerResult.FAR - eerResult.FRR)) {
      eerResult = r;
    }
  }
  console.log('');
  console.log(`  Equal Error Rate (EER): ~${((eerResult.FAR + eerResult.FRR) / 2 * 100).toFixed(4)}% at threshold ${eerResult.threshold.toFixed(3)}`);
}

function writeCsv(results, outputCsv) {
  const header = 'threshold,FAR,FRR,TAR,accuracy,falseAccepts,falseRejects,genuineCount,impostorCount\n';
  const rows = results.map(r => 
    `${r.threshold},${r.FAR},${r.FRR},${r.TAR},${r.accuracy},${r.falseAccepts},${r.falseRejects},${r.genuineCount},${r.impostorCount}`
  ).join('\n');
  
  fs.writeFileSync(outputCsv, header + rows);
  console.log(`\nResults written to: ${outputCsv}`);
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / arr.length);
}

function dPrime(genuine, impostor) {
  const mg = mean(genuine);
  const mi = mean(impostor);
  const sg = std(genuine);
  const si = std(impostor);
  return Math.abs(mi - mg) / Math.sqrt((sg * sg + si * si) / 2);
}

// Run
main().catch(err => {
  console.error('Evaluation failed:', err);
  process.exit(1);
});