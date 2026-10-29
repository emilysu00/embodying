importScripts("toast-config.js");

// This background service worker is the central controller for the extension.
// It keeps the study session state in Chrome storage, decides when to switch between study and break modes, and sends updates to the dashboard window.
// The code here is responsible for timers, reminder counters, and alert delivery.

const DEFAULT = {
  dailyGoalSeconds: 0,
  todayStudiedSeconds: 0,
  goalSeconds: 3600,
  studySeconds: 0,
  breakGoalSeconds: 300,
  breakSeconds: 0,
  started: false,
  running: false,
  startedAt: null,
  finished: false,
  mode: "study", // study | break
  completedBreaks: [],
  reminderCounts: { tired: 0, bored: 0, distracted: 0, breakEnd: 0 },
  longBreakTriggered: false,
  pendingPrompt: null,
};

const KEY = "focusSession";
const ALERTS = {
  longBreak: {
    title: "Time for a longer break",
    body: "You have been studying for 55 minutes. Let's pause for a 25-minute break.",
  },
};

// Read the current session from local storage. The default values ensure that the dashboard always has a valid starting state even before the user begins.
async function getSession() {
  const obj = await chrome.storage.local.get(KEY);
  return { ...DEFAULT, ...(obj[KEY] || {}) };
}

// Save the updated session back to storage so the dashboard and the background worker stay in sync when the timer is started, paused, or reset.
async function putSession(session) {
  await chrome.storage.local.set({ [KEY]: session });
  return session;
}

function deltaSeconds(startedAt) {
  return startedAt ? Math.max(0, (Date.now() - startedAt) / 1000) : 0;
}

function currentStudySeconds(session) {
  return (
    session.studySeconds +
    (session.running && session.mode === "study"
      ? deltaSeconds(session.startedAt)
      : 0)
  );
}

function currentBreakSeconds(session) {
  return (
    session.breakSeconds +
    (session.running && session.mode === "break"
      ? deltaSeconds(session.startedAt)
      : 0)
  );
}

// Notify any open dashboard tabs that the session state has changed. This lets the main page update itself without polling continuously and keeps the background worker and dashboard in direct communication when a study or break event happens.
async function sendToDashboards(type, payload = {}) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.url?.startsWith(chrome.runtime.getURL("index.html"))) {
      chrome.tabs.sendMessage(tab.id, { type, ...payload }).catch(() => {});
    }
  }
}

function getAlertDescriptor(kind, count = 1) {
  if (kind === "longBreak") return ALERTS.longBreak;
  if (typeof globalThis.getToastContent === "function") {
    const toast = globalThis.getToastContent(kind, count);
    return {
      title: toast.title,
      body: toast.description || toast.text,
    };
  }
  return {
    title: "Focus reminder",
    body: "Take a short break and refocus.",
  };
}

// Try to deliver the reminder to the active tab first. If that fails because the page is not a dashboard or the content script is not available, fall back to a native Chrome notification so the user still sees the alert.
async function alertActive(payload) {
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const tab = tabs[0];
  let delivered = false;
  if (tab?.id) {
    try {
      let response;
      try {
        response = await chrome.tabs.sendMessage(tab.id, {
          type: "SHOW_FOCUS_ALERT",
          payload,
        });
      } catch (err) {
        if (/^https?:\/\//.test(tab.url || "")) {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["toast-config.js", "content.js"],
          });
          response = await chrome.tabs.sendMessage(tab.id, {
            type: "SHOW_FOCUS_ALERT",
            payload,
          });
        }
      }
      delivered = !!response?.shown;
    } catch (err) {
      console.warn("Toast unavailable on this page:", err);
    }
  }
  if (!delivered) {
    const note = getAlertDescriptor(payload.kind, payload.count || 1);
    await chrome.notifications
      .create("focus-" + Date.now(), {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icon.png"),
        title: note.title,
        message: note.body,
        priority: 1,
      })
      .catch(() => {});
  }
}

// Schedule the next time-based event. This keeps the extension responsive even if the dashboard is closed by calculating when the next study or break milestone is due, then creating a Chrome alarm for that moment.
async function scheduleNext(session) {
  await chrome.alarms.clear("focusEvent");
  if (!session.running) return;

  let remaining = Infinity;
  if (session.mode === "study") {
    const studyNow = currentStudySeconds(session);
    const sessionRemaining = Math.max(0, session.goalSeconds - studyNow);
    remaining = sessionRemaining;
    if (session.goalSeconds > 55 * 60 && !session.longBreakTriggered) {
      const untilLongBreak = Math.max(0, 55 * 60 - studyNow);
      remaining = Math.min(remaining, untilLongBreak);
    }
  } else {
    remaining = Math.max(
      0,
      session.breakGoalSeconds - currentBreakSeconds(session),
    );
  }

  await chrome.alarms.create("focusEvent", {
    when: Date.now() + Math.max(1000, remaining * 1000),
  });
}

// When the timer is paused or a mode changes, the time that has already passed is added to the saved session so the app can resume without losing elapsed time.
function commitLiveTime(session) {
  if (!session.running || !session.startedAt) return session;
  const delta = deltaSeconds(session.startedAt);
  if (session.mode === "study") {
    session.studySeconds += delta;
    session.todayStudiedSeconds += delta;
  } else {
    session.breakSeconds += delta;
  }
  session.startedAt = null;
  return session;
}

async function finalizeFinish(session) {
  session = commitLiveTime(session);
  session.running = false;
  session.finished = true;
  session.mode = "study";
  session.pendingPrompt = null;
  await putSession(session);
  await scheduleNext(session);
  await sendToDashboards("EXTENSION_FINISH", { session });
  await alertActive({ kind: "finish", count: 1 });
  return session;
}

async function startBreak(session, durationSeconds = 300) {
  session = commitLiveTime(session);
  session.running = true;
  session.mode = "break";
  session.breakGoalSeconds = durationSeconds;
  session.breakSeconds = 0;
  session.startedAt = Date.now();
  session.pendingPrompt = null;
  await putSession(session);
  await scheduleNext(session);
  await sendToDashboards("EXTENSION_BREAK_STARTED", { session });
  return session;
}

async function resumeStudy(session) {
  const wasInBreak = session.mode === "break";
  if (wasInBreak) {
    // Reset the reminder counters after a break ends so the next study reminder starts fresh rather than continuing the same tired/distraction sequence.
    session = commitLiveTime(session);
    const breakDuration = session.breakSeconds;
    if (breakDuration > 0) {
      session.completedBreaks = [
        ...session.completedBreaks,
        {
          studyAt: session.studySeconds,
          duration: breakDuration,
        },
      ];
    }
    session.breakSeconds = 0;
    session.reminderCounts = {
      ...(session.reminderCounts || {}),
      tired: 0,
      bored: 0,
      distracted: 0,
    };
  }
  session.mode = "study";
  session.running = true;
  session.started = true;
  session.finished = false;
  session.startedAt = Date.now();
  session.pendingPrompt = null;
  await putSession(session);
  await scheduleNext(session);
  await sendToDashboards("EXTENSION_STUDY_RESUMED", { session });
  return session;
}

// Trigger a reminder toast or a browser notification. The reminder counter is reset for each category before counting the current occurrence so the same type of reminder can be tracked independently without affecting the others.
async function showKind(kind, extra = {}) {
  const session = await getSession();
  // Count each behaviour independently. A tired alert must never advance bored or distracted.
  session.reminderCounts = {
    tired: 0,
    bored: 0,
    distracted: 0,
    breakEnd: 0,
    ...(session.reminderCounts || {}),
  };
  let count = 1;
  if (["tired", "bored", "distracted", "breakEnd"].includes(kind)) {
    count = Math.max(0, Number(session.reminderCounts[kind]) || 0) + 1;
    session.reminderCounts[kind] = count;
  }
  await putSession(session);
  const payload = {
    kind,
    count,
    breakDuration: extra.breakDuration || 300,
    forced: !!extra.forced,
    eventId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  };
  await sendToDashboards("EXTENSION_ALERT", payload);
  await alertActive(payload);
  return payload;
}

// Alarm handler: this is where the extension decides whether the session has reached its study goal, reached a long-break threshold, or ended a short break.
async function handleAlarm() {
  let session = await getSession();
  if (!session.running) return;

  if (session.mode === "study") {
    const studyNow = currentStudySeconds(session);
    if (
      session.goalSeconds > 55 * 60 &&
      !session.longBreakTriggered &&
      studyNow >= 55 * 60 - 0.5
    ) {
      session = commitLiveTime(session);
      session.running = false;
      session.longBreakTriggered = true;
      session.pendingPrompt = "longBreak";
      await putSession(session);
      await scheduleNext(session);
      await showKind("tired", { breakDuration: 25 * 60, forced: true });
      return;
    }
    if (studyNow >= session.goalSeconds - 0.5) {
      await finalizeFinish(session);
      return;
    }
  } else if (session.mode === "break") {
    const breakNow = currentBreakSeconds(session);
    if (breakNow >= session.breakGoalSeconds - 0.5) {
      session = commitLiveTime(session);
      session.running = false;
      session.startedAt = null;
      await putSession(session);
      await scheduleNext(session);
      await showKind("breakEnd");
      return;
    }
  }
  await scheduleNext(session);
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(KEY);
  if (!existing[KEY]) await putSession(DEFAULT);
});

chrome.runtime.onStartup.addListener(async () => {
  const session = await getSession();
  if (session.running) {
    await handleAlarm();
    const current = await getSession();
    await scheduleNext(current);
  }
});

chrome.action.onClicked.addListener(() =>
  chrome.tabs.create({ url: chrome.runtime.getURL("index.html") }),
);

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "finish") {
    const session = await getSession();
    await finalizeFinish(session);
    return;
  }
  if (["bored", "tired", "distracted"].includes(command)) {
    await showKind(command);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "focusEvent") handleAlarm();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case "GET_SESSION": {
        const session = await getSession();
        return { session, serverNow: Date.now() };
      }
      case "SET_DAILY_GOAL": {
        const session = await getSession();
        session.dailyGoalSeconds = Math.max(
          0,
          Number(message.dailyGoalSeconds) || 0,
        );
        await putSession(session);
        return { session };
      }
      case "START_SESSION": {
        const session = await getSession();
        const goalSeconds = Math.max(60, Number(message.goalSeconds) || 3600);
        Object.assign(session, {
          goalSeconds,
          studySeconds: 0,
          breakGoalSeconds: 300,
          breakSeconds: 0,
          started: true,
          running: true,
          startedAt: Date.now(),
          finished: false,
          mode: "study",
          completedBreaks: [],
          longBreakTriggered: false,
          pendingPrompt: null,
        });
        await putSession(session);
        await scheduleNext(session);
        await sendToDashboards("EXTENSION_STUDY_STARTED", { session });
        return { session };
      }
      case "TOGGLE_SESSION": {
        const session = await getSession();
        if (!session.started || session.finished) return { session };
        if (session.running) {
          commitLiveTime(session);
          session.running = false;
        } else {
          session.running = true;
          session.startedAt = Date.now();
        }
        await putSession(session);
        await scheduleNext(session);
        return { session };
      }
      case "RESET_SESSION": {
        const current = await getSession();
        const reset = {
          ...DEFAULT,
          dailyGoalSeconds: current.dailyGoalSeconds,
          todayStudiedSeconds: current.todayStudiedSeconds,
        };
        await putSession(reset);
        await scheduleNext(reset);
        return { session: reset };
      }
      case "TRIGGER_KIND": {
        await showKind(message.kind, {
          breakDuration: message.breakDuration || 300,
        });
        return { ok: true };
      }
      case "TAKE_BREAK": {
        const session = await getSession();
        const updated = await startBreak(
          session,
          Number(message.breakDuration) || 300,
        );
        return { session: updated };
      }
      case "RESUME_STUDY": {
        const session = await getSession();
        const updated = await resumeStudy(session);
        return { session: updated };
      }
      case "EXTEND_BREAK": {
        const session = await getSession();
        const updated = await startBreak(
          session,
          Number(message.breakDuration) || 300,
        );
        return { session: updated };
      }
      case "COMPLETE_SESSION": {
        const session = await getSession();
        await finalizeFinish(session);
        return { ok: true };
      }
      case "OPEN_DASHBOARD": {
        await chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
        return { ok: true };
      }
      default:
        return { ok: false };
    }
  })()
    .then(sendResponse)
    .catch((error) => sendResponse({ error: String(error) }));
  return true;
});
