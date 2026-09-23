/**
 * Temporal Liveness Validator
 *
 * Evaluates the temporal frame sequence submitted by the client during a biometric challenge.
 * Enforces:
 *   1. Anti-Photo / Anti-Static Screen: Checks EAR variance and dynamic range.
 *   2. Strict Temporal State Machine: Evaluates OPEN -> CLOSED -> OPEN transitions.
 *   3. Dual-Eye Closure: Both left and right eyes must close during each blink.
 *   4. Temporal Duration: Each blink closure must last between MIN_BLINK_MS (70ms) and MAX_BLINK_MS (700ms).
 *   5. Inter-Blink Debounce: Consecutive blinks must have at least BLINK_DEBOUNCE_MS (250ms) separation.
 *   6. Required Blinks: Must complete the required number of blinks (e.g. 2 for BLINK_TWICE).
 *   7. Challenge-Specific: Pause validation (BLINK_PAUSE_BLINK), Head turn validation (BLINK_TURN_LEFT/RIGHT_BLINK)
 */

const MIN_FRAMES = 12;
const MIN_SESSION_DURATION_MS = 800;
const MAX_SESSION_DURATION_MS = 60000;

const MIN_BLINK_MS = 70;
const MAX_BLINK_MS = 700;
const BLINK_DEBOUNCE_MS = 250;

const MIN_EAR_VARIANCE = 0.0015; // Static photos have variance < 0.001
const MIN_EAR_DYNAMIC_RANGE = 0.06; // Difference between peak open and lowest closed

// Head turn thresholds (matching Python service)
const YAW_TURN_THRESHOLD_DEG = 12.0;
const YAW_RETURN_THRESHOLD_DEG = 7.0;
const MIN_PAUSE_MS = 800; // For BLINK_PAUSE_BLINK

function calculateVariance(values) {
  if (!values || values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squareDiffs = values.map((v) => {
    const diff = v - mean;
    return diff * diff;
  });
  return squareDiffs.reduce((a, b) => a + b, 0) / values.length;
}

function validateTemporalProof(proofFrames, requiredBlinks = 2, challengeType = 'BLINK_TWICE') {
  if (!Array.isArray(proofFrames) || proofFrames.length < MIN_FRAMES) {
    return {
      valid: false,
      reason: `Insufficient temporal frame data (${proofFrames ? proofFrames.length : 0} frames, minimum ${MIN_FRAMES} required).`,
    };
  }

  // 1. Sort frames by timestamp
  const frames = proofFrames
    .map((f) => ({
      timestamp: Number(f.timestamp),
      leftEAR: Number(f.leftEAR ?? f.earLeft ?? 0.3),
      rightEAR: Number(f.rightEAR ?? f.earRight ?? 0.3),
      avgEAR: Number(
        f.avgEAR ?? ((f.leftEAR ?? f.earLeft ?? 0.3) + (f.rightEAR ?? f.earRight ?? 0.3)) / 2
      ),
      state: f.state || 'OPEN',
      yaw: Number(f.yaw ?? 0),
    }))
    .filter((f) => !isNaN(f.timestamp) && f.timestamp > 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (frames.length < MIN_FRAMES) {
    return { valid: false, reason: 'Invalid or corrupted frame timestamps.' };
  }

  const duration = frames[frames.length - 1].timestamp - frames[0].timestamp;
  if (duration < MIN_SESSION_DURATION_MS) {
    return {
      valid: false,
      reason: `Verification duration too short (${duration}ms). Real human blink challenge requires at least ${MIN_SESSION_DURATION_MS}ms.`,
    };
  }

  if (duration > MAX_SESSION_DURATION_MS) {
    return {
      valid: false,
      reason: `Verification duration exceeded maximum allowed (${duration}ms).`,
    };
  }

  // 2. Anti-Photo / Static Image Check (Variance & Dynamic Range)
  const avgEars = frames.map((f) => f.avgEAR);
  const variance = calculateVariance(avgEars);
  const minEar = Math.min(...avgEars);
  const maxEar = Math.max(...avgEars);
  const dynamicRange = maxEar - minEar;

  if (variance < MIN_EAR_VARIANCE || dynamicRange < MIN_EAR_DYNAMIC_RANGE) {
    return {
      valid: false,
      reason: `Static presentation attack detected (variance=${variance.toFixed(4)}, range=${dynamicRange.toFixed(3)}). A live temporal blink was not observed.`,
    };
  }

  // 3. Compute Baseline EAR from upper quartile (open-eye state)
  const sortedEars = [...avgEars].sort((a, b) => a - b);
  const baselineIndex = Math.floor(sortedEars.length * 0.75);
  const baselineEAR = sortedEars[baselineIndex] || 0.3;
  const closeThreshold = Math.max(0.12, baselineEAR * 0.74);
  const openThreshold = Math.max(0.18, baselineEAR * 0.88);

  // 4. Temporal State Machine Re-evaluation
  // Validates transitions: OPEN -> CLOSED (both eyes) -> OPEN
  let blinkCount = 0;
  let inBlink = false;
  let blinkStart = 0;
  let lastBlinkEnd = 0;
  const validBlinks = [];

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    // Both eyes must be closed below threshold
    const bothClosed = f.leftEAR < closeThreshold && f.rightEAR < closeThreshold;
    const bothOpen = f.avgEAR >= openThreshold;

    if (!inBlink) {
      if (bothClosed) {
        // Must respect debounce from previous blink
        if (lastBlinkEnd === 0 || f.timestamp - lastBlinkEnd >= BLINK_DEBOUNCE_MS) {
          inBlink = true;
          blinkStart = f.timestamp;
        }
      }
    } else {
      if (bothOpen) {
        const blinkDuration = f.timestamp - blinkStart;
        inBlink = false;

        if (blinkDuration >= MIN_BLINK_MS && blinkDuration <= MAX_BLINK_MS) {
          blinkCount++;
          lastBlinkEnd = f.timestamp;
          validBlinks.push({
            index: blinkCount,
            start: blinkStart,
            end: f.timestamp,
            duration: blinkDuration,
          });
        }
      } else {
        // If eyes remain closed longer than maximum duration, invalidate this blink
        if (f.timestamp - blinkStart > MAX_BLINK_MS) {
          inBlink = false;
        }
      }
    }
  }

  if (blinkCount < requiredBlinks) {
    return {
      valid: false,
      reason: `Insufficient blinks detected (${blinkCount}/${requiredBlinks}). A full two-blink sequence is required for liveness authentication.`,
      blinkCount,
      requiredBlinks,
    };
  }

  // 5. Challenge-Specific Validation
  // BLINK_PAUSE_BLINK: Requires a pause of at least 800ms between blinks
  if (challengeType === 'BLINK_PAUSE_BLINK') {
    if (validBlinks.length >= 2) {
      const pauseDuration = validBlinks[1].start - validBlinks[0].end;
      if (pauseDuration < MIN_PAUSE_MS) {
        return {
          valid: false,
          reason: `Insufficient pause between blinks (${pauseDuration}ms). BLINK_PAUSE_BLINK requires at least ${MIN_PAUSE_MS}ms pause with eyes open.`,
          blinkCount,
          requiredBlinks,
        };
      }
    } else {
      return {
        valid: false,
        reason: 'BLINK_PAUSE_BLINK requires two blinks with a pause between them.',
        blinkCount,
        requiredBlinks,
      };
    }
  }

  // BLINK_TURN_LEFT_BLINK / BLINK_TURN_RIGHT_BLINK: Require head turn
  if (challengeType === 'BLINK_TURN_LEFT_BLINK' || challengeType === 'BLINK_TURN_RIGHT_BLINK') {
    const isLeftTurn = challengeType === 'BLINK_TURN_LEFT_BLINK';
    const requiredYaw = isLeftTurn ? -YAW_TURN_THRESHOLD_DEG : YAW_TURN_THRESHOLD_DEG;
    const returnYaw = isLeftTurn ? -YAW_RETURN_THRESHOLD_DEG : YAW_RETURN_THRESHOLD_DEG;

    // Find max absolute yaw during the session (after first blink)
    let maxYaw = 0;
    let minYaw = 0;
    let firstBlinkEnd = validBlinks.length > 0 ? validBlinks[0].end : 0;

    for (const f of frames) {
      if (f.timestamp > firstBlinkEnd) {
        if (f.yaw > maxYaw) maxYaw = f.yaw;
        if (f.yaw < minYaw) minYaw = f.yaw;
      }
    }

    const maxAbsYaw = isLeftTurn ? Math.abs(minYaw) : Math.abs(maxYaw);
    const achievedYaw = isLeftTurn ? minYaw : maxYaw;

    if (isLeftTurn) {
      if (achievedYaw > requiredYaw) {
        // e.g., -5 > -12 means not enough left turn
        return {
          valid: false,
          reason: `Insufficient left head turn (yaw=${achievedYaw.toFixed(1)}°). BLINK_TURN_LEFT_BLINK requires turning left beyond ${YAW_TURN_THRESHOLD_DEG}°.`,
          blinkCount,
          requiredBlinks,
        };
      }
      // Check return to center
      const lastFrames = frames.slice(-10);
      const returnedToCenter = lastFrames.every((f) => f.yaw > returnYaw);
      if (!returnedToCenter) {
        return {
          valid: false,
          reason: `Head did not return to center after left turn. Final yaw=${lastFrames[lastFrames.length - 1].yaw.toFixed(1)}°.`,
          blinkCount,
          requiredBlinks,
        };
      }
    } else {
      if (achievedYaw < requiredYaw) {
        // e.g., 5 < 12 means not enough right turn
        return {
          valid: false,
          reason: `Insufficient right head turn (yaw=${achievedYaw.toFixed(1)}°). BLINK_TURN_RIGHT_BLINK requires turning right beyond ${YAW_TURN_THRESHOLD_DEG}°.`,
          blinkCount,
          requiredBlinks,
        };
      }
      // Check return to center
      const lastFrames = frames.slice(-10);
      const returnedToCenter = lastFrames.every((f) => f.yaw < returnYaw);
      if (!returnedToCenter) {
        return {
          valid: false,
          reason: `Head did not return to center after right turn. Final yaw=${lastFrames[lastFrames.length - 1].yaw.toFixed(1)}°.`,
          blinkCount,
          requiredBlinks,
        };
      }
    }
  }

  return {
    valid: true,
    blinkCount,
    requiredBlinks,
    duration,
    variance,
    dynamicRange,
    baselineEAR,
    blinks: validBlinks,
  };
}

function validateTemporalLiveness(proofFrames, challengeTypeOrBlinks = 2) {
  const req =
    typeof challengeTypeOrBlinks === 'number'
      ? challengeTypeOrBlinks
      : challengeTypeOrBlinks === 'BLINK_ONCE'
        ? 1
        : 2;
  const res = validateTemporalProof(
    proofFrames,
    req,
    typeof challengeTypeOrBlinks === 'string' ? challengeTypeOrBlinks : 'BLINK_TWICE'
  );
  return {
    live: res.valid,
    ...res,
  };
}

module.exports = {
  validateTemporalProof,
  validateTemporalLiveness,
  MIN_BLINK_MS,
  MAX_BLINK_MS,
  BLINK_DEBOUNCE_MS,
  MIN_EAR_VARIANCE,
  MIN_EAR_DYNAMIC_RANGE,
  YAW_TURN_THRESHOLD_DEG,
  YAW_RETURN_THRESHOLD_DEG,
  MIN_PAUSE_MS,
};
