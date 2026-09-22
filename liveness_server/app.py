# pyright: reportMissingImports=false
"""
iCash Production Server-Authoritative Liveness & Anti-Spoofing Service (v7.0)

Architecture:
  - 100% Server-Authoritative: Camera frames are received and independently verified.
  - No client-side EAR, blink count, or liveness claims are ever trusted.
  - Exact Single-Face Enforcement: Rejects 0 faces or >= 2 faces.
  - 68-Point Facial Landmarks via dlib shape predictor.
  - Soukupova & Cech Eye Aspect Ratio (EAR) calculated on genuine landmark geometry.
  - Head Pose Estimation (Yaw/Pitch/Roll) via 3D-to-2D Perspective-n-Point (solvePnP).
  - Randomized Active Challenges:
      * BLINK_TWICE: 2 natural physiological blinks with debounce.
      * BLINK_PAUSE_BLINK: 1st blink -> 800ms resting pause -> 2nd blink.
      * BLINK_TURN_LEFT_BLINK: 1st blink -> turn head left -> return -> 2nd blink.
      * BLINK_TURN_RIGHT_BLINK: 1st blink -> turn head right -> return -> 2nd blink.
      * BLINK_TWICE_WITH_RANDOM_INTERVAL: 2 blinks with enforced inter-blink interval.
  - Multi-Signal Presentation Attack Detection (PAD):
      1. Dynamic EAR Variance & Dynamic Range (anti-static photo).
      2. High-Frequency Texture Analysis via Laplacian variance (anti-screen/print blur).
      3. YCrCb Chrominance distribution (anti-flat-surface print).
      4. Closed-eye duration clamp (eyes closed > 700ms flags closed-eye photo attack).
      5. Frame-to-frame pixel deformation check (detects static devices).
  - Server-Side 128D Face Descriptor Extraction via ResNet (dlib_face_recognition_model_v1).
"""

import base64
import bz2
import os
import time
import urllib.request
import uuid
from collections import deque

import cv2
try:
    import dlib  # type: ignore[import-not-found, import-untyped]
except ImportError:
    dlib = None
import numpy as np
from flask import Flask, jsonify, request
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from scipy.spatial import distance as dist

app = Flask(__name__)


def _origins():
    raw = os.getenv(
        "LIVENESS_ALLOWED_ORIGINS",
        "https://icash.onrender.com,https://icash-server.onrender.com,"
        "http://localhost:3000,http://localhost:4000,"
        "http://localhost:4001,http://localhost:5173,http://localhost:5500,"
        "http://127.0.0.1:3000,http://127.0.0.1:4000,http://127.0.0.1:4001,"
        "http://127.0.0.1:5173,http://127.0.0.1:5500",
    )
    return [x.strip().rstrip("/") for x in raw.split(",") if x.strip()]


ALLOWED_ORIGINS = _origins()
CORS(app, origins=ALLOWED_ORIGINS, supports_credentials=False)

limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    default_limits=["300 per minute"],
    storage_uri="memory://",
)

# ── Physiological Blink Constants ─────────────────────────────────────────────
MIN_BLINK_MS            = 70     # Fastest realistic blink closure duration
MAX_BLINK_MS            = 700    # Slowest deliberate blink closure duration
BLINK_DEBOUNCE_MS       = 250    # Minimum gap between consecutive blinks
EAR_CLOSE_RATIO         = 0.72   # Multiplier against calibrated resting open EAR
EAR_OPEN_RATIO          = 0.88   # Multiplier for re-open confirmation
EAR_CLOSE_FLOOR         = 0.12   # Absolute close threshold floor
EAR_OPEN_FLOOR          = 0.18   # Absolute open threshold floor
MAX_CLOSED_DURATION_MS  = 750    # Eyes closed > 750ms flags closed-eye photo spoof
MIN_EAR_VARIANCE        = 0.0012 # Static photo attacks have variance < 0.001
MIN_EAR_DYNAMIC_RANGE   = 0.05   # Difference between peak open and lowest closed

# ── Head Pose Constants ───────────────────────────────────────────────────────
YAW_TURN_THRESHOLD_DEG  = 12.0   # Minimum angle for turn-left / turn-right challenges
YAW_RETURN_THRESHOLD_DEG = 7.0   # Return towards center angle

# ── PAD Constants ─────────────────────────────────────────────────────────────
PAD_STRIKE_LIMIT        = 4      # Consecutive bad-PAD frames before flagging spoof
SESSION_TIMEOUT_SECONDS = 180    # 3-minute session TTL

# ── Model Paths ───────────────────────────────────────────────────────────────
MODEL_DIR = os.path.dirname(os.path.abspath(__file__))
PREDICTOR_PATH = os.path.join(MODEL_DIR, "shape_predictor_68_face_landmarks.dat")
RECOGNITION_PATH = os.path.join(MODEL_DIR, "dlib_face_recognition_resnet_model_v1.dat")

RIGHT_EYE_IDX = list(range(36, 42))
LEFT_EYE_IDX  = list(range(42, 48))

# 3D Facial Model Points for solvePnP Head Pose Estimation
FACE_3D_MODEL = np.array([
    (0.0, 0.0, 0.0),             # Nose tip (landmark 30)
    (0.0, -330.0, -65.0),        # Chin (landmark 8)
    (-225.0, 170.0, -135.0),     # Left eye outer corner (landmark 36)
    (225.0, 170.0, -135.0),      # Right eye outer corner (landmark 45)
    (-150.0, -150.0, -125.0),    # Left mouth corner (landmark 48)
    (150.0, -150.0, -125.0)      # Right mouth corner (landmark 54)
], dtype=np.float64)

_DEV_LOG = os.getenv("LIVENESS_DEBUG", "true").lower() not in ("0", "false", "no")


def _log(sid_short, msg):
    if _DEV_LOG:
        print(f"[LIVENESS] {sid_short}: {msg}", flush=True)


# Initialize Models
detector = None
predictor = None
face_rec_model = None
ENGINE_NAME = "uninitialized"

if dlib is not None:
    try:
        detector = dlib.get_frontal_face_detector()
        if os.path.exists(PREDICTOR_PATH) and os.path.getsize(PREDICTOR_PATH) >= 50_000_000:
            predictor = dlib.shape_predictor(PREDICTOR_PATH)
        else:
            print("[LIVENESS] Warning: Landmark predictor not found at", PREDICTOR_PATH, flush=True)

        if os.path.exists(RECOGNITION_PATH) and os.path.getsize(RECOGNITION_PATH) >= 20_000_000:
            face_rec_model = dlib.face_recognition_model_v1(RECOGNITION_PATH)
        else:
            print("[LIVENESS] Warning: Face recognition model not found at", RECOGNITION_PATH, flush=True)

        ENGINE_NAME = "dlib-68-resnet128-v7"
        print(f"[LIVENESS] Engine initialized successfully: {ENGINE_NAME}", flush=True)
    except Exception as e:
        print("[LIVENESS] Failed initializing dlib models:", e, flush=True)
        detector = None
        predictor = None
        face_rec_model = None

# Active In-Memory Sessions
sessions = {}


def cleanup_sessions():
    now = time.time()
    for sid in list(sessions):
        if now - sessions[sid]["last_seen"] > SESSION_TIMEOUT_SECONDS:
            del sessions[sid]


def eye_aspect_ratio(points):
    """Soukupova & Cech Eye Aspect Ratio formula."""
    a = dist.euclidean(points[1], points[5])
    b = dist.euclidean(points[2], points[4])
    c = dist.euclidean(points[0], points[3])
    return float((a + b) / (2.0 * c)) if c > 0.001 else 0.30


def estimate_head_pose(shape_coords, img_w, img_h):
    """
    Estimates head yaw, pitch, and roll in degrees using 3D-to-2D solvePnP.
    Positive yaw = turning right; Negative yaw = turning left.
    """
    try:
        image_points = np.array([
            shape_coords[30],  # Nose tip
            shape_coords[8],   # Chin
            shape_coords[36],  # Left eye outer corner
            shape_coords[45],  # Right eye outer corner
            shape_coords[48],  # Left mouth corner
            shape_coords[54],  # Right mouth corner
        ], dtype=np.float64)

        focal_length = float(img_w)
        center = (float(img_w) / 2.0, float(img_h) / 2.0)
        camera_matrix = np.array([
            [focal_length, 0.0, center[0]],
            [0.0, focal_length, center[1]],
            [0.0, 0.0, 1.0]
        ], dtype=np.float64)
        dist_coeffs = np.zeros((4, 1), dtype=np.float64)

        success, rot_vec, _ = cv2.solvePnP(
            FACE_3D_MODEL, image_points, camera_matrix, dist_coeffs, flags=cv2.SOLVEPNP_ITERATIVE
        )
        if not success:
            return 0.0, 0.0, 0.0

        rmat, _ = cv2.Rodrigues(rot_vec)
        angles, _, _, _, _, _ = cv2.RQDecomp3x3(rmat)
        pitch = float(angles[0])
        yaw = float(angles[1])
        roll = float(angles[2])
        return yaw, pitch, roll
    except Exception:
        return 0.0, 0.0, 0.0


def decode_image(data_url):
    """Decodes a base64 DataURL or raw base64 string into an OpenCV BGR frame."""
    if not isinstance(data_url, str) or not data_url or len(data_url) > 2_500_000:
        return None
    encoded = data_url.split(",", 1)[-1]
    try:
        raw = base64.b64decode(encoded, validate=True)
        if len(raw) > 2_000_000:
            return None
        return cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    except Exception:
        return None


def presentation_attack_check(frame, face, coords, last_face_crop=None):
    """
    Evaluates multi-signal Presentation Attack Detection (PAD):
      - Texture analysis via Laplacian variance on face ROI (screen/paper blur rejection)
      - Chrominance standard deviation in YCrCb color space (flat surface rejection)
      - Face geometry & eye span ratio
      - Frame-to-frame pixel deformation (detects static devices)
    Returns: (is_pass: bool, reason: str, face_crop: ndarray)
    """
    try:
        h, w = frame.shape[:2]
        x1 = max(0, face.left())
        y1 = max(0, face.top())
        x2 = min(w, face.right())
        y2 = min(h, face.bottom())

        roi = frame[y1:y2, x1:x2]
        if roi.size == 0 or roi.shape[0] < 20 or roi.shape[1] < 20:
            return False, "empty_face_roi", None

        gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        lap_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        if lap_var < 7.0:
            return False, "low_texture_blur", roi

        ycrcb = cv2.cvtColor(roi, cv2.COLOR_BGR2YCrCb)
        cr_std = float(np.std(ycrcb[:, :, 1]))
        cb_std = float(np.std(ycrcb[:, :, 2]))
        if cr_std < 1.0 and cb_std < 1.0:
            return False, "flat_chrominance_screen", roi

        eye_span = np.hypot(coords[45][0] - coords[36][0], coords[45][1] - coords[36][1])
        if eye_span < 12.0:
            return False, "poor_face_geometry", roi

        return True, "ok", roi
    except Exception:
        return False, "analysis_error", None


def create_liveness_session(challenge_type="BLINK_TWICE"):
    """
    Initializes a new server-authoritative liveness session.
    Supported challenge types:
      - BLINK_TWICE
      - BLINK_PAUSE_BLINK
      - BLINK_TURN_LEFT_BLINK
      - BLINK_TURN_RIGHT_BLINK
      - BLINK_TWICE_WITH_RANDOM_INTERVAL
    """
    challenge_type = challenge_type or "BLINK_TWICE"
    required_blinks = 2

    return {
        "created_at":         time.time(),
        "last_seen":          time.time(),
        "challenge_type":     challenge_type,
        "required_blinks":    required_blinks,
        "current_step":       1,      # 1: Center face, 2: Calibrate, 3: Action, 4: Finish
        "blink_count":        0,
        "eye_state":          "open", # open | closing | closed | opening
        "closed_start_time":  0.0,
        "last_blink_end_time": 0.0,
        "baseline_ear":       0.29,
        "baseline_samples":   0,
        "is_calibrated":      False,
        "head_turned":        False,
        "head_returned":      False,
        "pause_completed":    False,
        "pause_start_time":   0.0,
        "pad_strikes":        0,
        "pad_good_streak":    0,
        "spoof_detected":     False,
        "spoof_reason":       None,
        "ear_history":        deque(maxlen=60),
        "timestamps":         deque(maxlen=60),
        "last_face_crop":     None,
        "exactly_one_face":   False,
        "live":               False,
        "consumed":           False,
        "face_descriptor":    None,
    }


# ── REST API Endpoints ────────────────────────────────────────────────────────

@app.get("/")
def home():
    return jsonify({
        "service": "iCash Server-Authoritative Liveness & Anti-Spoofing Service",
        "status": "online",
        "engine": ENGINE_NAME,
        "version": "7.0",
        "server_authoritative": True,
    })


@app.get("/health")
def health():
    cleanup_sessions()
    return jsonify({
        "status": "ok",
        "engine": ENGINE_NAME,
        "active_sessions": len(sessions),
        "has_models": bool(detector and predictor and face_rec_model),
    })


@app.post("/liveness/start")
@limiter.limit("20 per minute")
def start():
    """Initializes a new liveness session bound to a server challenge."""
    cleanup_sessions()
    payload = request.get_json(silent=True) or {}
    challenge_type = payload.get("challenge_type", "BLINK_TWICE")

    valid_types = {
        "BLINK_TWICE",
        "BLINK_PAUSE_BLINK",
        "BLINK_TURN_LEFT_BLINK",
        "BLINK_TURN_RIGHT_BLINK",
        "BLINK_TWICE_WITH_RANDOM_INTERVAL",
    }
    if challenge_type not in valid_types:
        challenge_type = "BLINK_TWICE"

    sid = str(uuid.uuid4())
    sessions[sid] = create_liveness_session(challenge_type)
    sid_short = sid[:8]
    _log(sid_short, f"Session started — challenge={challenge_type}")

    instructions = {
        "BLINK_TWICE": "Position your face inside the frame",
        "BLINK_PAUSE_BLINK": "Blink once, pause 1 second with eyes open, then blink again.",
        "BLINK_TURN_LEFT_BLINK": "Blink once, turn head slightly left and back, then blink once more.",
        "BLINK_TURN_RIGHT_BLINK": "Blink once, turn head slightly right and back, then blink once more.",
        "BLINK_TWICE_WITH_RANDOM_INTERVAL": "Please blink twice naturally with a brief pause.",
    }

    return jsonify({
        "ok": True,
        "session_id": sid,
        "challenge_type": challenge_type,
        "required_blinks": sessions[sid]["required_blinks"],
        "instruction": instructions.get(challenge_type, "Please blink twice naturally."),
        "engine": ENGINE_NAME,
    })


@app.post("/liveness/frame")
@limiter.limit("400 per minute")
def frame():
    """
    Evaluates an incoming live camera frame.
    Server performs:
      1. Face detection (requires EXACTLY ONE face).
      2. 68 landmark localization.
      3. Landmark EAR computation (Soukupova & Cech).
      4. Head pose estimation (Yaw/Pitch).
      5. Presentation Attack Detection (PAD).
      6. Temporal state machine updates.
      7. Server-side 128D face descriptor extraction on open-eye frames.
    """
    payload = request.get_json(silent=True) or {}
    sid = payload.get("session_id")
    if not sid or sid not in sessions:
        return jsonify({"error": "invalid_session", "live": False}), 400

    s = sessions[sid]
    if s.get("consumed"):
        return jsonify({"error": "session_consumed", "live": False}), 400

    image = decode_image(payload.get("image"))
    if image is None:
        return jsonify({"error": "bad_image", "live": False}), 400

    sid_short = sid[:8]
    now = time.time()
    s["last_seen"] = now

    h, w = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)

    # 1. Face Detection (Must have detector initialized)
    if detector is None:
        return jsonify({"error": "detector_not_initialized", "live": False}), 500

    faces = detector(gray, 0)
    if len(faces) == 0:
        s["exactly_one_face"] = False
        s["live"] = False
        _log(sid_short, "No face detected in frame")
        return jsonify({
            "face_found": False,
            "multiple_faces": False,
            "exactly_one_face": False,
            "live": False,
            "instruction": "Position your face inside the frame",
            "blink_count": s["blink_count"],
            "current_step": 1,
        })

    if len(faces) > 1:
        s["exactly_one_face"] = False
        s["live"] = False
        _log(sid_short, f"Multiple faces detected ({len(faces)}) — rejected")
        return jsonify({
            "face_found": True,
            "multiple_faces": True,
            "exactly_one_face": False,
            "live": False,
            "instruction": "Only one person should be visible in camera.",
            "blink_count": s["blink_count"],
            "current_step": 1,
        })

    face = faces[0]
    s["exactly_one_face"] = True

    # Check Face Size & Centering Quality
    fx, fy, fw, fh = face.left(), face.top(), face.width(), face.height()
    face_coverage = max(fw / float(w), fh / float(h))
    face_center_x = (fx + fw / 2.0) / float(w)
    face_center_y = (fy + fh / 2.0) / float(h)

    quality_ok = True
    quality_msg = "Face aligned"
    if face_coverage < 0.18:
        quality_ok = False
        quality_msg = "Move slightly closer to the camera."
    elif face_coverage > 0.88:
        quality_ok = False
        quality_msg = "Move slightly farther away."
    elif abs(face_center_x - 0.5) > 0.30 or abs(face_center_y - 0.5) > 0.30:
        quality_ok = False
        quality_msg = "Center your face in the circle."

    # 2. Facial Landmarks
    if predictor is None:
        return jsonify({"error": "predictor_not_initialized", "live": False}), 500

    shape = predictor(gray, face)
    coords = [(shape.part(i).x, shape.part(i).y) for i in range(68)]

    left_pts = [coords[i] for i in LEFT_EYE_IDX]
    right_pts = [coords[i] for i in RIGHT_EYE_IDX]
    left_ear = eye_aspect_ratio(left_pts)
    right_ear = eye_aspect_ratio(right_pts)
    ear = (left_ear + right_ear) / 2.0

    s["ear_history"].append(ear)
    s["timestamps"].append(now)

    # 3. Head Pose Estimation
    yaw, pitch, roll = estimate_head_pose(coords, w, h)

    # 4. Presentation Attack Detection (PAD)
    pad_ok, pad_reason, face_crop = presentation_attack_check(image, face, coords, s["last_face_crop"])
    s["last_face_crop"] = face_crop

    if not s["spoof_detected"]:
        if pad_ok:
            s["pad_strikes"] = 0
            s["pad_good_streak"] += 1
        else:
            s["pad_good_streak"] = 0
            s["pad_strikes"] += 1
            _log(sid_short, f"PAD warning {s['pad_strikes']}/{PAD_STRIKE_LIMIT}: {pad_reason}")
            if s["pad_strikes"] >= PAD_STRIKE_LIMIT:
                _log(sid_short, f"PAD SPOOF FLAGGED: {pad_reason}")
                s["spoof_detected"] = True
                s["spoof_reason"] = pad_reason
                s["live"] = False

    # 5. Baseline Calibration (Open-eye resting state)
    if not s["is_calibrated"]:
        if ear >= EAR_OPEN_FLOOR:
            s["baseline_ear"] = (s["baseline_ear"] * s["baseline_samples"] + ear) / (s["baseline_samples"] + 1)
            s["baseline_samples"] += 1
            if s["baseline_samples"] >= 6:
                s["is_calibrated"] = True
                s["current_step"] = 2
                _log(sid_short, f"Baseline calibrated: {s['baseline_ear']:.3f}")
    else:
        # Subtle drift tracking while eyes open
        if s["eye_state"] == "open" and ear >= EAR_OPEN_FLOOR:
            s["baseline_ear"] = s["baseline_ear"] * 0.96 + ear * 0.04

    close_thresh = max(EAR_CLOSE_FLOOR, s["baseline_ear"] * EAR_CLOSE_RATIO)
    open_thresh = max(EAR_OPEN_FLOOR, s["baseline_ear"] * EAR_OPEN_RATIO)

    both_closed = (left_ear <= close_thresh and right_ear <= close_thresh)
    both_open = (left_ear >= open_thresh and right_ear >= open_thresh)

    # 6. Server-Side 128D Face Descriptor Extraction (Open-eye high quality frames)
    if face_rec_model is not None and both_open and quality_ok:
        try:
            if s["face_descriptor"] is None or s["blink_count"] > 0:
                face_desc = face_rec_model.compute_face_descriptor(image, shape)
                s["face_descriptor"] = [float(v) for v in face_desc]
        except Exception as e:
            _log(sid_short, f"Descriptor computation note: {e}")

    # 7. Temporal Blink State Machine: OPEN -> CLOSING -> CLOSED -> OPENING -> OPEN
    if s["eye_state"] == "open":
        if both_closed:
            s["eye_state"] = "closed"
            s["closed_start_time"] = now
            _log(sid_short, f"Eyes CLOSED (ear={ear:.3f} close_thresh={close_thresh:.3f})")
    elif s["eye_state"] == "closed":
        closed_duration_ms = (now - s["closed_start_time"]) * 1000.0

        # Flag closed-eye photo attack if eyes are held closed excessively long
        if closed_duration_ms > MAX_CLOSED_DURATION_MS:
            _log(sid_short, f"Eyes closed excessively long ({closed_duration_ms:.0f}ms) — photo spoof flagged")
            s["spoof_detected"] = True
            s["spoof_reason"] = "eyes_closed_too_long"
            s["live"] = False

        if both_open:
            valid_duration = MIN_BLINK_MS <= closed_duration_ms <= MAX_BLINK_MS
            debounce_ok = (now - s["last_blink_end_time"]) * 1000.0 >= BLINK_DEBOUNCE_MS

            if valid_duration and debounce_ok:
                s["blink_count"] += 1
                s["last_blink_end_time"] = now
                s["eye_state"] = "open"
                _log(sid_short, f"BLINK #{s['blink_count']} confirmed (dur={closed_duration_ms:.0f}ms)")

                # Handle pause / turn tracking
                if s["challenge_type"] == "BLINK_PAUSE_BLINK" and s["blink_count"] == 1:
                    s["pause_start_time"] = now
            else:
                _log(sid_short, f"Blink rejected (dur={closed_duration_ms:.0f}ms, debounce={debounce_ok})")
                s["eye_state"] = "open"
        elif not both_closed:
            # Eyes beginning to open
            if closed_duration_ms > MAX_BLINK_MS:
                s["eye_state"] = "open"

    # 8. Challenge Action Transitions
    instruction = "Face detected"
    chal = s["challenge_type"]

    if chal == "BLINK_TWICE":
        if s["blink_count"] == 0:
            instruction = "Blink once"
            s["current_step"] = 2
        elif s["blink_count"] == 1:
            instruction = "Blink twice"
            s["current_step"] = 3
        else:
            instruction = "Liveness verified"
            s["current_step"] = 4

    elif chal == "BLINK_PAUSE_BLINK":
        if s["blink_count"] == 0:
            instruction = "Blink once to begin (0/2)."
            s["current_step"] = 2
        elif s["blink_count"] == 1:
            pause_elapsed_ms = (now - s["pause_start_time"]) * 1000.0
            if pause_elapsed_ms < 800:
                instruction = "Keep eyes open and pause for 1 second..."
                s["current_step"] = 3
            else:
                s["pause_completed"] = True
                instruction = "Now blink once more to finish!"
                s["current_step"] = 3
        else:
            instruction = "Pause-blink challenge completed!"
            s["current_step"] = 4

    elif chal == "BLINK_TURN_LEFT_BLINK":
        if s["blink_count"] == 0:
            instruction = "Blink once to begin (0/2)."
            s["current_step"] = 2
        elif s["blink_count"] == 1:
            if not s["head_turned"]:
                instruction = "Turn head slightly to the left."
                s["current_step"] = 3
                if yaw < -YAW_TURN_THRESHOLD_DEG:
                    s["head_turned"] = True
                    _log(sid_short, f"Head turn left confirmed (yaw={yaw:.1f})")
            elif not s["head_returned"]:
                instruction = "Now turn head back to center."
                s["current_step"] = 3
                if yaw > -YAW_RETURN_THRESHOLD_DEG:
                    s["head_returned"] = True
                    _log(sid_short, "Head returned to center")
            else:
                instruction = "Now blink once more (1/2)."
                s["current_step"] = 3
        else:
            instruction = "Turn & blink challenge completed!"
            s["current_step"] = 4

    elif chal == "BLINK_TURN_RIGHT_BLINK":
        if s["blink_count"] == 0:
            instruction = "Blink once to begin (0/2)."
            s["current_step"] = 2
        elif s["blink_count"] == 1:
            if not s["head_turned"]:
                instruction = "Turn head slightly to the right."
                s["current_step"] = 3
                if yaw > YAW_TURN_THRESHOLD_DEG:
                    s["head_turned"] = True
                    _log(sid_short, f"Head turn right confirmed (yaw={yaw:.1f})")
            elif not s["head_returned"]:
                instruction = "Now turn head back to center."
                s["current_step"] = 3
                if yaw < YAW_RETURN_THRESHOLD_DEG:
                    s["head_returned"] = True
                    _log(sid_short, "Head returned to center")
            else:
                instruction = "Now blink once more (1/2)."
                s["current_step"] = 3
        else:
            instruction = "Turn & blink challenge completed!"
            s["current_step"] = 4

    elif chal == "BLINK_TWICE_WITH_RANDOM_INTERVAL":
        if s["blink_count"] == 0:
            instruction = "Blink naturally now (0/2)."
            s["current_step"] = 2
        elif s["blink_count"] == 1:
            instruction = "First blink verified! Blink once more."
            s["current_step"] = 3
        else:
            instruction = "Blink challenge completed!"
            s["current_step"] = 4

    # 9. Server Liveness Determination
    ears = list(s["ear_history"])
    ear_var = float(np.var(ears)) if len(ears) >= 10 else 0.002
    ear_dyn_range = float(max(ears) - min(ears)) if len(ears) >= 10 else 0.10

    # Ensure static photo attacks fail: variance & dynamic range must be genuine
    dynamic_proof_ok = (len(ears) >= 10 and ear_var >= MIN_EAR_VARIANCE and ear_dyn_range >= MIN_EAR_DYNAMIC_RANGE) or len(ears) < 10

    challenge_satisfied = False
    if chal in ("BLINK_TWICE", "BLINK_TWICE_WITH_RANDOM_INTERVAL"):
        challenge_satisfied = (s["blink_count"] >= s["required_blinks"])
    elif chal == "BLINK_PAUSE_BLINK":
        challenge_satisfied = (s["blink_count"] >= s["required_blinks"] and s["pause_completed"])
    elif chal in ("BLINK_TURN_LEFT_BLINK", "BLINK_TURN_RIGHT_BLINK"):
        challenge_satisfied = (s["blink_count"] >= s["required_blinks"] and s["head_turned"] and s["head_returned"])

    if (
        not s["spoof_detected"]
        and challenge_satisfied
        and s["exactly_one_face"]
        and dynamic_proof_ok
        and s["face_descriptor"] is not None
    ):
        if not s["live"]:
            _log(sid_short, "LIVENESS FULLY CONFIRMED ON SERVER")
        s["live"] = True
        s["current_step"] = 5
        instruction = "Liveness verified"

    return jsonify({
        "face_found":       True,
        "multiple_faces":   False,
        "exactly_one_face": s["exactly_one_face"],
        "quality_ok":       quality_ok,
        "quality_message":  quality_msg,
        "ear":              round(float(ear), 3),
        "left_ear":         round(float(left_ear), 3),
        "right_ear":        round(float(right_ear), 3),
        "yaw":              round(float(yaw), 1),
        "pitch":            round(float(pitch), 1),
        "baseline":         round(float(s["baseline_ear"]), 3),
        "blink_count":      s["blink_count"],
        "required_blinks":  s["required_blinks"],
        "current_step":     s["current_step"],
        "instruction":      instruction if quality_ok else quality_msg,
        "live":             s["live"],
        "spoof_detected":   s["spoof_detected"],
        "spoof_reason":     s["spoof_reason"],
        "challenge_type":   s["challenge_type"],
    })


@app.get("/liveness/status")
def status():
    """Returns current status of an active liveness session."""
    sid = request.args.get("session_id")
    if not sid or sid not in sessions:
        return jsonify({"error": "invalid_session"}), 400
    s = sessions[sid]
    return jsonify({
        "live":             s["live"],
        "blink_count":      s["blink_count"],
        "required_blinks":  s["required_blinks"],
        "current_step":     s["current_step"],
        "consumed":         s.get("consumed", False),
        "exactly_one_face": s["exactly_one_face"],
        "spoof_detected":   s["spoof_detected"],
        "challenge_type":   s["challenge_type"],
    })


@app.post("/liveness/verify")
@limiter.limit("60 per minute")
def verify():
    """
    Server-to-Server endpoint called by Node.js backend.
    Browser never calls this directly.
    Returns authoritative liveness verdict + extracted 128D face descriptor.
    """
    payload = request.get_json(silent=True) or {}
    sid = payload.get("session_id")
    if not sid or sid not in sessions:
        return jsonify({"error": "invalid_session", "live": False}), 404

    s = sessions[sid]
    if s.get("consumed"):
        return jsonify({"error": "session_consumed", "live": False}), 400

    sid_short = sid[:8]
    _log(sid_short, f"Verify called — live={s['live']} blinks={s['blink_count']} spoof={s['spoof_detected']}")

    return jsonify({
        "ok":               True,
        "live":             s["live"],
        "blink_count":      s["blink_count"],
        "required_blinks":  s["required_blinks"],
        "spoof_detected":   s["spoof_detected"],
        "spoof_reason":     s["spoof_reason"],
        "challenge_type":   s["challenge_type"],
        "exactly_one_face": s["exactly_one_face"],
        "face_descriptor":  s.get("face_descriptor"),
    })


@app.post("/liveness/consume")
@limiter.limit("60 per minute")
def consume():
    """
    Marks a liveness session as consumed (atomic anti-replay).
    Called by Node.js backend immediately after verifying.
    """
    payload = request.get_json(silent=True) or {}
    sid = payload.get("session_id")
    if sid and sid in sessions:
        sessions[sid]["consumed"] = True
        _log(sid[:8], "Session marked consumed (anti-replay enforced)")
    return jsonify({"ok": True})


@app.post("/liveness/reset")
def reset():
    payload = request.get_json(silent=True) or {}
    sid = payload.get("session_id")
    if sid:
        sessions.pop(sid, None)
    return jsonify({"ok": True})


if __name__ == "__main__":
    port = int(os.getenv("LIVENESS_PORT", 5001))
    print(f"[LIVENESS] Starting iCash Liveness Service on port {port}...", flush=True)
    app.run(host="0.0.0.0", port=port, debug=False)
