/* =========================================================
   ICASH — Biometric Matching Module Unit Tests
   ========================================================= */
import { describe, it, expect } from 'vitest';
import {
  euclideanDistance,
  cosineSimilarity,
  isValidDescriptor,
  validateEnrolledTemplates,
  validateLiveFrames,
  nearestEnrolledDistance,
  selfConsistency,
  verifyBiometric,
  assessEnrollmentQuality
} from './biometric-match.js';

function _makeDescriptor(base = 0, noise = 0) {
  return new Array(128).fill(0).map((_v, _i) => base + (Math.random() - 0.5) * noise);
}

function _makeCluster(centroid, count, spread = 0.1) {
  return Array.from({ length: count }, () =>
    centroid.map(v => v + (Math.random() - 0.5) * 2 * spread)
  ).map(v => {
    // Normalize to unit sphere
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map(x => x / norm);
  });
}

describe('biometric-match.js — Core Math', () => {
  describe('euclideanDistance', () => {
    it('returns 0 for identical vectors', () => {
      const a = new Array(128).fill(0.5);
      expect(euclideanDistance(a, a)).toBe(0);
    });

    it('returns correct distance for known vectors', () => {
      const a = new Array(128).fill(0);
      const b = new Array(128).fill(1);
      expect(euclideanDistance(a, b)).toBeCloseTo(Math.sqrt(128), 5);
    });

    it('returns Infinity for mismatched lengths', () => {
      expect(euclideanDistance([1, 2], [1, 2, 3])).toBe(Infinity);
      expect(euclideanDistance(null, [1])).toBe(Infinity);
    });
  });

  describe('cosineSimilarity', () => {
    it('returns 1 for identical normalized vectors', () => {
      const a = new Array(128).fill(1 / Math.sqrt(128));
      expect(cosineSimilarity(a, a)).toBeCloseTo(1, 5);
    });

    it('returns 0 for orthogonal vectors', () => {
      const a = new Array(128).fill(0);
      a[0] = 1;
      const b = new Array(128).fill(0);
      b[1] = 1;
      expect(cosineSimilarity(a, b)).toBe(0);
    });
  });

  describe('isValidDescriptor', () => {
    it('accepts valid 128-d array', () => {
      expect(isValidDescriptor(new Array(128).fill(0.1))).toBe(true);
    });

    it('rejects wrong length', () => {
      expect(isValidDescriptor(new Array(127).fill(0.1))).toBe(false);
      expect(isValidDescriptor(new Array(129).fill(0.1))).toBe(false);
    });

    it('rejects non-arrays', () => {
      expect(isValidDescriptor(null)).toBe(false);
      expect(isValidDescriptor('string')).toBe(false);
      expect(isValidDescriptor(123)).toBe(false);
    });

    it('rejects non-finite values', () => {
      const bad = new Array(128).fill(0.1);
      bad[0] = NaN;
      expect(isValidDescriptor(bad)).toBe(false);
      bad[0] = Infinity;
      expect(isValidDescriptor(bad)).toBe(false);
    });
  });
});

describe('biometric-match.js — Validation', () => {
  describe('validateEnrolledTemplates', () => {
    it('accepts valid templates', () => {
      const templates = [new Array(128).fill(0.1), new Array(128).fill(0.2)];
      expect(validateEnrolledTemplates(templates).valid).toBe(true);
    });

    it('rejects empty array', () => {
      expect(validateEnrolledTemplates([]).valid).toBe(false);
    });

    it('rejects invalid descriptor', () => {
      const templates = [new Array(127).fill(0.1)];
      expect(validateEnrolledTemplates(templates).valid).toBe(false);
    });

    it('rejects non-array', () => {
      expect(validateEnrolledTemplates(null).valid).toBe(false);
    });
  });

  describe('validateLiveFrames', () => {
    it('accepts sufficient valid frames', () => {
      const frames = [new Array(128).fill(0.1), new Array(128).fill(0.2), new Array(128).fill(0.3)];
      expect(validateLiveFrames(frames, 3).valid).toBe(true);
    });

    it('rejects insufficient frames', () => {
      const frames = [new Array(128).fill(0.1), new Array(128).fill(0.2)];
      expect(validateLiveFrames(frames, 3).valid).toBe(false);
    });

    it('rejects invalid descriptor in frames', () => {
      const frames = [new Array(128).fill(0.1), new Array(127).fill(0.2)];
      expect(validateLiveFrames(frames, 2).valid).toBe(false);
    });
  });
});

describe('biometric-match.js — Distance & Consistency', () => {
  describe('nearestEnrolledDistance', () => {
    it('returns min distance to enrolled set', () => {
      const enrolled = [
        new Array(128).fill(0),
        new Array(128).fill(1)
      ];
      const frame = new Array(128).fill(0.1);
      const dist = nearestEnrolledDistance(frame, enrolled);
      expect(dist).toBeLessThan(Math.sqrt(128) * 0.9); // closer to zeros
    });
  });

  describe('selfConsistency', () => {
    it('returns Infinity for single frame', () => {
      expect(selfConsistency([new Array(128).fill(0.1)])).toBe(Infinity);
    });

    it('returns 0 for identical frames', () => {
      const frames = [new Array(128).fill(0.1), new Array(128).fill(0.1)];
      expect(selfConsistency(frames)).toBe(0);
    });

    it('computes median pairwise distance', () => {
      // Create properly normalized vectors
      const makeVec = (val) => {
        const v = new Array(128).fill(val);
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
        return v.map(x => x / norm);
      };
      const frames = [
        makeVec(1),
        makeVec(2),
        makeVec(3)
      ];
      const c = selfConsistency(frames);
      expect(c).toBeGreaterThan(0);
    });
  });
});

describe('biometric-match.js — verifyBiometric', () => {
  function makeUnitVec(val) {
    const v = new Array(128).fill(val);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map(x => x / norm);
  }

  function makeCluster(centroid, count, spread = 0.1) {
    return Array.from({ length: count }, () =>
      centroid.map(v => v + (Math.random() - 0.5) * 2 * spread)
    ).map(v => {
      // Normalize to unit sphere
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      return v.map(x => x / norm);
    });
  }

  it('accepts genuine match with multiple frames', () => {
    // Create a centroid and genuine frames around it
    // Use very tight spread to ensure genuine distances stay well below threshold
    const centroid = makeUnitVec(1);
    const enrolled = makeCluster(centroid, 5, 0.01);
    const liveFrames = makeCluster(centroid, 5, 0.015);

    const result = verifyBiometric({ enrolledTemplates: enrolled, liveFrames });
    expect(result.accept).toBe(true);
    expect(result.reasonCodes).toContain('ACCEPTED');
    expect(result.medianScore).toBeLessThan(0.50);
  });

  it('rejects impostor', () => {
    const enrolled = makeCluster(makeUnitVec(1), 5, 0.05);
    const impostorCentroid = makeUnitVec(-1); // Opposite on sphere
    const liveFrames = makeCluster(impostorCentroid, 5, 0.08);

    const result = verifyBiometric({ enrolledTemplates: enrolled, liveFrames });
    expect(result.accept).toBe(false);
    expect(result.reasonCodes.some(c => c.includes('THRESHOLD') || c.includes('MEDIAN'))).toBe(true);
  });

  it('rejects when median above threshold', () => {
    const enrolled = [makeUnitVec(1)];
    const liveFrames = Array(5).fill(makeUnitVec(-1)); // Very far
    const result = verifyBiometric({ enrolledTemplates: enrolled, liveFrames }, { threshold: 0.5 });
    expect(result.accept).toBe(false);
    expect(result.reasonCodes).toContain('MEDIAN_ABOVE_THRESHOLD');
  });

  it('rejects when frame ratio too low', () => {
    // 3 frames: 1 good, 2 bad → ratio 1/3 < 0.6 default
    const centroid = makeUnitVec(1);
    const enrolled = makeCluster(centroid, 5, 0.01);
    // Create bad frames far from centroid
    const orthogonal = new Array(128).fill(0);
    orthogonal[1] = 1;
    const norm = Math.sqrt(orthogonal.reduce((s, x) => s + x * x, 0));
    const badFrame = orthogonal.map(x => x / norm);
    
    const liveFrames = [
      ...makeCluster(centroid, 1, 0.01), // Good
      badFrame, // Bad
      badFrame  // Bad
    ];
    const result = verifyBiometric({ enrolledTemplates: enrolled, liveFrames }, { 
      threshold: 0.5, 
      minFrameRatio: 0.6, 
      margin: 1.0,
      selfConsistencyBound: 2.0
    });
    expect(result.accept).toBe(false);
    expect(result.reasonCodes).toContain('INSUFFICIENT_FRAMES_WITHIN_THRESHOLD');
  });

  it('rejects when any frame exceeds margin', () => {
    const enrolled = makeCluster(makeUnitVec(1), 5, 0.05);
    const liveFrames = [
      ...makeCluster(makeUnitVec(1), 4, 0.05), // Good
      makeUnitVec(-1) // Way outside threshold + margin
    ];
    const result = verifyBiometric({ enrolledTemplates: enrolled, liveFrames }, { threshold: 0.5, margin: 0.15 });
    expect(result.accept).toBe(false);
    expect(result.reasonCodes).toContain('FRAME_EXCEEDS_MARGIN');
  });

  it('rejects swap attack (self-consistency violation)', () => {
    // First 3 frames person A, last 3 frames person B
    const centroidA = makeUnitVec(1);
    const centroidB = makeUnitVec(0.5); // Different person
    const liveFrames = [
      ...makeCluster(centroidA, 3, 0.05),
      ...makeCluster(centroidB, 3, 0.05)
    ];
    const enrolled = makeCluster(centroidA, 5, 0.05);
    const result = verifyBiometric({ enrolledTemplates: enrolled, liveFrames }, { selfConsistencyBound: 0.25 });
    // Self-consistency between A and B frames should be high
    expect(result.selfConsistency).toBeGreaterThan(0.25);
    expect(result.accept).toBe(false);
    expect(result.reasonCodes).toContain('SELF_CONSISTENCY_VIOLATION');
  });

  it('rejects when fewer than minFrames', () => {
    const enrolled = [makeUnitVec(1)];
    const liveFrames = [makeUnitVec(1), makeUnitVec(1)]; // Only 2
    const result = verifyBiometric({ enrolledTemplates: enrolled, liveFrames }, { minFrames: 3 });
    expect(result.accept).toBe(false);
    expect(result.reasonCodes.some(c => c.includes('INSUFFICIENT_FRAMES'))).toBe(true);
  });

  it('returns reason codes for debugging', () => {
    const enrolled = [makeUnitVec(1)];
    const liveFrames = [makeUnitVec(1), makeUnitVec(1), makeUnitVec(1)]; // 3 frames to meet minFrames
    const result = verifyBiometric({ enrolledTemplates: enrolled, liveFrames });
    expect(result.reasonCodes).toContain('ACCEPTED');
  });

  it('never exposes distances in accept=false case beyond reason codes', () => {
    const enrolled = [makeUnitVec(1)];
    const liveFrames = [makeUnitVec(-1)];
    const result = verifyBiometric({ enrolledTemplates: enrolled, liveFrames });
    // Should not have raw distances in reason codes
    for (const code of result.reasonCodes) {
      expect(code).not.toMatch(/^\d+\.\d+$/); // No raw numbers as codes
    }
  });
});

describe('biometric-match.js — Enrollment Quality', () => {
  it('accepts high-quality capture', () => {
    const result = assessEnrollmentQuality({
      faceHeightRatio: 0.4,
      brightness: 128,
      blurScore: 500,
      yaw: 2,
      pitch: 1,
      roll: 0,
      detectionConfidence: 0.9
    });
    expect(result.accept).toBe(true);
    expect(result.reasonCodes).toContain('QUALITY_ACCEPTED');
  });

  it('rejects too small face', () => {
    const result = assessEnrollmentQuality({
      faceHeightRatio: 0.2,
      brightness: 128,
      blurScore: 500,
      yaw: 0,
      pitch: 0,
      roll: 0,
      detectionConfidence: 0.9
    });
    expect(result.accept).toBe(false);
    expect(result.reasonCodes).toContain('FACE_TOO_SMALL');
  });

  it('rejects extreme pose', () => {
    const result = assessEnrollmentQuality({
      faceHeightRatio: 0.4,
      brightness: 128,
      blurScore: 500,
      yaw: 30,
      pitch: 0,
      roll: 0,
      detectionConfidence: 0.9
    });
    expect(result.accept).toBe(false);
    expect(result.reasonCodes).toContain('POSE_TOO_EXTREME');
  });

  it('rejects low brightness', () => {
    const result = assessEnrollmentQuality({
      faceHeightRatio: 0.4,
      brightness: 20,
      blurScore: 500,
      yaw: 0,
      pitch: 0,
      roll: 0,
      detectionConfidence: 0.9
    });
    expect(result.accept).toBe(false);
    expect(result.reasonCodes).toContain('BRIGHTNESS_OUT_OF_RANGE');
  });

  it('rejects too blurry', () => {
    const result = assessEnrollmentQuality({
      faceHeightRatio: 0.4,
      brightness: 128,
      blurScore: 50,
      yaw: 0,
      pitch: 0,
      roll: 0,
      detectionConfidence: 0.9
    });
    expect(result.accept).toBe(false);
    expect(result.reasonCodes).toContain('TOO_BLURRY');
  });

  it('returns quality score 0-1', () => {
    const result = assessEnrollmentQuality({
      faceHeightRatio: 0.4,
      brightness: 128,
      blurScore: 500,
      yaw: 5,
      pitch: 0,
      roll: 0,
      detectionConfidence: 0.9
    });
    expect(result.quality).toBeGreaterThanOrEqual(0);
    expect(result.quality).toBeLessThanOrEqual(1);
  });
});