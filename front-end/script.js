// This file powers the main dashboard page. It renders the timer, progress bar, daily goal prompts, and the modal reminder pop-ups that appear when the extension detects fatigue, distraction, boredom, or a completed break.
const $ = (id) => document.getElementById(id);
const img = (src, cls = "asset-icon") =>
  `<img class="${cls}" alt="" aria-hidden="true" src="${src}">`;

// The session state is the current snapshot of the background worker. The page uses this object to render the timer, update progress, and decide which modal to show when the extension sends an alert.
const state = {
  session: null,
  syncNow: Date.now(),
  serverNow: Date.now(),
  modalKind: null,
};

const SOUND_SETTINGS_KEY = "focusSoundSettings";
const SOUND_LOCK_KEY = "focusToastAudioLocks";
const DEFAULT_SOUND_SETTINGS = { muted: false, volume: 50 };

async function getSoundSettings() {
  const result = await chrome.storage.local.get(SOUND_SETTINGS_KEY);
  return {
    ...DEFAULT_SOUND_SETTINGS,
    ...(result?.[SOUND_SETTINGS_KEY] || {}),
  };
}

async function saveSoundSettings(nextSettings) {
  const settings = {
    ...DEFAULT_SOUND_SETTINGS,
    ...nextSettings,
  };
  await chrome.storage.local.set({ [SOUND_SETTINGS_KEY]: settings });
  return settings;
}

async function markToastAudioHandled(eventId) {
  if (!eventId) return false;
  const result = await chrome.storage.local.get(SOUND_LOCK_KEY);
  const locks = result?.[SOUND_LOCK_KEY] || {};
  if (locks[eventId]) return false;
  locks[eventId] = Date.now();
  await chrome.storage.local.set({ [SOUND_LOCK_KEY]: locks });
  setTimeout(async () => {
    try {
      const current = await chrome.storage.local.get(SOUND_LOCK_KEY);
      const active = current?.[SOUND_LOCK_KEY] || {};
      delete active[eventId];
      await chrome.storage.local.set({ [SOUND_LOCK_KEY]: active });
    } catch (error) {
      console.warn("Failed to clear toast audio lock:", error);
    }
  }, 10000);
  return true;
}

function getToastSound(type, occurrenceCount = 1) {
  if (typeof globalThis.getToastSoundConfig === "function") {
    return globalThis.getToastSoundConfig(type, occurrenceCount);
  }
  return null;
}

async function maybePlayToastSound(payload) {
  if (!payload || !payload.eventId) return false;
  const sound = getToastSound(payload.kind, payload.count || 1);
  if (!sound) return false;
  const settings = await getSoundSettings();
  if (settings.muted || Number(settings.volume) <= 0) return false;
  const didLock = await markToastAudioHandled(payload.eventId);
  if (!didLock) return false;
  const audio = new Audio(sound.url);
  audio.volume = Math.min(1, Math.max(0, Number(settings.volume || 50) / 100));
  audio.preload = "auto";
  try {
    await audio.play();
  } catch (error) {
    console.warn("Toast sound blocked or unavailable:", error);
  }
  return true;
}

function getToastMessage(type, occurrenceCount = 1) {
  if (typeof globalThis.getToastContent === "function") {
    return globalThis.getToastContent(type, occurrenceCount);
  }
  return {
    title: "Feeling tired?",
    text: "Take a short break and refocus.",
    image: "judge.svg",
    buttons: [
      { label: "Keep studying", action: "keepStudying" },
      { label: "Take a break", action: "takeBreak" },
    ],
  };
}

function getToastButtonLabel(buttons, action, fallback) {
  return buttons.find((button) => button.action === action)?.label || fallback;
}

function getAlertButtonClass(kind, count = 1, action = "keepStudying") {
  const normalizedKind = String(kind || "").toLowerCase();
  const isKeepAction = action === "keepStudying" || action === "resumeStudy";
  const isTakeAction = action === "takeBreak" || action === "extendBreak";

  if (normalizedKind === "breakend") {
    return isKeepAction ? "split-btn ghost" : "split-btn solid";
  }

  if (normalizedKind === "distracted") {
    return isKeepAction ? "split-btn solid" : "split-btn ghost";
  }

  const isEvenOccurrence = Number(count) % 2 === 0;
  if (isKeepAction) {
    return isEvenOccurrence ? "split-btn ghost" : "split-btn solid";
  }
  if (isTakeAction) {
    return isEvenOccurrence ? "split-btn solid" : "split-btn ghost";
  }

  return "split-btn ghost";
}

function getToastImageUrl(imageName) {
  if (typeof globalThis.resolveToastImage === "function") {
    return globalThis.resolveToastImage(imageName);
  }
  return `cats/${imageName || "judge.svg"}`;
}

// Calculate the live elapsed time for the current study and break counters.
// This is needed because the background worker stores the session state but the dashboard must also show the time that is passing right now while the timer is active.
function secondsNowFromServer(session) {
  const offset = (Date.now() - state.syncNow) / 1000;
  const live =
    session.running && session.startedAt
      ? Math.max(
          0,
          (state.serverNow + offset * 1000 - session.startedAt) / 1000,
        )
      : 0;
  return {
    study:
      session.studySeconds +
      (session.running && session.mode === "study" ? live : 0),
    break:
      session.breakSeconds +
      (session.running && session.mode === "break" ? live : 0),
  };
}

function durationString(seconds) {
  const n = Math.max(0, Math.round(seconds));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function timeString(seconds) {
  const n = Math.max(0, Math.round(seconds));
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function escapeHtml(text) {
  return text.replace(
    /[&<>"']/g,
    (m) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        m
      ],
  );
}

// Render the dashboard using the latest session state. This function updates the timer ring, countdown text, progress bar, and labels for either study or break mode.
function render() {
  const session = state.session;
  if (!session) return;
  const live = secondsNowFromServer(session);
  const isBreak = session.mode === "break";
  const studyElapsed = live.study;
  const breakElapsed = live.break;
  const totalBreakSeconds = (session.completedBreaks || []).reduce(
    (sum, item) => sum + Number(item?.duration || 0),
    0,
  );
  const progress = isBreak
    ? Math.min(1, breakElapsed / Math.max(1, session.breakGoalSeconds))
    : Math.min(1, studyElapsed / Math.max(1, session.goalSeconds));

  const ringFill = isBreak
    ? "var(--ring-fill-break)"
    : "var(--ring-fill-study)";
  const trackColor = isBreak ? "#cfe3f5" : "#cfe3f5";
  const paleFill = isBreak ? "var(--pale-break)" : "var(--pale-study)";
  $("timer").style.setProperty("--ring-track", trackColor);
  $("timer").style.setProperty("--ring-fill", ringFill);
  $("timer").style.setProperty("--pale-fill", paleFill);
  $("timer").style.setProperty("--progress", (progress * 100).toFixed(2));
  $("timer").style.setProperty("--break-progress", isBreak ? 0 : 100);

  // CSS conic-gradient needs explicit, alternating stops. The old comma-separated segments were not a valid gradient and made the entire ring disappear.
  if (!isBreak && session.completedBreaks?.length) {
    const goal = Math.max(1, session.goalSeconds);
    const intervals = session.completedBreaks
      .map((item) => {
        const a = Math.max(
          0,
          Math.min(100, (Number(item.studyAt || 0) / goal) * 100),
        );
        const size = Math.min(
          2.5,
          Math.max(0.8, (Number(item.duration || 0) / goal) * 20),
        );
        return [a, Math.min(100, a + size)];
      })
      .filter(([a, b]) => b > a)
      .sort((a, b) => a[0] - b[0]);
    const stops = [];
    let cursor = 0;
    for (const [a, b] of intervals) {
      if (a > cursor)
        stops.push(`transparent ${cursor.toFixed(2)}% ${a.toFixed(2)}%`);
      stops.push(
        `#09447e ${Math.max(a, cursor).toFixed(2)}% ${Math.max(b, cursor).toFixed(2)}%`,
      );
      cursor = Math.max(cursor, b);
    }
    if (cursor < 100) stops.push(`transparent ${cursor.toFixed(2)}% 100%`);
    $("timer").style.setProperty(
      "--break-overlay",
      `conic-gradient(from -90deg, ${stops.join(", ")})`,
    );
    $("timer").classList.add("has-break-segments");
  } else {
    $("timer").style.setProperty("--break-overlay", "none");
    $("timer").classList.remove("has-break-segments");
  }

  if (isBreak) {
    const remaining = Math.max(0, session.breakGoalSeconds - breakElapsed);
    $("clock").textContent = timeString(remaining);
    $("goalLabel").textContent =
      `Break Time · ${timeString(session.breakGoalSeconds)}`;
    $("goalLabel").classList.remove("hidden");
    $("breakStatusLabel").textContent =
      `Break Countdown · ${timeString(session.breakGoalSeconds)}`;
    $("breakStatusLabel").classList.remove("hidden");
    $("timer").classList.add("break-mode");
  } else {
    $("clock").textContent = timeString(studyElapsed);
    $("goalLabel").textContent =
      `Study Goal · ${timeString(session.goalSeconds)}`;
    $("goalLabel").classList.toggle("hidden", !session.started);
    if (totalBreakSeconds > 0) {
      $("breakStatusLabel").textContent =
        `Break Counting · ${timeString(totalBreakSeconds)}`;
      $("breakStatusLabel").classList.remove("hidden");
    } else {
      $("breakStatusLabel").classList.add("hidden");
    }
    $("timer").classList.remove("break-mode");
  }

  $("timerBtn").disabled = !session.started || session.finished;
  $("timerBtn").setAttribute(
    "aria-disabled",
    String(!session.started || session.finished),
  );
  $("timerBtn").className =
    session.started && !session.finished ? "primary-btn" : "secondary-btn";
  $("timerBtnLabel").textContent = session.running
    ? "Take a break"
    : isBreak
      ? "Keep studying"
      : session.started
        ? "Keep studying"
        : "start";
  $("timerSymbol").textContent = session.running ? "Ⅱ" : "▶";

  const dailyGoal = session.dailyGoalSeconds || 0;
  const todayLive =
    session.todayStudiedSeconds +
    Math.max(0, studyElapsed - session.studySeconds);
  const dailyPercent = dailyGoal
    ? Math.min(100, Math.round((todayLive / dailyGoal) * 100))
    : 0;
  $("progressFill").style.width = `${dailyPercent}%`;
  $("percentText").textContent = `${dailyPercent}% complied`;
  $("dailyGoalInfo").textContent = dailyGoal
    ? `Daily goal: ${durationString(dailyGoal)} · Studied: ${durationString(todayLive)}`
    : `Daily goal not set yet`;
  $("progressDetail").textContent = isBreak
    ? `Break progress: ${timeString(breakElapsed)} / ${timeString(session.breakGoalSeconds)}`
    : `Session progress: ${timeString(studyElapsed)} / ${timeString(session.goalSeconds)}`;
}

// Celebrate when a study goal is finished. Confetti is created dynamically and then removed after a short timeout so it feels like a one-off completion moment.
function triggerTimerCelebration() {
  const host = document.getElementById("timerCelebration");
  const timer = document.getElementById("timer");
  if (!host || !timer) return;

  host.innerHTML = "";
  const colors = ["#df4195", "#5e9fd8", "#0a4d95", "#ffd166", "#ffffff"];
  const pieceCount = 26;

  for (let i = 0; i < pieceCount; i += 1) {
    const piece = document.createElement("span");
    const color = colors[i % colors.length];
    const drift = `${(Math.random() * 190 - 95).toFixed(0)}px`;
    const spin = `${(Math.random() * 720 - 360).toFixed(0)}deg`;
    const duration = `${(2.2 + Math.random() * 1.2).toFixed(2)}s`;
    const delay = `${(Math.random() * 0.2).toFixed(2)}s`;
    const width = `${(8 + Math.random() * 14).toFixed(0)}px`;
    const height = `${(18 + Math.random() * 26).toFixed(0)}px`;

    piece.className = "confetti-piece";
    piece.style.background = color;
    piece.style.left = `${20 + Math.random() * 60}%`;
    piece.style.width = width;
    piece.style.height = height;
    piece.style.setProperty("--drift", drift);
    piece.style.setProperty("--spin", spin);
    piece.style.setProperty("--duration", duration);
    piece.style.setProperty("--delay", delay);
    host.appendChild(piece);
  }

  timer.classList.remove("is-celebrating");
  void timer.offsetWidth;
  timer.classList.add("is-celebrating");
  window.clearTimeout(triggerTimerCelebration._timer);
  triggerTimerCelebration._timer = window.setTimeout(() => {
    timer.classList.remove("is-celebrating");
    host.innerHTML = "";
  }, 2600);
}

function tick() {
  if (state.session) render();
  requestAnimationFrame(tick);
}

async function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

// Pull the newest session snapshot from the extension and then update the UI.
// This keeps the main page in sync with the background identity after a reminder, break, or manual reset.
async function syncSession() {
  const res = await send("GET_SESSION");
  if (!res?.session) return;
  state.session = res.session;
  state.serverNow = res.serverNow;
  state.syncNow = Date.now();
  render();
  maybeOpenDailyGoal();
}

function showOverlay(html, kind) {
  state.modalKind = kind;
  $("modalHost").innerHTML = html;
  $("overlay").classList.remove("hidden");
}

function closeOverlay() {
  state.modalKind = null;
  $("overlay").classList.add("hidden");
  $("modalHost").innerHTML = "";
}

function dailyGoalMarkup() {
  const currentHours = state.session?.dailyGoalSeconds
    ? Math.max(1, Math.round(state.session.dailyGoalSeconds / 3600))
    : 4;
  const options = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12]
    .map(
      (h) =>
        `<option value="${h}" ${h === currentHours ? "selected" : ""}>${h} hour${h > 1 ? "s" : ""}</option>`,
    )
    .join("");
  return `
    <section class="modal daily-goal-modal">
      <div class="daily-goal-card">
        <div class="daily-goal-copy">
          <p class="eyebrow">Today's Progress</p>
          <h2>Set Your Daily Goal</h2>
          <p>How many hours would you like to study today?</p>
          <div class="daily-goal-controls">
            <select id="dailyGoalSelect">${options}</select>
            <button class="primary-btn" id="dailyGoalConfirm">Let's Go!</button>
          </div>
          <button class="text-link" id="dailyGoalSkip">Skip for now</button>
        </div>
        <div class="daily-goal-illustration">
          <img src="cats/default.svg" alt="Mascot" />
        </div>
      </div>
    </section>`;
}

function sessionGoalMarkup() {
  const mins = Math.max(
    5,
    Math.round((state.session?.goalSeconds || 3600) / 60),
  );
  return `
    <section class="modal goal-dialog">
      <h2>Set study goal</h2>
      <p>How long would you like to focus in this study session?</p>
      <div class="goal-entry">
        <input id="goalMinutes" type="number" min="5" max="240" step="5" value="${mins}">
        <label for="goalMinutes">minutes</label>
      </div>
      <p class="goal-error hidden" id="goalError">Please enter at least 5 minutes.</p>
      <div class="modal-buttons">
        <button class="secondary-outline" id="goalCancel">Cancel</button>
        <button class="primary-btn" id="goalConfirm">Start</button>
      </div>
    </section>`;
}

function alertMarkup(kind, count = 1, breakDuration = 300) {
  const content = getToastMessage(kind, count);
  const keepLabel = getToastButtonLabel(
    content.buttons,
    "keepStudying",
    "Keep studying",
  );
  const takeLabel = getToastButtonLabel(
    content.buttons,
    "takeBreak",
    "Take a break",
  );
  const imageUrl = getToastImageUrl(content.image);
  const keepClass = getAlertButtonClass(kind, count, "keepStudying");
  const takeClass = getAlertButtonClass(kind, count, "takeBreak");

  return `
    <section class="modal alert-modal large-alert" data-kind="${kind}" data-break="${breakDuration}">
      <div class="alert-cat-art"><img src="${imageUrl}" alt="Cat character"></div>
      <div class="alert-body wide">
        <h2 class="big-title">${escapeHtml(content.title)}</h2>
        <p class="big-text">${escapeHtml(content.text)}</p>
        <div class="split-actions">
          <button class="${keepClass}" id="keepStudyingBtn">${escapeHtml(keepLabel)}</button>
          <button class="${takeClass}" id="takeBreakBtn">${escapeHtml(takeLabel)}</button>
        </div>
      </div>
    </section>`;
}

function breakEndMarkup(count = 1) {
  const content = getToastMessage("breakEnd", count);
  const resumeLabel = getToastButtonLabel(
    content.buttons,
    "resumeStudy",
    "Keep studying",
  );
  const extendLabel = getToastButtonLabel(
    content.buttons,
    "extendBreak",
    "Take another break",
  );
  const imageUrl = getToastImageUrl(content.image);
  const resumeClass = getAlertButtonClass("breakEnd", count, "resumeStudy");
  const extendClass = getAlertButtonClass("breakEnd", count, "extendBreak");

  return `
    <section class="modal alert-modal large-alert" data-kind="breakEnd">
      <div class="alert-cat-art"><img src="${imageUrl}" alt="Cat character"></div>
      <div class="alert-body wide">
        <h2 class="big-title">${escapeHtml(content.title)}</h2>
        <p class="big-text">${escapeHtml(content.text)}</p>
        <div class="split-actions">
          <button class="${resumeClass}" id="resumeStudyBtn">${escapeHtml(resumeLabel)}</button>
          <button class="${extendClass}" id="extendBreakBtn">${escapeHtml(extendLabel)}</button>
        </div>
      </div>
    </section>`;
}

// If the user has not set a daily target yet, show the daily goal modal once.
// This prompt is intentionally only triggered when there is no existing goal set.
function maybeOpenDailyGoal() {
  if (state.modalKind) return;
  if (state.session && !state.session.dailyGoalSeconds) {
    showOverlay(dailyGoalMarkup(), "dailyGoal");
    $("dailyGoalConfirm").onclick = async () => {
      const hours = Number($("dailyGoalSelect").value) || 4;
      const res = await send("SET_DAILY_GOAL", {
        dailyGoalSeconds: hours * 3600,
      });
      state.session = res.session;
      state.serverNow = Date.now();
      state.syncNow = Date.now();
      closeOverlay();
      render();
    };
    $("dailyGoalSkip").onclick = () => closeOverlay();
  }
}

function openSessionGoal() {
  showOverlay(sessionGoalMarkup(), "sessionGoal");
  $("goalCancel").onclick = closeOverlay;
  $("goalConfirm").onclick = async () => {
    const mins = Number($("goalMinutes").value);
    if (!mins || mins < 5) {
      $("goalError").classList.remove("hidden");
      return;
    }
    const res = await send("START_SESSION", { goalSeconds: mins * 60 });
    state.session = res.session;
    state.serverNow = Date.now();
    state.syncNow = Date.now();
    maybePlayToastSound({
      kind: "studyStart",
      count: 1,
      eventId: `study-start-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
    }).catch(() => {});
    closeOverlay();
    render();
  };
}

async function openAlert(kind, count, breakDuration = 300, forced = false) {
  showOverlay(alertMarkup(kind, count, breakDuration), "alert");
  $("keepStudyingBtn").onclick = async () => {
    if (forced) {
      const res = await send("RESUME_STUDY");
      state.session = res.session;
      state.serverNow = Date.now();
      state.syncNow = Date.now();
    }
    closeOverlay();
  };
  $("takeBreakBtn").onclick = async () => {
    const res = await send("TAKE_BREAK", { breakDuration });
    state.session = res.session;
    state.serverNow = Date.now();
    state.syncNow = Date.now();
    closeOverlay();
  };
}

async function openBreakEnd(count) {
  showOverlay(breakEndMarkup(count), "breakEnd");
  maybePlayToastSound({
    kind: "breakEnd",
    count,
    eventId: `break-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
  $("resumeStudyBtn").onclick = async () => {
    const res = await send("RESUME_STUDY");
    state.session = res.session;
    state.serverNow = Date.now();
    state.syncNow = Date.now();
    closeOverlay();
  };
  $("extendBreakBtn").onclick = async () => {
    const res = await send("EXTEND_BREAK", { breakDuration: 300 });
    state.session = res.session;
    state.serverNow = Date.now();
    state.syncNow = Date.now();
    closeOverlay();
  };
}

// Bind the central dashboard controls: start/pause, reset, mute/volume, and the keyboard shortcuts that simulate user states from the study companion.
function bindBaseUI() {
  const muteBtn = $("muteBtn");
  const volumeInput = $("volume");

  async function applySoundUI(settings) {
    if (!muteBtn || !volumeInput) return;
    const muted = !!settings.muted;
    muteBtn.setAttribute("aria-pressed", String(muted));
    muteBtn.title = muted ? "Unmute alert sound" : "Mute alert sound";
    volumeInput.value = String(Number(settings.volume) || 0);
    volumeInput.disabled = false;
  }

  (async () => {
    const settings = await getSoundSettings();
    await applySoundUI(settings);
  })().catch(() => {});

  if (muteBtn) {
    muteBtn.addEventListener("click", async () => {
      const settings = await getSoundSettings();
      const next = { ...settings, muted: !settings.muted };
      await saveSoundSettings(next);
      await applySoundUI(next);
    });
  }

  if (volumeInput) {
    volumeInput.addEventListener("input", async (event) => {
      const next = {
        ...(await getSoundSettings()),
        volume: Number(event.target.value) || 0,
      };
      if (Number(next.volume) > 0) next.muted = false;
      await saveSoundSettings(next);
      await applySoundUI(next);
    });
  }

  $("timer").addEventListener("click", () => {
    if (state.session?.mode === "break") return;
    openSessionGoal();
  });
  $("timer").addEventListener("keydown", (e) => {
    if (
      (e.key === "Enter" || e.key === " ") &&
      state.session?.mode !== "break"
    ) {
      e.preventDefault();
      openSessionGoal();
    }
  });
  $("timerBtn").addEventListener("click", async () => {
    const res = await send("TOGGLE_SESSION");
    state.session = res.session;
    state.serverNow = Date.now();
    state.syncNow = Date.now();
    render();
  });
  $("progressToggle").addEventListener("click", () => {
    const collapsed = $("progressBody").classList.toggle("hidden");
    $("progressToggle").setAttribute("aria-expanded", String(!collapsed));
  });
  $("collapseBtn").addEventListener("click", () => {
    const collapsed = $("sidebar").classList.toggle("collapsed");
    document
      .querySelector(".app")
      .classList.toggle("sidebar-collapsed", collapsed);
    $("collapseBtn").setAttribute("aria-expanded", String(!collapsed));
  });
  $("resetBtn").addEventListener("click", async () => {
    if (
      !window.confirm(
        "Reset this study session? Your daily goal and today’s accumulated study time will be kept.",
      )
    )
      return;
    const res = await send("RESET_SESSION");
    if (res?.session) {
      state.session = res.session;
      state.serverNow = Date.now();
      state.syncNow = Date.now();
      closeOverlay();
      render();
    }
  });
  $("overlay").addEventListener("click", (e) => {
    if (e.target === $("overlay") && state.modalKind !== "dailyGoal")
      closeOverlay();
  });
  document.addEventListener("keydown", async (e) => {
    if (e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
    const tag = e.target?.tagName?.toLowerCase();
    if (
      ["input", "textarea", "select"].includes(tag) ||
      e.target?.isContentEditable
    )
      return;
    const map = { b: "bored", t: "tired", d: "distracted", f: "finish" };
    const kind = map[e.key.toLowerCase()];
    if (!kind) return;
    e.preventDefault();
    if (kind === "finish") {
      await send("COMPLETE_SESSION");
    } else {
      await send("TRIGGER_KIND", { kind });
    }
  });
}

function getToastMascot(kind = "judge", count = 1) {
  const toast = getToastMessage(kind, count);
  return (toast.image || "judge.svg").replace(/\.svg$/, "");
}

function showToast(text, kind = "judge", count = 1) {
  const node = $("toast");
  const content = getToastMessage(kind, count);
  const mascot = getToastMascot(kind, count);
  const imageUrl = getToastImageUrl(content.image || `${mascot}.svg`);
  node.innerHTML = `
    <div class="toast-card">
      <div class="toast-copy">
        <div class="toast-title">${escapeHtml(text || content.title)}</div>
      </div>
      <div class="toast-illustration">
        <img src="${imageUrl}" alt="Cat reminder" />
      </div>
    </div>
  `;
  node.classList.remove("hidden");
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => node.classList.add("hidden"), 2400);
}

// Listen for extension updates from the background worker and refresh the dashboard when a reminder, break, study restart, or final completion arrives.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "EXTENSION_ALERT") {
    maybePlayToastSound(msg).catch(() => {});
    syncSession().then(() => {
      if (msg.kind === "breakEnd") openBreakEnd(msg.count || 1);
      else
        openAlert(
          msg.kind,
          msg.count || 1,
          msg.breakDuration || 300,
          msg.forced,
        );
    });
  }
  if (msg.type === "EXTENSION_STUDY_STARTED") {
    maybePlayToastSound({
      kind: "studyStart",
      count: 1,
      eventId: `study-start-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
    }).catch(() => {});
    syncSession();
  }
  if (msg.type === "EXTENSION_FINISH") {
    triggerTimerCelebration();
    maybePlayToastSound({
      kind: "finish",
      count: 1,
      eventId: `finish-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    }).catch(() => {});
    syncSession();
    const finishContent = getToastMessage("finish", 1);
    showToast(finishContent.title, "finish", 1);
  }
  if (
    ["EXTENSION_BREAK_STARTED", "EXTENSION_STUDY_RESUMED"].includes(msg.type)
  ) {
    syncSession();
  }
});

(async function init() {
  bindBaseUI();
  await syncSession();
  requestAnimationFrame(tick);
})();
