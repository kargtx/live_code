const clientId = crypto.randomUUID();
const roomInput = document.querySelector("#roomInput");
const roomForm = document.querySelector("#roomForm");
const copyLinkButton = document.querySelector("#copyLinkButton");
const presence = document.querySelector("#presence");
const codeEditor = document.querySelector("#codeEditor");
const runButton = document.querySelector("#runButton");
const runStatus = document.querySelector("#runStatus");
const outputBox = document.querySelector("#outputBox");
const canvas = document.querySelector("#drawCanvas");
const ctx = canvas.getContext("2d");
const toolButtons = [...document.querySelectorAll(".tool")];
const colorPicker = document.querySelector("#colorPicker");
const sizeSlider = document.querySelector("#sizeSlider");
const imageInput = document.querySelector("#imageInput");
const clearBoardButton = document.querySelector("#clearBoardButton");

let room = getInitialRoom();
let events = null;
let activeTool = "pen";
let isDrawing = false;
let lastPoint = null;
let suppressCodeSync = false;
let suppressCanvasSync = false;
let codeSyncTimer = null;
let canvasSyncTimer = null;

roomInput.value = room;
connect(room);
resizeCanvasToDisplay();
paintBlankCanvas();

window.addEventListener("resize", () => {
  const snapshot = canvas.toDataURL("image/png");
  resizeCanvasToDisplay();
  restoreCanvas(snapshot);
});

roomForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const nextRoom = normalizeRoom(roomInput.value);
  location.href = `${location.pathname}?room=${encodeURIComponent(nextRoom)}`;
});

copyLinkButton.addEventListener("click", async () => {
  const url = new URL(location.href);
  url.searchParams.set("room", room);
  await navigator.clipboard.writeText(url.toString());
  copyLinkButton.textContent = "Скопировано";
  setTimeout(() => {
    copyLinkButton.textContent = "Ссылка";
  }, 1200);
});

codeEditor.addEventListener("input", () => {
  if (suppressCodeSync) return;
  clearTimeout(codeSyncTimer);
  codeSyncTimer = setTimeout(() => {
    postJson("/api/sync", {
      room,
      clientId,
      type: "code",
      code: codeEditor.value
    });
  }, 180);
});

codeEditor.addEventListener("keydown", (event) => {
  if (event.key === "Tab") {
    event.preventDefault();
    const start = codeEditor.selectionStart;
    const end = codeEditor.selectionEnd;
    codeEditor.setRangeText("    ", start, end, "end");
    codeEditor.dispatchEvent(new Event("input"));
  }

  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    runPython();
  }
});

runButton.addEventListener("click", runPython);

toolButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activeTool = button.dataset.tool;
    toolButtons.forEach((item) => item.classList.toggle("active", item === button));
  });
});

canvas.addEventListener("pointerdown", (event) => {
  isDrawing = true;
  canvas.setPointerCapture(event.pointerId);
  lastPoint = getCanvasPoint(event);
  drawPoint(lastPoint);
});

canvas.addEventListener("pointermove", (event) => {
  if (!isDrawing || !lastPoint) return;
  const point = getCanvasPoint(event);
  drawLine(lastPoint, point);
  lastPoint = point;
});

canvas.addEventListener("pointerup", finishDrawing);
canvas.addEventListener("pointercancel", finishDrawing);
canvas.addEventListener("pointerleave", finishDrawing);

imageInput.addEventListener("change", () => {
  const file = imageInput.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      drawImageContained(img);
      syncCanvas();
      imageInput.value = "";
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

clearBoardButton.addEventListener("click", () => {
  paintBlankCanvas();
  syncCanvas();
});

function getInitialRoom() {
  const params = new URLSearchParams(location.search);
  return normalizeRoom(params.get("room") || randomRoomName());
}

function normalizeRoom(value) {
  return String(value || "main")
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "main";
}

function randomRoomName() {
  return `room-${Math.random().toString(36).slice(2, 8)}`;
}

function connect(roomName) {
  if (events) events.close();
  presence.textContent = "Connecting...";
  events = new EventSource(`/events?room=${encodeURIComponent(roomName)}&client=${clientId}`);

  events.addEventListener("init", (event) => {
    const state = JSON.parse(event.data);
    setRemoteCode(state.code);
    if (state.canvas) restoreCanvas(state.canvas);
    outputBox.textContent = state.output || "";
    presence.textContent = `${state.clients} участник(ов) в ${room}`;
  });

  events.addEventListener("presence", (event) => {
    const state = JSON.parse(event.data);
    presence.textContent = `${state.clients} участник(ов) в ${room}`;
  });

  events.addEventListener("code", (event) => {
    setRemoteCode(JSON.parse(event.data).code);
  });

  events.addEventListener("canvas", (event) => {
    const state = JSON.parse(event.data);
    if (state.canvas) restoreCanvas(state.canvas);
  });

  events.addEventListener("output", (event) => {
    const state = JSON.parse(event.data);
    outputBox.textContent = state.output || "";
    runButton.classList.toggle("running", Boolean(state.running));
    runStatus.textContent = state.running ? "Запуск..." : state.ok === false ? "Есть ошибки" : "Готово";
  });

  events.onerror = () => {
    presence.textContent = `Переподключение к ${room}...`;
  };
}

function setRemoteCode(code) {
  if (codeEditor.value === code) return;
  const start = codeEditor.selectionStart;
  const end = codeEditor.selectionEnd;
  suppressCodeSync = true;
  codeEditor.value = code || "";
  codeEditor.setSelectionRange(
    Math.min(start, codeEditor.value.length),
    Math.min(end, codeEditor.value.length)
  );
  suppressCodeSync = false;
}

async function runPython() {
  runButton.classList.add("running");
  runStatus.textContent = "Запуск...";
  outputBox.textContent = "Python выполняется...";
  try {
    const result = await postJson("/api/run", {
      room,
      code: codeEditor.value
    });
    outputBox.textContent = result.output || "";
    runStatus.textContent = result.ok ? "Готово" : "Есть ошибки";
  } catch (error) {
    outputBox.textContent = error.message;
    runStatus.textContent = "Ошибка запуска";
  } finally {
    runButton.classList.remove("running");
  }
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || data.output || "Request failed.");
  }
  return data;
}

function resizeCanvasToDisplay() {
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const width = Math.max(320, Math.floor(rect.width * scale));
  const height = Math.max(260, Math.floor(rect.height * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function paintBlankCanvas() {
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
}

function getCanvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height
  };
}

function drawPoint(point) {
  drawLine(point, point);
}

function drawLine(from, to) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = Number(sizeSlider.value) * (window.devicePixelRatio || 1);

  if (activeTool === "eraser") {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth *= 1.6;
  } else {
    ctx.strokeStyle = colorPicker.value;
  }

  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();

  scheduleCanvasSync();
}

function finishDrawing() {
  if (!isDrawing) return;
  isDrawing = false;
  lastPoint = null;
  syncCanvas();
}

function drawImageContained(img) {
  const padding = Math.min(canvas.width, canvas.height) * 0.07;
  const maxWidth = canvas.width - padding * 2;
  const maxHeight = canvas.height - padding * 2;
  const ratio = Math.min(maxWidth / img.width, maxHeight / img.height, 1);
  const width = img.width * ratio;
  const height = img.height * ratio;
  const x = (canvas.width - width) / 2;
  const y = (canvas.height - height) / 2;
  ctx.drawImage(img, x, y, width, height);
}

function scheduleCanvasSync() {
  if (suppressCanvasSync) return;
  clearTimeout(canvasSyncTimer);
  canvasSyncTimer = setTimeout(syncCanvas, 220);
}

function syncCanvas() {
  if (suppressCanvasSync) return;
  postJson("/api/sync", {
    room,
    clientId,
    type: "canvas",
    canvas: canvas.toDataURL("image/png")
  }).catch(() => {});
}

function restoreCanvas(dataUrl) {
  suppressCanvasSync = true;
  const img = new Image();
  img.onload = () => {
    paintBlankCanvas();
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    suppressCanvasSync = false;
  };
  img.onerror = () => {
    suppressCanvasSync = false;
  };
  img.src = dataUrl;
}
