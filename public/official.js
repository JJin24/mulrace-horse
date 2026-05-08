const socket = io({ transports: ["websocket"] });

const officialStatus = document.querySelector("#official-status");
const audienceCountEl = document.querySelector("#audience-count");
const raceLapInput = document.querySelector("#race-lap");
const officialKeyInput = document.querySelector("#official-key");
const horseNumberInput = document.querySelector("#horse-number");
const horseNameInput = document.querySelector("#horse-name");
const horseColorInput = document.querySelector("#horse-color");
const horseList = document.querySelector("#horse-list");
const pollLive = document.querySelector("#poll-live");
const pollQuestionInput = document.querySelector("#poll-question");
const pollOptionsInput = document.querySelector("#poll-options");
const droneSelect = document.querySelector("#drone-id");
const droneStreams = document.querySelector("#drone-streams");
const gamepadStatus = document.querySelector("#gamepad-status");

const state = {
  authed: false,
  horses: [],
  raceState: { status: "idle", lap: 0 },
  activePoll: null,
  drones: [],
  droneImageMap: new Map(),
  gamepadLoop: null,
  gamepadPrevButtons: {},
  rcLastSentAt: 0,
  rcPrevious: { lr: 0, fb: 0, ud: 0, yaw: 0 }
};

function setStatus(message, ok = false) {
  officialStatus.textContent = message;
  officialStatus.style.color = ok ? "#34d399" : "#fbbf24";
}

function safeText(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function fetchState() {
  const response = await fetch("/api/state");
  if (!response.ok) {
    throw new Error("無法取得伺服器狀態");
  }
  return response.json();
}

function renderHorses() {
  if (state.horses.length === 0) {
    horseList.innerHTML = `<div class="muted">尚未設定馬匹。</div>`;
    return;
  }
  horseList.innerHTML = state.horses
    .map(
      (horse) => `
        <div class="list-item">
          <div class="meta">
            <span class="dot" style="background:${horse.color}"></span>
            <strong>#${horse.number}</strong>
            <span>${safeText(horse.name)}</span>
          </div>
          <button class="danger" data-remove-horse="${horse.id}" style="width:auto;padding:6px 10px;">刪除</button>
        </div>
      `
    )
    .join("");
}

function renderPoll() {
  if (!state.activePoll) {
    pollLive.innerHTML = `<div class="muted">目前沒有進行中的投票。</div>`;
    return;
  }
  const total = state.activePoll.options.reduce((sum, option) => sum + option.votes, 0);
  pollLive.innerHTML = `
    <div><strong>${safeText(state.activePoll.question)}</strong></div>
    <div class="poll-options">
      ${state.activePoll.options
        .map((option) => {
          const ratio = total === 0 ? 0 : Math.round((option.votes / total) * 100);
          return `
            <div class="poll-option">
              <button class="secondary" disabled>${safeText(option.option_label)}</button>
              <div class="vote-bar"><span style="width:${ratio}%"></span></div>
              <div class="vote-count">${option.votes} 票 (${ratio}%)</div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderRace() {
  raceLapInput.value = state.raceState.lap;
}

function renderDroneSelector() {
  const selected = droneSelect.value;
  if (state.drones.length === 0) {
    droneSelect.innerHTML = `<option value="">暫無可用無人機</option>`;
    return;
  }
  droneSelect.innerHTML = state.drones
    .map((drone) => `<option value="${drone.id}">${safeText(drone.label)} (${drone.id})</option>`)
    .join("");
  if (selected) {
    droneSelect.value = selected;
  }
}

function renderDroneStreams() {
  if (state.drones.length === 0) {
    droneStreams.innerHTML = `<div class="muted">等待 Tello Bridge 註冊雙機...</div>`;
    state.droneImageMap.clear();
    return;
  }
  droneStreams.innerHTML = state.drones
    .map(
      (drone) => `
        <article class="stream-card">
          <header>
            <strong>${safeText(drone.label)}</strong>
            <span class="stream-state" id="drone-state-${drone.id}">${drone.online ? "在線" : "離線"}</span>
          </header>
          <img id="stream-${drone.id}" alt="${safeText(drone.label)} stream" />
        </article>
      `
    )
    .join("");
  state.droneImageMap.clear();
  state.drones.forEach((drone) => {
    state.droneImageMap.set(drone.id, document.querySelector(`#stream-${CSS.escape(drone.id)}`));
  });
}

function renderSnapshot(snapshot) {
  state.horses = snapshot.horses || [];
  state.raceState = snapshot.raceState || state.raceState;
  state.activePoll = snapshot.activePoll || null;
  state.drones = snapshot.drones || [];
  audienceCountEl.textContent = `觀眾 ${snapshot.audienceCount || 0} 人`;
  renderHorses();
  renderRace();
  renderPoll();
  renderDroneSelector();
  renderDroneStreams();
}

async function refreshSnapshot() {
  const snapshot = await fetchState();
  renderSnapshot(snapshot);
}

async function createHorse() {
  const payload = {
    number: Number(horseNumberInput.value),
    name: horseNameInput.value,
    color: horseColorInput.value
  };
  const response = await fetch("/api/horses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || "建立馬匹失敗");
  }
  horseNumberInput.value = "";
  horseNameInput.value = "";
}

async function removeHorse(horseId) {
  const response = await fetch(`/api/horses/${horseId}`, {
    method: "DELETE"
  });
  if (!response.ok) {
    const result = await response.json();
    throw new Error(result.error || "刪除馬匹失敗");
  }
}

function sendDroneCommand(command, extra = {}) {
  if (!state.authed) {
    setStatus("請先登入官方權限", false);
    return;
  }
  const droneId = droneSelect.value;
  if (!droneId) {
    setStatus("請先選擇目標無人機", false);
    return;
  }
  socket.emit("drone:command", {
    droneId,
    command,
    ...extra
  });
}

function normalizeAxis(value) {
  if (Math.abs(value) < 0.12) {
    return 0;
  }
  return Math.max(-100, Math.min(100, Math.round(value * 100)));
}

function handleGamepadLoop() {
  if (!state.gamepadLoop) {
    return;
  }

  const gamepad = [...navigator.getGamepads()].find(Boolean);
  if (!gamepad) {
    gamepadStatus.textContent = "找不到手把，等待連線...";
    state.gamepadLoop = requestAnimationFrame(handleGamepadLoop);
    return;
  }

  gamepadStatus.textContent = `手把：${gamepad.id}`;

  const rc = {
    lr: normalizeAxis(gamepad.axes[0] || 0),
    fb: normalizeAxis(-(gamepad.axes[1] || 0)),
    ud: normalizeAxis(-(gamepad.axes[3] || 0)),
    yaw: normalizeAxis(gamepad.axes[2] || 0)
  };

  const changed =
    rc.lr !== state.rcPrevious.lr ||
    rc.fb !== state.rcPrevious.fb ||
    rc.ud !== state.rcPrevious.ud ||
    rc.yaw !== state.rcPrevious.yaw;

  const now = Date.now();
  if (changed || now - state.rcLastSentAt > 320) {
    sendDroneCommand("rc", rc);
    state.rcPrevious = rc;
    state.rcLastSentAt = now;
  }

  const buttons = gamepad.buttons || [];
  const takeoffPressed = buttons[0]?.pressed === true;
  const landPressed = buttons[1]?.pressed === true;

  if (takeoffPressed && !state.gamepadPrevButtons.takeoff) {
    sendDroneCommand("takeoff");
  }
  if (landPressed && !state.gamepadPrevButtons.land) {
    sendDroneCommand("land");
  }

  state.gamepadPrevButtons.takeoff = takeoffPressed;
  state.gamepadPrevButtons.land = landPressed;
  state.gamepadLoop = requestAnimationFrame(handleGamepadLoop);
}

function enableGamepad() {
  if (state.gamepadLoop) {
    return;
  }
  state.gamepadLoop = requestAnimationFrame(handleGamepadLoop);
}

function disableGamepad() {
  if (!state.gamepadLoop) {
    return;
  }
  cancelAnimationFrame(state.gamepadLoop);
  state.gamepadLoop = null;
  state.gamepadPrevButtons = {};
  state.rcPrevious = { lr: 0, fb: 0, ud: 0, yaw: 0 };
  sendDroneCommand("rc", { lr: 0, fb: 0, ud: 0, yaw: 0 });
  gamepadStatus.textContent = "手把未啟用";
}

document.querySelector("#official-login").addEventListener("click", () => {
  socket.emit("official:auth", { accessKey: officialKeyInput.value });
});

document.querySelector("#refresh-state").addEventListener("click", async () => {
  try {
    await refreshSnapshot();
  } catch (error) {
    setStatus(error.message, false);
  }
});

document.querySelector("#save-horse").addEventListener("click", async () => {
  try {
    await createHorse();
    await refreshSnapshot();
  } catch (error) {
    setStatus(error.message, false);
  }
});

horseList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-remove-horse]");
  if (!button) {
    return;
  }
  try {
    await removeHorse(button.dataset.removeHorse);
    await refreshSnapshot();
  } catch (error) {
    setStatus(error.message, false);
  }
});

document.querySelectorAll("[data-race-status]").forEach((button) => {
  button.addEventListener("click", () => {
    socket.emit("race:update", {
      status: button.dataset.raceStatus,
      lap: Number(raceLapInput.value || 0)
    });
  });
});

document.querySelector("#create-poll").addEventListener("click", () => {
  const question = pollQuestionInput.value.trim();
  const options = pollOptionsInput.value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  socket.emit("poll:create", { question, options });
});

document.querySelector("#close-poll").addEventListener("click", () => {
  socket.emit("poll:close");
});

document.querySelectorAll("[data-drone-command]").forEach((button) => {
  button.addEventListener("click", () => {
    sendDroneCommand(button.dataset.droneCommand);
  });
});

document.querySelector("#enable-gamepad").addEventListener("click", enableGamepad);
document.querySelector("#disable-gamepad").addEventListener("click", disableGamepad);

socket.on("connect", () => {
  setStatus("Socket 已連線，待官方認證", false);
});

socket.on("disconnect", () => {
  state.authed = false;
  setStatus("Socket 已離線", false);
});

socket.on("official:auth:result", async (payload) => {
  if (!payload.ok) {
    state.authed = false;
    setStatus(payload.error || "登入失敗", false);
    return;
  }
  state.authed = true;
  setStatus("官方權限已啟用", true);
  await refreshSnapshot();
});

socket.on("state:snapshot", (snapshot) => {
  renderSnapshot(snapshot);
});

socket.on("horses:update", (horses) => {
  state.horses = horses;
  renderHorses();
});

socket.on("audience:count", (count) => {
  audienceCountEl.textContent = `觀眾 ${count} 人`;
});

socket.on("race:update", (raceState) => {
  state.raceState = raceState;
  renderRace();
});

socket.on("poll:update", (poll) => {
  state.activePoll = poll && poll.status === "active" ? poll : null;
  renderPoll();
});

socket.on("poll:error", (payload) => {
  setStatus(payload.error || "投票操作失敗", false);
});

socket.on("drones:update", (drones) => {
  state.drones = drones;
  renderDroneSelector();
  renderDroneStreams();
});

socket.on("drone:state", ({ droneId, state: droneState }) => {
  const target = document.querySelector(`#drone-state-${CSS.escape(droneId)}`);
  if (target) {
    const battery = droneState?.battery ?? "--";
    target.textContent = `電量 ${battery}%`;
  }
});

socket.on("stream:frame", ({ droneId, frame }) => {
  const image = state.droneImageMap.get(droneId);
  if (!image) {
    return;
  }
  image.src = `data:image/jpeg;base64,${frame}`;
});

refreshSnapshot().catch(() => {
  setStatus("等待伺服器啟動...", false);
});
