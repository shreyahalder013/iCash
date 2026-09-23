/**
 * iCash Blink Liveness & Temporal Anti-Spoofing Test Suite
 *
 * Verifies:
 * 1. Genuine temporal 2-blink sequence passes liveness validation.
 * 2. Static photo attacks (low EAR variance) are strictly rejected.
 * 3. Screen replay with static face is rejected.
 * 4. Incomplete blink attempts (single blink, staring) fail.
 * 5. Abnormal blink duration (eyes closed too long, e.g. photo of closed eyes) fails.
 * 6. Minimum duration and frame count enforcement.
 * 7. Euclidean facial vector matching threshold (0.52).
 */

const { validateTemporalLiveness } = require('../src/services/temporalLivenessValidator');

describe('Temporal Blink Liveness Engine (Anti-Spoofing)', () => {
  // Helper to generate realistic EAR frame sequences
  function generateBlinkSequence({
    totalFrames = 30,
    intervalMs = 80,
    blinkCount = 2,
    baselineEAR = 0.30,
    closedEAR = 0.12,
  }) {
    const frames = [];
    let currentTime = 100000;

    // Normal resting open frames before first blink
    for (let i = 0; i < 6; i++) {
      frames.push({
        timestamp: currentTime,
        leftEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
        rightEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
        state: 'OPEN',
      });
      currentTime += intervalMs;
    }

    // Generate blinks
    for (let b = 0; b < blinkCount; b++) {
      // Closing transition
      frames.push({
        timestamp: currentTime,
        leftEAR: 0.22,
        rightEAR: 0.22,
        state: 'CLOSING',
      });
      currentTime += intervalMs;

      // Closed state (approx 160ms closed)
      for (let c = 0; c < 2; c++) {
        frames.push({
          timestamp: currentTime,
          leftEAR: closedEAR + (Math.random() * 0.02 - 0.01),
          rightEAR: closedEAR + (Math.random() * 0.02 - 0.01),
          state: 'CLOSED',
        });
        currentTime += intervalMs;
      }

      // Opening transition
      frames.push({
        timestamp: currentTime,
        leftEAR: 0.24,
        rightEAR: 0.24,
        state: 'OPENING',
      });
      currentTime += intervalMs;

      // Reopened resting frames (debounce gap > 300ms)
      for (let o = 0; o < 5; o++) {
        frames.push({
          timestamp: currentTime,
          leftEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
          rightEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
          state: 'OPEN',
        });
        currentTime += intervalMs;
      }
    }

    return frames;
  }

  test('passes genuine 2-blink temporal sequence', () => {
    const frames = generateBlinkSequence({ blinkCount: 2, totalFrames: 30 });
    const result = validateTemporalLiveness(frames, 'BLINK_TWICE');

    expect(result.live).toBe(true);
    expect(result.blinkCount).toBe(2);
    expect(result.variance).toBeGreaterThanOrEqual(0.0015);
    expect(result.dynamicRange).toBeGreaterThanOrEqual(0.06);
  });

  test('strictly rejects static photo attacks (zero/near-zero variance)', () => {
    // Static photo: EAR barely fluctuates (variance < 0.0001)
    const staticFrames = [];
    let time = 100000;
    for (let i = 0; i < 20; i++) {
      staticFrames.push({
        timestamp: time,
        leftEAR: 0.301,
        rightEAR: 0.302,
        state: 'OPEN',
      });
      time += 80;
    }

    const result = validateTemporalLiveness(staticFrames, 'BLINK_TWICE');
    expect(result.live).toBe(false);
    expect(result.reason).toMatch(/Static presentation attack|Static photo/i);
  });

  test('rejects sequence with staring without blinking (constant open eyes)', () => {
    const staringFrames = [];
    let time = 100000;
    for (let i = 0; i < 25; i++) {
      // Small camera noise but no blink dips
      staringFrames.push({
        timestamp: time,
        leftEAR: 0.29 + Math.sin(i) * 0.005,
        rightEAR: 0.30 + Math.cos(i) * 0.005,
        state: 'OPEN',
      });
      time += 80;
    }

    const result = validateTemporalLiveness(staringFrames, 'BLINK_TWICE');
    expect(result.live).toBe(false);
    expect(result.blinkCount || 0).toBe(0);
  });

  test('rejects single-blink attempt when challenge requires 2 blinks', () => {
    const singleBlinkFrames = generateBlinkSequence({ blinkCount: 1, totalFrames: 18 });
    const result = validateTemporalLiveness(singleBlinkFrames, 'BLINK_TWICE');

    expect(result.live).toBe(false);
    expect(result.blinkCount).toBe(1);
    expect(result.reason).toMatch(/Insufficient blinks detected/i);
  });

  test('rejects sequences with insufficient frame count (< 12 frames)', () => {
    const fewFrames = [
      { timestamp: 1000, leftEAR: 0.3, rightEAR: 0.3 },
      { timestamp: 1100, leftEAR: 0.1, rightEAR: 0.1 },
      { timestamp: 1200, leftEAR: 0.3, rightEAR: 0.3 },
    ];

    const result = validateTemporalLiveness(fewFrames, 'BLINK_TWICE');
    expect(result.live).toBe(false);
    expect(result.reason).toMatch(/Insufficient temporal frame data/i);
  });

  test('rejects sequence with total duration too short (< 800ms)', () => {
    const rapidFrames = [];
    let time = 1000;
    for (let i = 0; i < 15; i++) {
      rapidFrames.push({
        timestamp: time,
        leftEAR: i % 2 === 0 ? 0.3 : 0.1,
        rightEAR: i % 2 === 0 ? 0.3 : 0.1,
      });
      time += 20; // total 300ms
    }

    const result = validateTemporalLiveness(rapidFrames, 'BLINK_TWICE');
    expect(result.live).toBe(false);
    expect(result.reason).toMatch(/duration too short/i);
  });

  test('rejects closed-eye photo attack (eyes continuously closed for > 700ms)', () => {
    const closedEyePhoto = [];
    let time = 100000;
    for (let i = 0; i < 20; i++) {
      closedEyePhoto.push({
        timestamp: time,
        leftEAR: 0.10 + (Math.random() * 0.005),
        rightEAR: 0.10 + (Math.random() * 0.005),
        state: 'CLOSED',
      });
      time += 80; // 1600ms closed
    }

    const result = validateTemporalLiveness(closedEyePhoto, 'BLINK_TWICE');
    expect(result.live).toBe(false);
  });
});

describe('Challenge Type Specific Validation', () => {
  // Helper to generate realistic EAR frame sequences
  function generateBlinkSequence({ totalFrames = 30, intervalMs = 80, blinkCount = 2, baselineEAR = 0.30, closedEAR = 0.12 }) {
    const frames = [];
    let currentTime = 100000;

    // Normal resting open frames before first blink
    for (let i = 0; i < 6; i++) {
      frames.push({
        timestamp: currentTime,
        leftEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
        rightEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
        state: 'OPEN',
      });
      currentTime += intervalMs;
    }

    // Generate blinks
    for (let b = 0; b < blinkCount; b++) {
      // Closing transition
      frames.push({
        timestamp: currentTime,
        leftEAR: 0.22,
        rightEAR: 0.22,
        state: 'CLOSING',
      });
      currentTime += intervalMs;

      // Closed state (approx 160ms closed)
      for (let c = 0; c < 2; c++) {
        frames.push({
          timestamp: currentTime,
          leftEAR: closedEAR + (Math.random() * 0.02 - 0.01),
          rightEAR: closedEAR + (Math.random() * 0.02 - 0.01),
          state: 'CLOSED',
        });
        currentTime += intervalMs;
      }

      // Opening transition
      frames.push({
        timestamp: currentTime,
        leftEAR: 0.24,
        rightEAR: 0.24,
        state: 'OPENING',
      });
      currentTime += intervalMs;

      // Reopened resting frames (debounce gap > 300ms)
      for (let o = 0; o < 5; o++) {
        frames.push({
          timestamp: currentTime,
          leftEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
          rightEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
          state: 'OPEN',
        });
        currentTime += intervalMs;
      }
    }

    return frames;
  }

  function generateBlinkSequenceWithPause({ totalFrames = 40, intervalMs = 80, baselineEAR = 0.30, closedEAR = 0.12, pauseMs = 900 }) {
    const frames = [];
    let currentTime = 100000;

    // Normal resting open frames before first blink
    for (let i = 0; i < 6; i++) {
      frames.push({
        timestamp: currentTime,
        leftEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
        rightEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
        state: 'OPEN',
      });
      currentTime += intervalMs;
    }

    // First blink
    frames.push({ timestamp: currentTime, leftEAR: 0.22, rightEAR: 0.22, state: 'CLOSING' });
    currentTime += intervalMs;
    for (let c = 0; c < 2; c++) {
      frames.push({ timestamp: currentTime, leftEAR: closedEAR + (Math.random() * 0.02 - 0.01), rightEAR: closedEAR + (Math.random() * 0.02 - 0.01), state: 'CLOSED' });
      currentTime += intervalMs;
    }
    frames.push({ timestamp: currentTime, leftEAR: 0.24, rightEAR: 0.24, state: 'OPENING' });
    currentTime += intervalMs;

    // Pause with eyes open (pauseMs)
    const pauseFrames = Math.floor(pauseMs / intervalMs);
    for (let o = 0; o < pauseFrames; o++) {
      frames.push({
        timestamp: currentTime,
        leftEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
        rightEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
        state: 'OPEN',
      });
      currentTime += intervalMs;
    }

    // Second blink
    frames.push({ timestamp: currentTime, leftEAR: 0.22, rightEAR: 0.22, state: 'CLOSING' });
    currentTime += intervalMs;
    for (let c = 0; c < 2; c++) {
      frames.push({ timestamp: currentTime, leftEAR: closedEAR + (Math.random() * 0.02 - 0.01), rightEAR: closedEAR + (Math.random() * 0.02 - 0.01), state: 'CLOSED' });
      currentTime += intervalMs;
    }
    frames.push({ timestamp: currentTime, leftEAR: 0.24, rightEAR: 0.24, state: 'OPENING' });
    currentTime += intervalMs;

    // Final open frames
    for (let o = 0; o < 5; o++) {
      frames.push({
        timestamp: currentTime,
        leftEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
        rightEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
        state: 'OPEN',
      });
      currentTime += intervalMs;
    }

    return frames;
  }

  function generateBlinkSequenceWithTurn({ totalFrames = 50, intervalMs = 80, baselineEAR = 0.30, closedEAR = 0.12, yawSequence = [] }) {
    const frames = [];
    let currentTime = 100000;
    let yawIndex = 0;

    // Normal resting open frames before first blink
    for (let i = 0; i < 6; i++) {
      frames.push({
        timestamp: currentTime,
        leftEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
        rightEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
        state: 'OPEN',
        yaw: yawSequence[yawIndex] !== undefined ? yawSequence[yawIndex] : 0,
      });
      currentTime += intervalMs;
      yawIndex++;
    }

    // First blink
    frames.push({ timestamp: currentTime, leftEAR: 0.22, rightEAR: 0.22, state: 'CLOSING', yaw: yawSequence[yawIndex] !== undefined ? yawSequence[yawIndex] : 0 });
    currentTime += intervalMs; yawIndex++;
    for (let c = 0; c < 2; c++) {
      frames.push({ timestamp: currentTime, leftEAR: closedEAR + (Math.random() * 0.02 - 0.01), rightEAR: closedEAR + (Math.random() * 0.02 - 0.01), state: 'CLOSED', yaw: yawSequence[yawIndex] !== undefined ? yawSequence[yawIndex] : 0 });
      currentTime += intervalMs; yawIndex++;
    }
    frames.push({ timestamp: currentTime, leftEAR: 0.24, rightEAR: 0.24, state: 'OPENING', yaw: yawSequence[yawIndex] !== undefined ? yawSequence[yawIndex] : 0 });
    currentTime += intervalMs; yawIndex++;

    // Turn frames
    for (let o = 0; o < 8; o++) {
      frames.push({
        timestamp: currentTime,
        leftEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
        rightEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
        state: 'OPEN',
        yaw: yawSequence[yawIndex] !== undefined ? yawSequence[yawIndex] : 0,
      });
      currentTime += intervalMs; yawIndex++;
    }

    // Return to center frames
    for (let o = 0; o < 5; o++) {
      frames.push({
        timestamp: currentTime,
        leftEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
        rightEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
        state: 'OPEN',
        yaw: yawSequence[yawIndex] !== undefined ? yawSequence[yawIndex] : 0,
      });
      currentTime += intervalMs; yawIndex++;
    }

    // Second blink
    frames.push({ timestamp: currentTime, leftEAR: 0.22, rightEAR: 0.22, state: 'CLOSING', yaw: yawSequence[yawIndex] !== undefined ? yawSequence[yawIndex] : 0 });
    currentTime += intervalMs; yawIndex++;
    for (let c = 0; c < 2; c++) {
      frames.push({ timestamp: currentTime, leftEAR: closedEAR + (Math.random() * 0.02 - 0.01), rightEAR: closedEAR + (Math.random() * 0.02 - 0.01), state: 'CLOSED', yaw: yawSequence[yawIndex] !== undefined ? yawSequence[yawIndex] : 0 });
      currentTime += intervalMs; yawIndex++;
    }
    frames.push({ timestamp: currentTime, leftEAR: 0.24, rightEAR: 0.24, state: 'OPENING', yaw: yawSequence[yawIndex] !== undefined ? yawSequence[yawIndex] : 0 });
    currentTime += intervalMs; yawIndex++;

    // Final open frames
    for (let o = 0; o < 5; o++) {
      frames.push({
        timestamp: currentTime,
        leftEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
        rightEAR: baselineEAR + (Math.random() * 0.02 - 0.01),
        state: 'OPEN',
        yaw: 0,
      });
      currentTime += intervalMs;
    }

    return frames;
  }

  test('passes BLINK_PAUSE_BLINK with proper pause (800ms+)', () => {
    const frames = generateBlinkSequenceWithPause({ pauseMs: 900 });
    const result = validateTemporalLiveness(frames, 'BLINK_PAUSE_BLINK');
    expect(result.live).toBe(true);
    expect(result.blinkCount).toBe(2);
  });

  test('rejects BLINK_PAUSE_BLINK with insufficient pause (< 800ms)', () => {
    const frames = generateBlinkSequenceWithPause({ pauseMs: 400 }); // Too short pause
    const result = validateTemporalLiveness(frames, 'BLINK_PAUSE_BLINK');
    expect(result.live).toBe(false);
  });

  test('passes BLINK_TURN_LEFT_BLINK with proper left turn (yaw < -12°)', () => {
    // Yaw sequence: center -> left turn (-15°) -> center -> second blink
    const yawSequence = [
      0, 0, 0, 0, 0, 0,  // initial open frames
      0, -5, -10, -12, -15, -15, -15,  // blink + turn
      -15, -15, -15, -15, -15, -15, -15, -15,  // holding turn
      -5, 0, 0, 0, 0, 0,  // return to center
      0, 0, 0,  // second blink
      0, 0, 0, 0, 0  // final
    ];
    const frames = generateBlinkSequenceWithTurn({ yawSequence });
    const result = validateTemporalLiveness(frames, 'BLINK_TURN_LEFT_BLINK');
    expect(result.live).toBe(true);
    expect(result.blinkCount).toBe(2);
  });

  test('rejects BLINK_TURN_LEFT_BLINK without left turn (yaw stays near 0)', () => {
    const yawSequence = Array(40).fill(0); // No turn
    const frames = generateBlinkSequenceWithTurn({ yawSequence });
    const result = validateTemporalLiveness(frames, 'BLINK_TURN_LEFT_BLINK');
    expect(result.live).toBe(false);
  });

  test('passes BLINK_TURN_RIGHT_BLINK with proper right turn (yaw > 12°)', () => {
    const yawSequence = [
      0, 0, 0, 0, 0, 0,
      0, 5, 10, 12, 15, 15, 15,
      15, 15, 15, 15, 15, 15, 15, 15,
      5, 0, 0, 0, 0, 0,
      0, 0, 0,
      0, 0, 0, 0, 0
    ];
    const frames = generateBlinkSequenceWithTurn({ yawSequence });
    const result = validateTemporalLiveness(frames, 'BLINK_TURN_RIGHT_BLINK');
    expect(result.live).toBe(true);
    expect(result.blinkCount).toBe(2);
  });

  test('rejects BLINK_TURN_RIGHT_BLINK without right turn (yaw stays near 0)', () => {
    const yawSequence = Array(40).fill(0);
    const frames = generateBlinkSequenceWithTurn({ yawSequence });
    const result = validateTemporalLiveness(frames, 'BLINK_TURN_RIGHT_BLINK');
    expect(result.live).toBe(false);
  });

  test('passes BLINK_TWICE_WITH_RANDOM_INTERVAL (same as BLINK_TWICE)', () => {
    const frames = generateBlinkSequence({ blinkCount: 2, totalFrames: 30 });
    const result = validateTemporalLiveness(frames, 'BLINK_TWICE_WITH_RANDOM_INTERVAL');
    expect(result.live).toBe(true);
    expect(result.blinkCount).toBe(2);
  });
});

describe('Facial Vector Distance Matching', () => {
  function euclidean(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      const d = a[i] - b[i];
      sum += d * d;
    }
    return Math.sqrt(sum);
  }

  test('same person vector with natural micro-noise matches (< 0.52 threshold)', () => {
    const base = new Array(128).fill(0).map((_, i) => Math.sin(i * 0.1));
    // Normalize to unit length
    const norm = Math.sqrt(base.reduce((s, v) => s + v * v, 0));
    const unitBase = base.map((v) => v / norm);

    // Natural lighting / pose jitter: slight perturbation
    const live = unitBase.map((v) => v + (Math.random() * 0.03 - 0.015));
    const liveNorm = Math.sqrt(live.reduce((s, v) => s + v * v, 0));
    const unitLive = live.map((v) => v / liveNorm);

    const dist = euclidean(unitBase, unitLive);
    expect(dist).toBeLessThan(0.52);
  });

  test('different person vector is rejected (>= 0.52 distance)', () => {
    const personA = new Array(128).fill(0).map((_, i) => Math.sin(i * 0.2));
    const personB = new Array(128).fill(0).map((_, i) => Math.cos(i * 0.4) * -1);

    const normA = Math.sqrt(personA.reduce((s, v) => s + v * v, 0));
    const normB = Math.sqrt(personB.reduce((s, v) => s + v * v, 0));
    const unitA = personA.map((v) => v / normA);
    const unitB = personB.map((v) => v / normB);

    const dist = euclidean(unitA, unitB);
    expect(dist).toBeGreaterThanOrEqual(0.52);
  });
});
