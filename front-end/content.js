(() => {
  // This script is injected into web pages so the extension can display reminder toasts even when the user is browsing outside the dashboard. It keeps the message UI, button actions, audio, and keyboard shortcuts in one place.
  if (globalThis.__focusContentLoaded) return;
  globalThis.__focusContentLoaded = true;

  const shortcuts = { b: "bored", t: "tired", d: "distracted", f: "finish" };
  let host = null;

  function dismiss() {
    host?.remove();
    host = null;
  }

  function getToastMessage(kind, count) {
    if (typeof globalThis.getToastContent === "function") {
      return globalThis.getToastContent(kind, count);
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

  function getImageUrl(fileName) {
    if (typeof globalThis.resolveToastImage === "function") {
      return globalThis.resolveToastImage(fileName);
    }
    return typeof chrome !== "undefined" && chrome.runtime?.getURL
      ? chrome.runtime.getURL(`cats/${fileName}`)
      : `cats/${fileName}`;
  }

  function getButtonLabel(buttons, action, fallback) {
    return (
      buttons.find((button) => button.action === action)?.label || fallback
    );
  }

  function getButtonClass(kind, count = 1, action = "keepStudying") {
    const normalizedKind = String(kind || "").toLowerCase();
    const isKeepAction = action === "keepStudying" || action === "resumeStudy";
    const isTakeAction = action === "takeBreak" || action === "extendBreak";

    if (normalizedKind === "breakend") {
      return isKeepAction ? "btn ghost" : "btn solid";
    }

    if (normalizedKind === "distracted") {
      return isKeepAction ? "btn solid" : "btn ghost";
    }

    const isEvenOccurrence = Number(count) % 2 === 0;
    if (isKeepAction) {
      return isEvenOccurrence ? "btn ghost" : "btn solid";
    }
    if (isTakeAction) {
      return isEvenOccurrence ? "btn solid" : "btn ghost";
    }

    return "btn ghost";
  }

  async function getSoundSettings() {
    if (!chrome?.storage?.local) return { muted: false, volume: 50 };
    const result = await chrome.storage.local.get("focusSoundSettings");
    return {
      muted: !!result?.focusSoundSettings?.muted,
      volume: Number(result?.focusSoundSettings?.volume) || 50,
    };
  }

  async function markToastAudioHandled(eventId) {
    if (!eventId) return false;
    const result = await chrome.storage.local.get("focusToastAudioLocks");
    const locks = result?.focusToastAudioLocks || {};
    if (locks[eventId]) return false;
    locks[eventId] = Date.now();
    await chrome.storage.local.set({ focusToastAudioLocks: locks });
    setTimeout(async () => {
      try {
        const current = await chrome.storage.local.get("focusToastAudioLocks");
        const active = current?.focusToastAudioLocks || {};
        delete active[eventId];
        await chrome.storage.local.set({ focusToastAudioLocks: active });
      } catch (error) {
        console.warn("Failed to clear toast audio lock:", error);
      }
    }, 10000);
    return true;
  }

  function getToastSound(kind, count) {
    if (typeof globalThis.getToastSoundConfig === "function") {
      return globalThis.getToastSoundConfig(kind, count);
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
    audio.volume = Math.min(
      1,
      Math.max(0, Number(settings.volume || 50) / 100),
    );
    audio.preload = "auto";
    try {
      await audio.play();
    } catch (error) {
      console.warn("Toast sound blocked or unavailable:", error);
    }
    return true;
  }

  // Build and display the floating reminder card. The button labels change based on whether the user is being reminded to continue studying or to take a break.
  function show(payload) {
    dismiss();
    const item = getToastMessage(payload.kind, payload.count || 1);
    const buttons = Array.isArray(item.buttons) ? item.buttons : [];
    const imageUrl = getImageUrl(item.image || "judge.svg");

    host = document.createElement("div");
    host.style.cssText =
      "position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      *{box-sizing:border-box;font-family:'DM Sans',Arial,sans-serif}
      .card{pointer-events:auto;position:fixed;bottom:24px;right:24px;width:min(780px,calc(100vw - 36px));display:grid;grid-template-columns:minmax(0,1.65fr) minmax(0,1fr);background:#c9e2f7;border-radius:24px;overflow:hidden;box-shadow:0 12px 0 #0d2745,0 15px 28px #13294142;color:#060606}
      .body{min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:32px 16px 32px 36px}
      .cat-art{display:flex;align-items:center;justify-content:center;padding:18px 16px 12px 0;min-width:0}
      .cat-art img{display:block;width:100%;max-height:285px;object-fit:contain}
      h2{font-size:clamp(20px,2vw,28px);margin:0 0 14px;line-height:1.2;font-weight:800}
      p{font-size:clamp(13px,1.3vw,16px);line-height:1.5;margin:0 0 22px}
      .actions{display:flex;width:100%;border:2px solid #0a4d95;border-radius:16px;overflow:hidden}
      .btn{flex:1;min-width:0;padding:16px 10px;font-size:clamp(13px,1.4vw,18px);border:0;cursor:pointer}
      .ghost{background:transparent;color:#0a4d95}.solid{background:#0a4d95;color:white}
      .close{position:absolute;top:10px;right:12px;width:28px;height:28px;border:0;border-radius:50%;background:#fff8;color:#0a4d95;font-size:19px;cursor:pointer}
      @media(max-width:580px){.card{grid-template-columns:1.8fr 1fr}.body{padding:20px 8px 20px 14px}.cat-art{padding:12px 10px 10px 0}h2{font-size:18px}p{font-size:12px}.btn{padding:10px 5px;font-size:11px}}
    `;
    const card = document.createElement("section");
    card.className = "card";
    const body = document.createElement("div");
    body.className = "body";
    const h2 = document.createElement("h2");
    h2.textContent = item.title;
    const p = document.createElement("p");
    p.textContent = item.text;
    body.append(h2, p);

    if (payload.kind === "finish") {
      const btn = document.createElement("button");
      btn.className = "btn solid";
      btn.textContent = getButtonLabel(buttons, "dismiss", "Continue");
      btn.onclick = dismiss;
      body.appendChild(btn);
    } else {
      const actions = document.createElement("div");
      actions.className = "actions";
      const keep = document.createElement("button");
      const keepAction =
        payload.kind === "breakEnd" ? "resumeStudy" : "keepStudying";
      keep.className = getButtonClass(
        payload.kind,
        payload.count || 1,
        keepAction,
      );
      keep.textContent = getButtonLabel(buttons, keepAction, "Keep studying");
      keep.onclick = async () => {
        if (payload.forced || payload.kind === "breakEnd") {
          await chrome.runtime
            .sendMessage({ type: "RESUME_STUDY" })
            .catch(() => {});
        }
        dismiss();
      };

      const take = document.createElement("button");
      const takeAction =
        payload.kind === "breakEnd" ? "extendBreak" : "takeBreak";
      take.className = getButtonClass(
        payload.kind,
        payload.count || 1,
        takeAction,
      );
      take.textContent = getButtonLabel(
        buttons,
        takeAction,
        payload.kind === "breakEnd" ? "Take another break" : "Take a break",
      );
      take.onclick = async () => {
        if (payload.kind === "breakEnd") {
          await chrome.runtime
            .sendMessage({ type: "EXTEND_BREAK", breakDuration: 300 })
            .catch(() => {});
        } else {
          await chrome.runtime
            .sendMessage({
              type: "TAKE_BREAK",
              breakDuration: payload.breakDuration || 300,
            })
            .catch(() => {});
        }
        dismiss();
        chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" }).catch(() => {});
      };
      actions.append(keep, take);
      body.appendChild(actions);
    }

    const close = document.createElement("button");
    close.className = "close";
    close.textContent = "×";
    close.onclick = dismiss;
    const art = document.createElement("div");
    art.className = "cat-art";
    const artImg = document.createElement("img");
    artImg.src = imageUrl;
    artImg.alt = "Cat character";
    art.appendChild(artImg);
    card.append(body, art, close);
    root.append(style, card);
    document.documentElement.appendChild(host);
    maybePlayToastSound(payload).catch(() => {});
    return true;
  }

  // Keyboard shortcuts are used as a lightweight way to simulate user-state cues: b = bored, t = tired, d = distracted, and f = finish the session.
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.isComposing)
        return;
      const t = e.target;
      if (
        t?.closest?.(
          'input,textarea,select,[contenteditable=""],[contenteditable="true"],[role="textbox"]',
        ) ||
        t?.isContentEditable
      )
        return;
      const kind = shortcuts[e.key.toLowerCase()];
      if (!kind) return;
      e.preventDefault();
      if (kind === "finish")
        chrome.runtime
          .sendMessage({ type: "COMPLETE_SESSION" })
          .catch(() => {});
      else
        chrome.runtime
          .sendMessage({ type: "TRIGGER_KIND", kind })
          .catch(() => {});
    },
    true,
  );

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg.type === "SHOW_FOCUS_ALERT") {
      reply({ shown: show(msg.payload) });
    }
  });
})();
