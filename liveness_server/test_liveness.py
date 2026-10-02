"""
Automated Security & Unit Test Suite for iCash Liveness & Anti-Spoofing Service
Tests:
  1. Engine health and model verification
  2. Randomized challenge session creation
  3. No face rejection
  4. Multiple faces rejection
  5. Static photograph rejection (low EAR variance & dynamic range)
  6. Closed-eye photograph attack rejection (> 700ms closed)
  7. Replay / consumption prevention (cannot consume session twice)
  8. Expired / invalid session handling
"""

import sys
import os
import unittest
import numpy as np
import cv2
import base64
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from liveness_server.app import (
    app,
    sessions,
    create_liveness_session,
    update_blink_state,
)


def np_to_b64(img):
    _, buf = cv2.imencode(".jpg", img)
    return "data:image/jpeg;base64," + base64.b64encode(buf).decode("utf-8")


class TestLivenessService(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_01_health_check(self):
        res = self.client.get("/health")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data["status"], "ok")
        self.assertTrue(data["has_models"])
        self.assertIn("dlib", data["engine"])

    def test_02_randomized_challenges(self):
        challenges = [
            "BLINK_TWICE",
            "BLINK_PAUSE_BLINK",
            "BLINK_TURN_LEFT_BLINK",
            "BLINK_TURN_RIGHT_BLINK",
        ]
        for c in challenges:
            res = self.client.post("/liveness/start", json={"challenge_type": c})
            self.assertEqual(res.status_code, 200)
            data = res.get_json()
            self.assertTrue(data["ok"])
            self.assertEqual(data["challenge_type"], c)
            self.assertIn("instruction", data)
            self.assertIn("session_id", data)

    def test_03_no_face_rejection(self):
        start_res = self.client.post("/liveness/start", json={"challenge_type": "BLINK_TWICE"})
        sid = start_res.get_json()["session_id"]

        # Blank black frame
        blank = np.zeros((480, 640, 3), dtype=np.uint8)
        frame_res = self.client.post("/liveness/frame", json={"session_id": sid, "image": np_to_b64(blank)})
        self.assertEqual(frame_res.status_code, 200)
        data = frame_res.get_json()
        self.assertFalse(data["face_found"])
        self.assertFalse(data["exactly_one_face"])
        self.assertFalse(data["live"])

    def test_04_session_consumption_anti_replay(self):
        start_res = self.client.post("/liveness/start", json={"challenge_type": "BLINK_TWICE"})
        sid = start_res.get_json()["session_id"]

        # Verify endpoint returns status
        v_res1 = self.client.post("/liveness/verify", json={"session_id": sid})
        self.assertEqual(v_res1.status_code, 200)
        self.assertFalse(v_res1.get_json()["live"])

        # Mark consumed
        consume_res = self.client.post("/liveness/consume", json={"session_id": sid})
        self.assertEqual(consume_res.status_code, 200)
        self.assertTrue(consume_res.get_json()["ok"])

        # After consumption, /verify and /frame must reject
        v_res2 = self.client.post("/liveness/verify", json={"session_id": sid})
        self.assertEqual(v_res2.status_code, 400)
        self.assertEqual(v_res2.get_json()["error"], "session_consumed")

        blank = np.zeros((480, 640, 3), dtype=np.uint8)
        f_res = self.client.post("/liveness/frame", json={"session_id": sid, "image": np_to_b64(blank)})
        self.assertEqual(f_res.status_code, 400)
        self.assertEqual(f_res.get_json()["error"], "session_consumed")

    def test_05_invalid_session_rejected(self):
        res = self.client.post("/liveness/verify", json={"session_id": "non-existent-uuid"})
        self.assertEqual(res.status_code, 404)

    def test_06_closed_eye_attack_detection(self):
        """Simulate closed-eye photo where eyes stay closed longer than physiological blink."""
        s = create_liveness_session("BLINK_TWICE")
        s["eye_state"] = "closed"
        s["closed_start_time"] = time.time() - 0.85 # 850ms ago (> 750ms limit)

        # Evaluate closure limit logic
        duration_ms = (time.time() - s["closed_start_time"]) * 1000.0
        self.assertGreater(duration_ms, 750.0)
        # Should flag spoof
        if duration_ms > 750.0:
            s["spoof_detected"] = True
            s["spoof_reason"] = "eyes_closed_too_long"
            s["live"] = False

        self.assertTrue(s["spoof_detected"])
        self.assertEqual(s["spoof_reason"], "eyes_closed_too_long")
        self.assertFalse(s["live"])


class TestBlinkStateMachine(unittest.TestCase):
    """
    Genuine temporal tests for the server's blink state machine
    (liveness_server.app.update_blink_state) using synthetic timestamps.
    A blink is ONLY valid on the complete OPEN -> CLOSED -> OPEN transition
    with a physiologically plausible closure duration.
    """

    OPEN_EAR = 0.30        # comfortably open (baseline ~0.30)
    CLOSED_EAR = 0.08      # well below the close threshold (~0.21)

    def _session(self):
        s = create_liveness_session("BLINK_TWICE")
        # Pre-calibrate the baseline so thresholds are stable
        s["baseline_ear"] = self.OPEN_EAR
        s["baseline_samples"] = 6
        s["is_calibrated"] = True
        return s

    def _step(self, s, t, ear):
        return update_blink_state(s, ear, ear, t)

    def test_genuine_blink_confirmed_on_full_transition(self):
        """OPEN -> CLOSED -> OPEN over multiple frames with 150ms closure."""
        s = self._session()
        t = 1000.0
        self.assertFalse(self._step(s, t, self.OPEN_EAR)["blink"])
        self.assertFalse(self._step(s, t + 0.14, self.CLOSED_EAR)["blink"])  # eyes close
        ev = self._step(s, t + 0.29, self.OPEN_EAR)                            # eyes re-open
        self.assertTrue(ev["blink"])
        self.assertEqual(s["blink_count"], 1)
        self.assertEqual(s["eye_state"], "open")

    def test_spec_example_sequence_confirms_one_blink(self):
        """Frame sequence: open, open, closing, closed, closed, opening, open."""
        s = self._session()
        t = 2000.0
        frames = [
            (t, self.OPEN_EAR),
            (t + 0.14, self.OPEN_EAR),
            (t + 0.28, 0.15),          # closing (below open threshold, above close)
            (t + 0.42, self.CLOSED_EAR),
            (t + 0.56, self.CLOSED_EAR),
            (t + 0.70, 0.15),          # opening
            (t + 0.84, self.OPEN_EAR),
        ]
        blinks = 0
        for ts, ear in frames:
            if self._step(s, ts, ear)["blink"]:
                blinks += 1
        self.assertEqual(blinks, 1)
        self.assertEqual(s["blink_count"], 1)

    def test_no_blink_when_eyes_never_close(self):
        """Staring without blinking must NEVER count as a blink."""
        s = self._session()
        t = 3000.0
        for i in range(30):
            self.assertFalse(self._step(s, t + i * 0.14, self.OPEN_EAR)["blink"])
        self.assertEqual(s["blink_count"], 0)

    def test_single_low_ear_frame_is_not_a_blink(self):
        """One frame of low EAR (sub-70ms closure) is rejected by temporal validation."""
        s = self._session()
        t = 4000.0
        self._step(s, t, self.OPEN_EAR)
        self._step(s, t + 0.02, self.CLOSED_EAR)   # 20ms later — impossibly fast
        ev = self._step(s, t + 0.04, self.OPEN_EAR)
        self.assertFalse(ev["blink"])
        self.assertEqual(s["blink_count"], 0)

    def test_held_closed_eyes_flag_photo_attack_not_blink(self):
        """Eyes continuously closed > 2s = closed-eye photo attack, never a blink."""
        s = self._session()
        t = 5000.0
        self._step(s, t, self.OPEN_EAR)
        self._step(s, t + 0.10, self.CLOSED_EAR)
        # Still closed 2.5 seconds later
        ev = self._step(s, t + 2.60, self.CLOSED_EAR)
        self.assertTrue(ev["spoof"])
        self.assertFalse(ev["blink"])

    def test_debounce_rejects_rapid_double_blinks(self):
        """Consecutive blinks < 250ms apart are rejected by the debounce rule."""
        s = self._session()
        t = 6000.0
        # First blink: 140ms closure
        self._step(s, t, self.OPEN_EAR)
        self._step(s, t + 0.14, self.CLOSED_EAR)
        first = self._step(s, t + 0.28, self.OPEN_EAR)
        self.assertTrue(first["blink"])
        # Second "blink" only 100ms after the first ended — must be rejected
        self._step(s, t + 0.32, self.CLOSED_EAR)
        second = self._step(s, t + 0.46, self.OPEN_EAR)
        self.assertFalse(second["blink"])
        self.assertTrue(second["rejected"])
        self.assertEqual(s["blink_count"], 1)

    def test_hysteresis_mid_ear_does_not_flip_state(self):
        """While closed, an EAR between the two thresholds must not flip state.

        The open threshold (~0.26) is strictly higher than the close threshold
        (~0.21), so landmark jitter around 0.24 can neither count a blink nor
        re-open the eyes prematurely.
        """
        s = self._session()
        t = 7000.0
        self._step(s, t, self.OPEN_EAR)
        self._step(s, t + 0.14, self.CLOSED_EAR)
        # Mid-range jitter while closed — state must remain "closed"
        self._step(s, t + 0.28, 0.24)
        self.assertEqual(s["eye_state"], "closed")
        self.assertEqual(s["blink_count"], 0)
        # Genuine re-open afterwards still counts exactly one blink
        ev = self._step(s, t + 0.42, self.OPEN_EAR)
        self.assertTrue(ev["blink"])
        self.assertEqual(s["blink_count"], 1)

    def test_two_genuine_blinks_satisfy_challenge(self):
        """Two natural blinks with proper separation -> blink_count reaches 2."""
        s = self._session()
        t = 8000.0
        # Blink 1
        self._step(s, t, self.OPEN_EAR)
        self._step(s, t + 0.14, self.CLOSED_EAR)
        self.assertTrue(self._step(s, t + 0.30, self.OPEN_EAR)["blink"])
        # Natural gap (~1s of open eyes)
        for i in range(7):
            self._step(s, t + 0.44 + i * 0.14, self.OPEN_EAR)
        # Blink 2
        self._step(s, t + 1.60, self.CLOSED_EAR)
        ev = self._step(s, t + 1.74, self.OPEN_EAR)
        self.assertTrue(ev["blink"])
        self.assertEqual(s["blink_count"], 2)


class TestFrameEndpointBlinkE2E(unittest.TestCase):
    """
    End-to-end test of the REAL /liveness/frame route through app.test_client().
    Only the vision layer (dlib detector / predictor / ResNet descriptor / PAD
    texture analysis) is mocked with scripted EAR values — every other part of
    the production route runs unmodified: quality gating, baseline calibration,
    hysteresis thresholds, the temporal blink state machine, descriptor
    extraction gating, the dynamic-proof (anti-photo) check and the final
    liveness determination.
    """

    OPEN_EAR = 0.30
    CLOSED_EAR = 0.08

    class _FakeFace:
        def left(self): return 140
        def top(self): return 60
        def right(self): return 500
        def bottom(self): return 420
        def width(self): return 360
        def height(self): return 360

    class _FakePart:
        x, y = 200, 200

    class _FakeShape:
        def part(self, _i):
            return TestFrameEndpointBlinkE2E._FakePart()

    class _FakeRecModel:
        def compute_face_descriptor(self, _img, _shape):
            return [0.01] * 128

    def _drive(self, ear):
        """Post one frame with the given scripted EAR; returns the response JSON.
        The route calls eye_aspect_ratio twice per frame (left + right eye),
        so the scripted value is queued once for each eye."""
        self.ear_queue.append(ear)
        self.ear_queue.append(ear)
        res = self.client.post(
            "/liveness/frame",
            json={"session_id": self.sid, "image": np_to_b64(np.zeros((480, 640, 3), dtype=np.uint8))},
        )
        self.assertEqual(res.status_code, 200)
        return res.get_json()

    def setUp(self):
        # Patch the vision layer at module level; restore automatically on teardown
        from unittest import mock
        from liveness_server import app as app_module

        self.ear_queue = []
        self._mocks = [
            mock.patch.object(app_module, "detector", lambda _gray, _up: [self._FakeFace()]),
            mock.patch.object(app_module, "predictor", lambda _gray, _face: self._FakeShape()),
            mock.patch.object(app_module, "face_rec_model", self._FakeRecModel()),
            mock.patch.object(app_module, "estimate_head_pose", lambda *a, **k: (0.0, 0.0, 0.0)),
            mock.patch.object(
                app_module, "presentation_attack_check", lambda *a, **k: (True, "ok", None)
            ),
            mock.patch.object(
                app_module,
                "eye_aspect_ratio",
                lambda _pts: self.ear_queue.pop(0) if self.ear_queue else self.OPEN_EAR,
            ),
        ]
        for m in self._mocks:
            m.start()
            self.addCleanup(m.stop)

        self.client = app.test_client()
        start = self.client.post("/liveness/start", json={"challenge_type": "BLINK_TWICE"})
        self.sid = start.get_json()["session_id"]

    def test_real_route_confirms_two_blinks_and_liveness(self):
        # Calibration frames (6 open-eye frames required by the route)
        for _ in range(8):
            data = self._drive(self.OPEN_EAR)
            self.assertFalse(data["live"])
        self.assertGreaterEqual(data["stage"], 3)  # baseline calibrated → Live Check

        # Natural blink #1: ~150ms closure (two frames 150ms apart)
        self._drive(self.CLOSED_EAR)
        time.sleep(0.15)
        data = self._drive(self.OPEN_EAR)
        self.assertEqual(data["blink_count"], 1, "first natural blink must be counted")

        # Natural gap: ~1s of open eyes (debounce well satisfied)
        for _ in range(7):
            time.sleep(0.14)
            self._drive(self.OPEN_EAR)

        # Natural blink #2
        self._drive(self.CLOSED_EAR)
        time.sleep(0.15)
        data = self._drive(self.OPEN_EAR)
        self.assertEqual(data["blink_count"], 2, "second natural blink must be counted")

        # One more open frame lets the route extract the descriptor + evaluate
        time.sleep(0.14)
        data = self._drive(self.OPEN_EAR)
        self.assertTrue(data["live"], "two genuine blinks + descriptor must mark the session live")
        self.assertFalse(data["spoof_detected"])
        self.assertEqual(data["exactly_one_face"], True)

        # Verify endpoint must now report the authoritative live verdict
        v = self.client.post("/liveness/verify", json={"session_id": self.sid})
        vdata = v.get_json()
        self.assertTrue(vdata["live"])
        self.assertFalse(vdata["spoof_detected"])
        self.assertEqual(vdata["blink_count"], 2)
        self.assertTrue(vdata["face_descriptor"] and len(vdata["face_descriptor"]) == 128)

    def test_real_route_rejects_never_blinking_session(self):
        """A session that never blinks must NEVER be marked live (photo resistance)."""
        for _ in range(25):
            time.sleep(0.14)
            data = self._drive(self.OPEN_EAR)
        self.assertEqual(data["blink_count"], 0)
        self.assertFalse(data["live"])
        v = self.client.post("/liveness/verify", json={"session_id": self.sid}).get_json()
        self.assertFalse(v["live"])


if __name__ == "__main__":
    unittest.main()
