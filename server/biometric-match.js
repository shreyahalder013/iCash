/* =========================================================
   ICASH — Biometric Matching Module
   Pure, unit-tested, zero I/O.
   ========================================================= */

/**
 * Euclidean distance between two 128-d vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function euclideanDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 128 || b.length !== 128) {
    return Infinity;
  }
  let sum = 0;
  for (let i = 0; i < 128; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * Cosine similarity between two 128-d vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 128 || b.length !== 128) {
    return 0;
  }
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < 128; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {return 0;}
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Validate descriptor array.
 * @param {number[]} desc
 * @returns {boolean}
 */
function isValidDescriptor(desc) {
  return Array.isArray(desc) && desc.length === 128 && desc.every(v => typeof v === 'number' && isFinite(v));
}

/**
 * Validate enrolled templates array.
 * @param {number[][]} templates
 * @returns {{valid: boolean, reason?: string}}
 */
function validateEnrolledTemplates(templates) {
  if (!Array.isArray(templates) || templates.length === 0) {
    return { valid: false, reason: 'NO_TEMPLATES' };
  }
  for (const t of templates) {
    if (!isValidDescriptor(t)) {
      return { valid: false, reason: 'INVALID_DESCRIPTOR' };
    }
  }
  return { valid: true };
}

/**
 * Validate live frames array.
 * @param {number[][]} frames
 * @param {number} minFrames
 * @returns {{valid: boolean, reason?: string}}
 */
function validateLiveFrames(frames, minFrames = 3) {
  if (!Array.isArray(frames) || frames.length < minFrames) {
    return { valid: false, reason: `INSUFFICIENT_FRAMES_MIN_${minFrames}` };
  }
  for (const f of frames) {
    if (!isValidDescriptor(f)) {
      return { valid: false, reason: 'INVALID_DESCRIPTOR' };
    }
  }
  return { valid: true };
}

/**
 * Compute nearest-neighbor distance from frame to enrolled set.
 * @param {number[]} frame - 128-d descriptor
 * @param {number[][]} enrolled - K x 128
 * @returns {number} minimum distance
 */
function nearestEnrolledDistance(frame, enrolled) {
  let minDist = Infinity;
  for (const e of enrolled) {
    const d = euclideanDistance(frame, e);
    if (d < minDist) {minDist = d;}
  }
  return minDist;
}

/**
 * Compute self-consistency: median pairwise distance among live frames.
 * @param {number[][]} frames - M x 128
 * @returns {number} median pairwise distance
 */
function selfConsistency(frames) {
  const distances = [];
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      distances.push(euclideanDistance(frames[i], frames[j]));
    }
  }
  if (distances.length === 0) {return Infinity;}
  distances.sort((a, b) => a - b);
  const mid = Math.floor(distances.length / 2);
  return distances.length % 2 === 0
    ? (distances[mid - 1] + distances[mid]) / 2
    : distances[mid];
}

/**
 * Main verification function.
 * @param {Object} params
 * @param {number[][]} params.enrolledTemplates - K x 128 enrolled descriptors
 * @param {number[][]} params.liveFrames - M x 128 live capture descriptors
 * @param {Object} [options]
 * @param {number} [options.threshold=0.50] - Match threshold
 * @param {number} [options.margin=0.15] - Max allowed frame distance above threshold
 * @param {number} [options.minFrameRatio=0.6] - Minimum fraction of frames ≤ threshold
 * @param {number} [options.selfConsistencyBound=0.25] - Max median pairwise distance among live frames
 * @param {number} [options.minFrames=3] - Minimum required frames
 * @returns {{accept: boolean, scores: number[], medianScore: number, frameRatio: number, selfConsistency: number, reasonCodes: string[]}}
 */
function verifyBiometric({ enrolledTemplates, liveFrames }, options = {}) {
  const threshold = options.threshold ?? 0.50;
  const margin = options.margin ?? 0.15;
  const minFrameRatio = options.minFrameRatio ?? 0.6;
  const selfConsistencyBound = options.selfConsistencyBound ?? 0.25;
  const minFrames = options.minFrames ?? 3;

  const reasonCodes = [];

  // Validate inputs
  const enrolledCheck = validateEnrolledTemplates(enrolledTemplates);
  if (!enrolledCheck.valid) {
    return { accept: false, scores: [], medianScore: NaN, frameRatio: 0, selfConsistency: NaN, reasonCodes: [enrolledCheck.reason] };
  }

  const framesCheck = validateLiveFrames(liveFrames, minFrames);
  if (!framesCheck.valid) {
    return { accept: false, scores: [], medianScore: NaN, frameRatio: 0, selfConsistency: NaN, reasonCodes: [framesCheck.reason] };
  }

  // Score each live frame against enrolled set
  const scores = liveFrames.map(f => nearestEnrolledDistance(f, enrolledTemplates));

  // Median score
  const sortedScores = [...scores].sort((a, b) => a - b);
  const mid = Math.floor(sortedScores.length / 2);
  const medianScore = sortedScores.length % 2 === 0
    ? (sortedScores[mid - 1] + sortedScores[mid]) / 2
    : sortedScores[mid];

  // Frame ratio within threshold
  const withinThreshold = scores.filter(s => s <= threshold).length;
  const frameRatio = withinThreshold / scores.length;

  // Self-consistency check
  const consistency = selfConsistency(liveFrames);

  // Evaluate acceptance criteria
  let accept = true;

  if (medianScore > threshold) {
    accept = false;
    reasonCodes.push('MEDIAN_ABOVE_THRESHOLD');
  }

  if (frameRatio < minFrameRatio) {
    accept = false;
    reasonCodes.push('INSUFFICIENT_FRAMES_WITHIN_THRESHOLD');
  }

  // No frame exceeds threshold + margin
  const maxAllowed = threshold + margin;
  if (scores.some(s => s > maxAllowed)) {
    accept = false;
    reasonCodes.push('FRAME_EXCEEDS_MARGIN');
  }

  if (consistency > selfConsistencyBound) {
    accept = false;
    reasonCodes.push('SELF_CONSISTENCY_VIOLATION');
  }

  if (accept && reasonCodes.length === 0) {
    reasonCodes.push('ACCEPTED');
  }

  return {
    accept,
    scores,
    medianScore,
    frameRatio,
    selfConsistency: consistency,
    reasonCodes
  };
}

/**
 * Enrollment quality assessment for a single capture.
 * @param {Object} params
 * @param {number[][]} params.landmarks - 478 MediaPipe landmarks (optional, for pose/blur)
 * @param {number} params.faceHeightRatio - Face height / frame height
 * @param {number} params.brightness - Mean pixel brightness 0-255
 * @param {number} params.blurScore - Laplacian variance
 * @param {number} params.yaw - Head yaw degrees
 * @param {number} params.pitch - Head pitch degrees
 * @param {number} params.roll - Head roll degrees
 * @param {number} params.detectionConfidence - MediaPipe detection confidence
 * @param {Object} [options]
 * @returns {{accept: boolean, quality: number, reasonCodes: string[]}}
 */
function assessEnrollmentQuality({
  _landmarks,
  faceHeightRatio,
  brightness,
  blurScore,
  yaw,
  pitch,
  roll,
  detectionConfidence
}, _options = {}) {
  const reasonCodes = [];

  // Exactly one face (enforced upstream, but check confidence)
  if (detectionConfidence < 0.7) {
    reasonCodes.push('LOW_DETECTION_CONFIDENCE');
  }

  // Face size
  if (faceHeightRatio < 0.3) {
    reasonCodes.push('FACE_TOO_SMALL');
  }

  // Brightness
  if (brightness < 40 || brightness > 200) {
    reasonCodes.push('BRIGHTNESS_OUT_OF_RANGE');
  }

  // Blur
  if (blurScore < 100) {
    reasonCodes.push('TOO_BLURRY');
  }

  // Pose
  const maxPose = Math.max(Math.abs(yaw), Math.abs(pitch), Math.abs(roll));
  if (maxPose > 20) { // Allow slightly more during enrollment for pose diversity
    reasonCodes.push('POSE_TOO_EXTREME');
  }

  // Quality score (0-1)
  let quality = 1.0;
  if (brightness < 60 || brightness > 180) {quality *= 0.8;}
  if (blurScore < 200) {quality *= 0.7;}
  if (maxPose > 10) {quality *= 0.9;}

  return {
    accept: reasonCodes.length === 0,
    quality: Math.round(quality * 100) / 100,
    reasonCodes: reasonCodes.length === 0 ? ['QUALITY_ACCEPTED'] : reasonCodes
  };
}

module.exports = {
  euclideanDistance,
  cosineSimilarity,
  isValidDescriptor,
  validateEnrolledTemplates,
  validateLiveFrames,
  nearestEnrolledDistance,
  selfConsistency,
  verifyBiometric,
  assessEnrollmentQuality
};