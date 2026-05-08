import base64
import json
import os
import threading
import time
from dataclasses import dataclass
from typing import Dict, Optional

import cv2
import numpy as np
import socketio

try:
    from djitellopy import Tello
except ImportError:
    Tello = None


SERVER_URL = os.getenv("SERVER_URL", "http://localhost:3000")
BRIDGE_ACCESS_KEY = os.getenv("BRIDGE_ACCESS_KEY", "bridge-1234")
STREAM_FPS = max(1, int(os.getenv("STREAM_FPS", "12")))
JPEG_QUALITY = max(20, min(95, int(os.getenv("JPEG_QUALITY", "60"))))
SIMULATE_STREAM = os.getenv("SIMULATE_STREAM", "false").lower() == "true"

DEFAULT_DRONES = [
    {"id": "drone-1", "label": "Tello #1", "host": "192.168.10.1"},
    {"id": "drone-2", "label": "Tello #2", "host": "192.168.10.2"},
]


@dataclass
class DroneConfig:
    drone_id: str
    label: str
    host: str


class DroneWorker:
    def __init__(self, config: DroneConfig, sio: socketio.Client):
        self.config = config
        self.sio = sio
        self._stop_event = threading.Event()
        self._state_thread: Optional[threading.Thread] = None
        self._stream_thread: Optional[threading.Thread] = None
        self._tello = None

    def start(self):
        if SIMULATE_STREAM:
            self._stream_thread = threading.Thread(target=self._simulate_stream_loop, daemon=True)
            self._state_thread = threading.Thread(target=self._simulate_state_loop, daemon=True)
            self._stream_thread.start()
            self._state_thread.start()
            return

        if Tello is None:
            raise RuntimeError("djitellopy 尚未安裝，請先執行 pip install -r requirements.txt")

        self._tello = Tello(host=self.config.host)
        self._tello.connect(wait_for_state=True)
        self._tello.streamon()

        self._stream_thread = threading.Thread(target=self._tello_stream_loop, daemon=True)
        self._state_thread = threading.Thread(target=self._tello_state_loop, daemon=True)
        self._stream_thread.start()
        self._state_thread.start()

    def stop(self):
        self._stop_event.set()
        if self._tello is not None:
            try:
                self._tello.send_rc_control(0, 0, 0, 0)
                self._tello.streamoff()
                self._tello.end()
            except Exception:
                pass

    def execute_command(self, payload: dict):
        command = str(payload.get("command", "")).strip().lower()
        if not command:
            return

        if SIMULATE_STREAM:
            return

        if self._tello is None:
            return

        if command == "takeoff":
            self._tello.takeoff()
        elif command == "land":
            self._tello.land()
        elif command == "forward":
            self._tello.move_forward(20)
        elif command == "back":
            self._tello.move_back(20)
        elif command == "left":
            self._tello.move_left(20)
        elif command == "right":
            self._tello.move_right(20)
        elif command == "up":
            self._tello.move_up(20)
        elif command == "down":
            self._tello.move_down(20)
        elif command == "stop":
            self._tello.send_rc_control(0, 0, 0, 0)
        elif command == "rc":
            lr = int(payload.get("lr", 0))
            fb = int(payload.get("fb", 0))
            ud = int(payload.get("ud", 0))
            yaw = int(payload.get("yaw", 0))
            self._tello.send_rc_control(lr, fb, ud, yaw)

    def _encode_frame(self, frame):
        encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY]
        ok, buffer = cv2.imencode(".jpg", frame, encode_params)
        if not ok:
            return None
        return base64.b64encode(buffer.tobytes()).decode("ascii")

    def _emit_frame(self, frame_base64: str):
        self.sio.emit(
            "bridge:frame",
            {
                "droneId": self.config.drone_id,
                "frame": frame_base64,
                "timestamp": int(time.time() * 1000),
            },
        )

    def _emit_state(self, state_payload: dict):
        self.sio.emit(
            "bridge:state",
            {
                "droneId": self.config.drone_id,
                "state": state_payload,
            },
        )

    def _tello_stream_loop(self):
        frame_reader = self._tello.get_frame_read()
        interval = 1.0 / STREAM_FPS
        while not self._stop_event.is_set():
            frame = frame_reader.frame
            if frame is None:
                time.sleep(interval)
                continue
            encoded = self._encode_frame(frame)
            if encoded:
                self._emit_frame(encoded)
            time.sleep(interval)

    def _tello_state_loop(self):
        while not self._stop_event.is_set():
            payload = {
                "battery": self._tello.get_battery(),
                "height": self._tello.get_height(),
                "temperature": self._tello.get_temperature(),
            }
            self._emit_state(payload)
            time.sleep(1)

    def _simulate_stream_loop(self):
        interval = 1.0 / STREAM_FPS
        frame_count = 0
        while not self._stop_event.is_set():
            frame_count += 1
            frame = np.zeros((720, 1280, 3), dtype=np.uint8)
            color = (30, 200, 80) if self.config.drone_id.endswith("1") else (80, 120, 255)
            cv2.rectangle(frame, (0, 0), (1279, 719), color, 8)
            cv2.putText(
                frame,
                f"{self.config.label} ({self.config.drone_id})",
                (50, 120),
                cv2.FONT_HERSHEY_SIMPLEX,
                1.5,
                (255, 255, 255),
                3,
            )
            cv2.putText(
                frame,
                f"Sim Frame: {frame_count}",
                (50, 200),
                cv2.FONT_HERSHEY_SIMPLEX,
                1.2,
                (220, 220, 220),
                2,
            )
            encoded = self._encode_frame(frame)
            if encoded:
                self._emit_frame(encoded)
            time.sleep(interval)

    def _simulate_state_loop(self):
        battery = 100
        while not self._stop_event.is_set():
            battery = 20 if battery <= 21 else battery - 1
            self._emit_state(
                {
                    "battery": battery,
                    "height": 0,
                    "temperature": 35,
                }
            )
            time.sleep(1)


class BridgeClient:
    def __init__(self, drone_configs):
        self.sio = socketio.Client(reconnection=True, logger=False, engineio_logger=False)
        self.workers: Dict[str, DroneWorker] = {
            cfg.drone_id: DroneWorker(cfg, self.sio) for cfg in drone_configs
        }
        self._register_handlers()

    def _register_handlers(self):
        @self.sio.event
        def connect():
            print("Connected to server:", SERVER_URL)
            drones_payload = [
                {"id": worker.config.drone_id, "label": worker.config.label}
                for worker in self.workers.values()
            ]
            self.sio.emit(
                "bridge:register",
                {
                    "bridgeKey": BRIDGE_ACCESS_KEY,
                    "drones": drones_payload,
                },
            )

        @self.sio.event
        def disconnect():
            print("Disconnected from server")

        @self.sio.on("bridge:register:result")
        def on_register_result(payload):
            if payload.get("ok"):
                print("Bridge registered.")
            else:
                print("Bridge registration failed:", payload.get("error"))

        @self.sio.on("drone:command")
        def on_drone_command(payload):
            drone_id = str(payload.get("droneId", "")).strip()
            worker = self.workers.get(drone_id)
            if worker is None:
                return
            try:
                worker.execute_command(payload)
            except Exception as exc:
                print(f"Command error on {drone_id}: {exc}")

    def start(self):
        for worker in self.workers.values():
            worker.start()
        self.sio.connect(SERVER_URL, transports=["websocket"])
        self.sio.wait()

    def stop(self):
        for worker in self.workers.values():
            worker.stop()
        if self.sio.connected:
            self.sio.disconnect()


def parse_drone_configs():
    raw = os.getenv("TELLO_DRONES_JSON", "")
    if raw:
        configs = json.loads(raw)
    else:
        configs = DEFAULT_DRONES
    normalized = []
    for item in configs:
        drone_id = str(item.get("id", "")).strip()
        label = str(item.get("label", drone_id)).strip()
        host = str(item.get("host", "192.168.10.1")).strip()
        if not drone_id:
            continue
        normalized.append(DroneConfig(drone_id=drone_id, label=label or drone_id, host=host))
    if len(normalized) < 1:
        raise RuntimeError("需要至少一台無人機設定")
    return normalized


def main():
    bridge = BridgeClient(parse_drone_configs())
    try:
        bridge.start()
    except KeyboardInterrupt:
        print("Stopping bridge...")
    finally:
        bridge.stop()


if __name__ == "__main__":
    main()
