(function () {
  // This file defines the content used by the reminder toasts and the matching audio files. Each reminder type has a list of possible messages so the app can vary the wording as the same condition appears more than once.
  const TOAST_CONFIG = {
    tired: {
      messages: [
        {
          title: "Hey, feeling tired?",
          text: "I noticed signs of tiredness, such as yawning, eye rubbing and leaning. Maybe drink some water, or change positions and keep.",
          image: "default.svg",
        },
        {
          title: "Still feeling tired?",
          text: "Hey you are showing signs of tiredness again! I noticed you're yawning, leaning or rubbing your eyes. Maybe its time for a break now? Go walk around, stretch, drink some water and come back refreshed. See you soon!",
          image: "judge.svg",
        },
        {
          title: "Feeling tired again?",
          text: "I noticed signs of tiredness, such as yawning or eye rubbing. You may still be tired. Try a short break, some water, or a quick stretch before continuing.",
          image: "judge.svg",
        },
      ],
      buttons: [
        { label: "Keep studying", action: "keepStudying" },
        { label: "Take a break", action: "takeBreak" },
      ],
      fallback: {
        title: "Still feeling tired?",
        text: "You may still be tired.I noticed signs of tiredness, such as yawning or eye rubbing. Try a short break, some water, or a quick stretch before continuing.",
        image: "angry.svg",
      },
    },
    distracted: {
      messages: [
        {
          title: "Hey, put your phone away!",
          text: "I noticed you've been on your phone for too long. Try putting your phone away to keep studying.",
          image: "angry.svg",
        },
        {
          title: "Distracted again?",
          text: "It looks like your phone is still pulling your attention away. Would you like a short reset break?",
          image: "angry.svg",
        },
        {
          title: "Still distracted?",
          text: "It looks like your attention is drifting again. A short break may help you refocus.",
          image: "angry2.svg",
        },
      ],
      buttons: [
        { label: "Keep studying", action: "keepStudying" },
        { label: "Take a break", action: "takeBreak" },
      ],
      fallback: {
        title: "Distracted again?",
        text: "It looks like your phone is still pulling your attention away. Would you like a short reset break?",
        image: "angry2.svg",
      },
    },
    bored: {
      messages: [
        {
          title: "Hey, getting bored?",
          text: "I noticed signs that your attention may be drifting, like looking around or fidgeting. Let's refocus!",
          image: "default.svg",
        },
        {
          title: "Still feeling bored?",
          text: "Your attention may still be drifting, I noticed signs of looking around or fidgeting. Taking a short break might help you come back refreshed.",
          image: "judge.svg",
        },
        {
          title: "Feeling bored again?",
          text: "I noticed signs of looking around or fidgeting. It seems difficult to stay engaged. Would you like another short break before continuing?",
          image: "judge.svg",
        },
      ],
      buttons: [
        { label: "Keep studying", action: "keepStudying" },
        { label: "Take a break", action: "takeBreak" },
      ],
      fallback: {
        title: "Still feeling bored?",
        text: "Your attention may still be drifting, I noticed signs of looking around or fidgeting. Taking a short break might help you come back refreshed.",
        image: "angry.svg",
      },
    },
    breakEnd: {
      messages: [
        {
          title: "Ready to study again?",
          text: "Hope you're feeling refreshed! Let's get back to your study session.",
          image: "happy.svg",
        },
        {
          title: "Ready to study again?",
          text: "Hope the extra rest helped. Are you ready to return to studying, or would you like another short break?",
          image: "happy.svg",
        },
      ],
      buttons: [
        { label: "Keep studying", action: "resumeStudy" },
        { label: "Take another break", action: "extendBreak" },
      ],
      fallback: {
        title: "Ready to study again?",
        text: "Hope the extra rest helped. Are you ready to return to studying, or would you like another short break?",
        image: "happy.svg",
      },
    },
    finish: {
      messages: [
        {
          title: "Great Job!",
          text: "You've completed your study goal.",
          image: "happy.svg",
        },
      ],
      buttons: [{ label: "Continue", action: "dismiss" }],
      fallback: {
        title: "Great Job!",
        text: "You've completed your study goal.",
        image: "happy.svg",
      },
    },
  };

  function normalizeToastType(kind) {
    return Object.prototype.hasOwnProperty.call(TOAST_CONFIG, kind)
      ? kind
      : "tired";
  }

  function resolveToastImage(imageName) {
    const fileName = imageName || "judge.svg";
    if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
      return chrome.runtime.getURL(`cats/${fileName}`);
    }
    return `cats/${fileName}`;
  }

  // Choose the correct message for a reminder type and its repetition count.
  // As the same situation happens again, the app moves to a more insistent message.
  function getToastContent(type, occurrenceCount = 1) {
    const kind = normalizeToastType(type);
    const config = TOAST_CONFIG[kind] || TOAST_CONFIG.tired;
    const count = Math.max(1, Number(occurrenceCount) || 1);
    const lastIndex = Math.max(0, config.messages.length - 1);
    const fallback = config.fallback ||
      config.messages[lastIndex] || {
        title: "Focus reminder",
        text: "Take a short break and refocus.",
        image: "judge.svg",
      };
    const selected =
      count > config.messages.length
        ? fallback
        : config.messages[Math.min(lastIndex, count - 1)] || fallback;

    const imageName = selected.image || fallback.image || "judge.svg";
    const buttons =
      Array.isArray(config.buttons) && config.buttons.length
        ? config.buttons
        : [
            { label: "Keep studying", action: "keepStudying" },
            { label: "Take a break", action: "takeBreak" },
          ];

    return {
      type: kind,
      title: selected.title || fallback.title || "Focus reminder",
      text: selected.text || fallback.text || "",
      description: selected.text || fallback.text || "",
      image: imageName,
      imagePath: resolveToastImage(imageName),
      buttons,
    };
  }

  // Match each toast type to a sound file. The same message type can also use a different file depending on whether it is a study start, a break end, or a finish.
  function getToastSoundConfig(type, occurrenceCount = 1) {
    const normalizedType = String(type || "").toLowerCase();
    const content = getToastContent(type, occurrenceCount);
    const imageName = (content.image || "").toLowerCase();

    if (
      normalizedType === "studystart" ||
      normalizedType === "startsession" ||
      normalizedType === "timer-start"
    ) {
      const audioFile = "voice/timer-start.m4a";
      return {
        image: "default.svg",
        file: audioFile,
        url:
          typeof chrome !== "undefined" && chrome.runtime?.getURL
            ? chrome.runtime.getURL(audioFile)
            : audioFile,
      };
    }

    if (
      normalizedType === "breakend" ||
      normalizedType === "break_end" ||
      normalizedType === "break-end"
    ) {
      const audioFile = "voice/back-to-study.m4a";
      return {
        image: "happy.svg",
        file: audioFile,
        url:
          typeof chrome !== "undefined" && chrome.runtime?.getURL
            ? chrome.runtime.getURL(audioFile)
            : audioFile,
      };
    }

    if (normalizedType === "finish") {
      const audioFile = "voice/finish.m4a";
      return {
        image: "happy.svg",
        file: audioFile,
        url:
          typeof chrome !== "undefined" && chrome.runtime?.getURL
            ? chrome.runtime.getURL(audioFile)
            : audioFile,
      };
    }

    if (["default.svg", "judge.svg", "happy.svg"].includes(imageName)) {
      const audioFile = "voice/cat-remind.m4a";
      return {
        image: imageName,
        file: audioFile,
        url:
          typeof chrome !== "undefined" && chrome.runtime?.getURL
            ? chrome.runtime.getURL(audioFile)
            : audioFile,
      };
    }

    if (["angry.svg", "angry2.svg"].includes(imageName)) {
      const audioFile = "voice/angry cat.m4a";
      return {
        image: imageName,
        file: audioFile,
        url:
          typeof chrome !== "undefined" && chrome.runtime?.getURL
            ? chrome.runtime.getURL(audioFile)
            : audioFile,
      };
    }

    return null;
  }

  globalThis.TOAST_CONFIG = TOAST_CONFIG;
  globalThis.resolveToastImage = resolveToastImage;
  globalThis.getToastContent = getToastContent;
  globalThis.getToastSoundConfig = getToastSoundConfig;
})();
