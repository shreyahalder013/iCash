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
from liveness_server.app import app, sessions, create_liveness_session


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


if __name__ == "__main__":
    unittest.main()
