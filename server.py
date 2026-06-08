from __future__ import annotations

import json
import mimetypes
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "3000"))
MAX_BODY_BYTES = 10_000_000
PYTHON_TIMEOUT_SECONDS = 10

rooms: dict[str, dict] = {}
rooms_lock = threading.RLock()


def normalize_room(room_id: str | None) -> str:
    value = (room_id or "main").strip()[:64]
    return value or "main"


def get_room(room_id: str | None) -> dict:
    safe_id = normalize_room(room_id)
    with rooms_lock:
        if safe_id not in rooms:
            rooms[safe_id] = {
                "code": "import math\n\nprint('Привет из Python!')\nprint(math.sqrt(144))\n",
                "canvas": None,
                "output": "Здесь появится вывод после запуска Python.",
                "clients": {},
            }
        return rooms[safe_id]


def json_bytes(payload: dict) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def broadcast(room_id: str, event: str, payload: dict, except_client_id: str | None = None) -> None:
    room = get_room(room_id)
    with rooms_lock:
        clients = list(room["clients"].items())

    for client_id, client_queue in clients:
        if client_id != except_client_id:
            client_queue.put((event, payload))


def run_python(code: str) -> dict:
    fd, tmp_name = tempfile.mkstemp(prefix="live-code-", suffix=".py")
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(code)

        completed = subprocess.run(
            [sys.executable, str(tmp_path)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=PYTHON_TIMEOUT_SECONDS,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
        )
        output = (completed.stdout or "") + (completed.stderr or "")
        return {
            "ok": completed.returncode == 0,
            "output": output.rstrip() or "(Python finished with no output.)",
        }
    except subprocess.TimeoutExpired as exc:
        output = ((exc.stdout or "") + (exc.stderr or "")).rstrip()
        return {
            "ok": False,
            "output": f"{output}\nProcess stopped after {PYTHON_TIMEOUT_SECONDS}s timeout.".strip(),
        }
    except Exception as exc:
        return {"ok": False, "output": f"Could not run Python:\n{exc}"}
    finally:
        try:
            tmp_path.unlink()
        except OSError:
            pass


class LiveCodeHandler(BaseHTTPRequestHandler):
    server_version = "LiveCodeRoom/1.0"

    def log_message(self, format: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {format % args}")

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/events":
            self.handle_events(parsed)
            return
        self.serve_static(parsed.path)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/sync":
            self.handle_sync()
            return
        if parsed.path == "/api/run":
            self.handle_run()
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "Not found."})

    def handle_events(self, parsed) -> None:
        params = parse_qs(parsed.query)
        room_id = normalize_room(params.get("room", ["main"])[0])
        client_id = params.get("client", [str(uuid.uuid4())])[0]
        client_queue: queue.Queue = queue.Queue()
        room = get_room(room_id)

        with rooms_lock:
            room["clients"][client_id] = client_queue
            clients_count = len(room["clients"])
            initial_state = {
                "code": room["code"],
                "canvas": room["canvas"],
                "output": room["output"],
                "clients": clients_count,
            }

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        self.write_event("init", initial_state)
        broadcast(room_id, "presence", {"clients": clients_count}, client_id)

        try:
            while True:
                try:
                    event, payload = client_queue.get(timeout=15)
                    self.write_event(event, payload)
                except queue.Empty:
                    self.wfile.write(b": keep-alive\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        finally:
            with rooms_lock:
                room["clients"].pop(client_id, None)
                clients_count = len(room["clients"])
            broadcast(room_id, "presence", {"clients": clients_count})

    def handle_sync(self) -> None:
        body = self.read_json_body()
        room_id = normalize_room(body.get("room"))
        client_id = body.get("clientId")
        room = get_room(room_id)

        if body.get("type") == "code":
            code = str(body.get("code", ""))
            with rooms_lock:
                room["code"] = code
            broadcast(room_id, "code", {"code": code}, client_id)
            self.send_json(HTTPStatus.OK, {"ok": True})
            return

        if body.get("type") == "canvas":
            canvas = body.get("canvas") if isinstance(body.get("canvas"), str) else None
            with rooms_lock:
                room["canvas"] = canvas
            broadcast(room_id, "canvas", {"canvas": canvas}, client_id)
            self.send_json(HTTPStatus.OK, {"ok": True})
            return

        self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Unknown sync type."})

    def handle_run(self) -> None:
        body = self.read_json_body()
        room_id = normalize_room(body.get("room"))
        code = str(body.get("code", ""))
        room = get_room(room_id)

        with rooms_lock:
            room["code"] = code
            room["output"] = "Running Python..."
        broadcast(room_id, "output", {"output": "Running Python...", "running": True})

        result = run_python(code)
        with rooms_lock:
            room["output"] = result["output"]
        broadcast(
            room_id,
            "output",
            {"output": result["output"], "running": False, "ok": result["ok"]},
        )
        self.send_json(HTTPStatus.OK, result)

    def serve_static(self, raw_path: str) -> None:
        relative = unquote(raw_path).lstrip("/") or "index.html"
        file_path = (PUBLIC_DIR / relative).resolve()

        if PUBLIC_DIR.resolve() not in file_path.parents and file_path != PUBLIC_DIR.resolve():
            self.send_error(HTTPStatus.FORBIDDEN)
            return

        if not file_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        content = file_path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length > MAX_BODY_BYTES:
            self.send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"ok": False, "error": "Body is too large."})
            raise ValueError("Body is too large.")
        raw = self.rfile.read(length)
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "Invalid JSON."})
            raise ValueError("Invalid JSON.") from exc

    def send_json(self, status: HTTPStatus, payload: dict) -> None:
        content = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def write_event(self, event: str, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False)
        self.wfile.write(f"event: {event}\n".encode("utf-8"))
        self.wfile.write(f"data: {data}\n\n".encode("utf-8"))
        self.wfile.flush()


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), LiveCodeHandler)
    print(f"Live Python Room работает на http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
