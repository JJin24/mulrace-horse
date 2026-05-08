const socket = io({ transports: ["websocket"] });

const audienceStatus = document.querySelector("#audience-status");
const raceStatusEl = document.querySelector("#race-status");
const raceLapEl = document.querySelector("#race-lap");
const onlineAudienceEl = document.querySelector("#online-audience");
const horseList = document.querySelector("#horse-list");
const pollLive = document.querySelector("#poll-live");
const droneStreams = document.querySelector("#drone-streams");

const state = {
  horses: [],
  raceState: { status: "idle", lap: 0 },
  activePoll: null,
  drones: [],
  voted: {},
  droneImageMap: new Map()
};

function safeText(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function setAudienceStatus(text, ok = false) {
  audienceStatus.textContent = text;
  audienceStatus.style.color = ok ? "#34d399" : "#fbbf24";
}

function renderRace() {
  raceStatusEl.textContent = `狀態：${state.raceState.status}`;
  raceLapEl.textContent = `圈數：${state.raceState.lap}`;
}

function renderHorses() {
  if (state.horses.length === 0) {
    horseList.innerHTML = `<div class="muted">官方尚未設定馬匹。</div>`;
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
      </div>
    `
    )
    .join("");
}

function renderPoll() {
  if (!state.activePoll || state.activePoll.status !== "active") {
    pollLive.innerHTML = `<div class="muted">等待官方開啟投票...</div>`;
    return;
  }
  const poll = state.activePoll;
  const total = poll.options.reduce((sum, option) => sum + option.votes, 0);
  const votedKey = `${poll.id}:${socket.id}`;
  const voted = state.voted[votedKey] === true;

  pollLive.innerHTML = `
    <div><strong>${safeText(poll.question)}</strong></div>
    <div class="poll-options">
      ${poll.options
        .map((option) => {
          const ratio = total === 0 ? 0 : Math.round((option.votes / total) * 100);
          return `
            <div class="poll-option">
              <button data-vote-option="${option.option_key}" ${voted ? "disabled" : ""}>
                ${safeText(option.option_label)}
              </button>
              <div class="vote-bar"><span style="width:${ratio}%"></span></div>
              <div class="vote-count">${option.votes} 票 (${ratio}%)</div>
            </div>
          `;
        })
        .join("")}
    </div>
    <div class="muted" style="margin-top:8px">${voted ? "你已完成本輪投票。" : "請點選選項進行投票。"}</div>
  `;
}

function renderDroneStreams() {
  if (state.drones.length === 0) {
    droneStreams.innerHTML = `<div class="muted">等待雙機直播訊號...</div>`;
    state.droneImageMap.clear();
    return;
  }
  droneStreams.innerHTML = state.drones
    .slice(0, 2)
    .map(
      (drone) => `
      <article class="stream-card">
        <header>
          <strong>${safeText(drone.label)}</strong>
          <span class="stream-state" id="drone-state-${drone.id}">
            ${drone.online ? "在線" : "離線"}
          </span>
        </header>
        <img id="stream-${drone.id}" alt="${safeText(drone.label)} stream"/>
      </article>
    `
    )
    .join("");
  state.droneImageMap.clear();
  state.drones.slice(0, 2).forEach((drone) => {
    state.droneImageMap.set(drone.id, document.querySelector(`#stream-${CSS.escape(drone.id)}`));
  });
}

function renderSnapshot(snapshot) {
  state.horses = snapshot.horses || [];
  state.raceState = snapshot.raceState || state.raceState;
  state.activePoll = snapshot.activePoll || null;
  state.drones = snapshot.drones || [];
  onlineAudienceEl.textContent = `目前觀眾：${snapshot.audienceCount || 0}`;
  renderRace();
  renderHorses();
  renderPoll();
  renderDroneStreams();
}

pollLive.addEventListener("click", (event) => {
  const button = event.target.closest("[data-vote-option]");
  if (!button || !state.activePoll) {
    return;
  }
  socket.emit("poll:vote", {
    optionKey: button.dataset.voteOption
  });
});

socket.on("connect", () => {
  setAudienceStatus("已連線", true);
  socket.emit("audience:join");
});

socket.on("disconnect", () => {
  setAudienceStatus("連線中斷", false);
});

socket.on("state:snapshot", (snapshot) => {
  renderSnapshot(snapshot);
});

socket.on("horses:update", (horses) => {
  state.horses = horses || [];
  renderHorses();
});

socket.on("race:update", (raceState) => {
  state.raceState = raceState;
  renderRace();
});

socket.on("audience:count", (count) => {
  onlineAudienceEl.textContent = `目前觀眾：${count}`;
});

socket.on("drones:update", (drones) => {
  state.drones = drones || [];
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

socket.on("poll:update", (poll) => {
  state.activePoll = poll && poll.status === "active" ? poll : null;
  renderPoll();
});

socket.on("vote:accepted", ({ pollId }) => {
  state.voted[`${pollId}:${socket.id}`] = true;
  renderPoll();
});

socket.on("vote:rejected", ({ error }) => {
  setAudienceStatus(error || "投票失敗", false);
});
