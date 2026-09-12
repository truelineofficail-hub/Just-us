/* =========================================================
   app.js — router + bootstrapping. Wires together db, webrtc,
   sync and every feature module, and drives screen navigation
   inside this single-page static app.
   ========================================================= */
(function () {
  "use strict";

  const history_ = ["splash"];
  let awaitingFirstConnect = false;
  let pendingOfferCode = null; // guest: offer code being joined, kept for retry

  function $(sel) {
    return document.querySelector(sel);
  }

  function setActiveScreen(name) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.dataset.screen === name));
    document.querySelectorAll(".nav-item[data-nav]").forEach((btn) => {
      // only toggle active within the currently visible bottom-nav
      const parentActive = btn.closest(".screen.active");
      if (parentActive) btn.classList.toggle("active", btn.dataset.nav === name);
    });
  }

  function navigate(name, { replace = false } = {}) {
    if (!document.querySelector(`.screen[data-screen="${name}"]`)) return;
    if (!replace) history_.push(name);
    else history_[history_.length - 1] = name;
    setActiveScreen(name);
    onEnterScreen(name);
  }

  function goBack() {
    if (history_.length > 1) {
      history_.pop();
      setActiveScreen(history_[history_.length - 1]);
      onEnterScreen(history_[history_.length - 1]);
    } else {
      navigate("home");
    }
  }

  async function onEnterScreen(name) {
    if (name === "home") {
      Settings.renderHome();
      MissYou.renderBanner();
    } else if (name === "ourSpace") {
      Settings.renderOurSpace();
    } else if (name === "settings") {
      Settings.renderSettingsScreen();
    } else if (name === "notes") {
      Notes.renderList();
    } else if (name === "todo") {
      Tasks.render();
    } else if (name === "memories") {
      Memories.render();
    } else if (name === "chat") {
      Chat.refresh();
    } else if (name === "createSpace") {
      beginCreateSpace();
    } else if (name === "shareLocation") {
      LocationShare.enterScreen();
    } else if (name === "ourLocation") {
      LocationShare.renderOurLocation();
    }
  }

  // ---------------- Global click delegation ----------------
  function bindGlobalNav() {
    document.body.addEventListener("click", (e) => {
      const navBtn = e.target.closest("[data-nav]");
      if (navBtn) {
        navigate(navBtn.dataset.nav);
        return;
      }
      const backBtn = e.target.closest("[data-back]");
      if (backBtn) {
        goBack();
      }
    });
  }

  // ---------------- Create Space (host) flow ----------------
  let hostOfferCode = null;

  async function beginCreateSpace() {
    $("#answerPasteArea").style.display = "none";
    $("#spaceCodeDisplay").textContent = "Generating…";
    $("#spaceCodePayload").style.display = "none";
    $("#createStatusPill").innerHTML = '<span class="status-dot pending"></span> Preparing your space…';
    const copyBtn = $("#copyCodeBtn");
    copyBtn.disabled = false;
    copyBtn.style.opacity = "";
    copyBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" stroke="currentColor" stroke-width="1.5"/></svg>
      Copy Code`;
    try {
      hostOfferCode = await WebRTCManager.createRoom();
      $("#spaceCodeDisplay").textContent = hostOfferCode.slice(0, 4).toUpperCase() + "–" + hostOfferCode.slice(4, 8).toUpperCase();
      $("#spaceCodePayload").style.display = "block";
      $("#spaceCodePayload").textContent = hostOfferCode;
      $("#createStatusPill").innerHTML = '<span class="status-dot pending"></span> Waiting for your person…';
      $("#answerPasteArea").style.display = "block";
      awaitingFirstConnect = true;
    } catch (e) {
      Utils.toast("Couldn't start a space — check your connection and try again.");
    }
  }

  function bindCreateSpace() {
    $("#copyCodeBtn").addEventListener("click", async () => {
      if (!hostOfferCode) return;
      await navigator.clipboard.writeText(hostOfferCode).catch(() => {});
      Utils.toast("Code copied — send it to your person");
    });
    $("#finishConnectBtn").addEventListener("click", async () => {
      const val = $("#answerInput").value.trim();
      if (!val) return Utils.toast("Paste the answer code first");
      try {
        $("#createStatusPill").innerHTML = '<span class="status-dot pending"></span> Connecting…';
        await WebRTCManager.completeAsHost(val);
        navigate("connecting");
      } catch (e) {
        Utils.toast(e.message || "That code didn't work");
      }
    });
  }

  // ---------------- Join Space (guest) flow ----------------
  function bindJoinSpace() {
    $("#joinSubmitBtn").addEventListener("click", async () => {
      const val = $("#joinOfferInput").value.trim();
      if (!val) return Utils.toast("Paste your partner's code first");
      $("#joinSubmitBtn").textContent = "Joining…";
      try {
        const answer = await WebRTCManager.joinRoom(val);
        $("#joinAnswerBox").style.display = "block";
        $("#joinAnswerPayload").textContent = answer;
        pendingOfferCode = answer;
        awaitingFirstConnect = true;
        Utils.toast("Now send the answer code back to your partner");
      } catch (e) {
        Utils.toast(e.message || "That code didn't work");
      } finally {
        $("#joinSubmitBtn").textContent = "Join";
      }
    });
    $("#copyAnswerBtn").addEventListener("click", async () => {
      if (!pendingOfferCode) return;
      await navigator.clipboard.writeText(pendingOfferCode).catch(() => {});
      Utils.toast("Answer code copied");
    });
  }

  // ---------------- Connection state -> UI ----------------
  function bindConnectionState() {
    WebRTCManager.on("state", async ({ state }) => {
      const textEl = $("#connectStateText");
      const subEl = $("#connectSubText");
      const map = {
        connecting: ["Connecting…", "Setting up your private space"],
        waiting: ["Waiting for partner…", "Share your code to continue"],
        connected: ["Connected", "You're both in the same space now ♡"],
        disconnected: ["Disconnected", "Your person isn't reachable right now"],
        reconnecting: ["Reconnecting…", "Hang tight, trying to restore your connection"],
        failed: ["Connection failed", "Double-check the code and try again"],
      };
      const [t, s] = map[state] || ["", ""];
      if (textEl) textEl.textContent = t;
      if (subEl) subEl.textContent = s;

      if (state === "connected") {
        const profile = await Settings.getProfile();
        await Settings.saveProfile({ pairingCode: (hostOfferCode || pendingOfferCode || "").slice(0, 8).toUpperCase() });
        DB.flags.set("space_connected", true);
        // The code that got us here is now spent — WebRTC's own
        // signaling state won't accept a second answer against this
        // same offer, so reflect that in the UI rather than leaving a
        // "Copy Code" button that looks like it still does something.
        const copyBtn = $("#copyCodeBtn");
        if (copyBtn) {
          copyBtn.disabled = true;
          copyBtn.style.opacity = "0.5";
          copyBtn.innerHTML = "Connected — this code is now used up";
        }
        const answerArea = $("#answerPasteArea");
        if (answerArea) answerArea.style.display = "none";
        if (awaitingFirstConnect) {
          awaitingFirstConnect = false;
          setTimeout(() => navigate("home", { replace: true }), 700);
        }
        Settings.renderHome();
        Settings.renderOurSpace();
      }
      if (state === "failed" && awaitingFirstConnect) {
        Utils.toast("Couldn't connect — go back and try the code exchange again");
      }
    });

    $("#cancelConnectBtn").addEventListener("click", () => {
      WebRTCManager.disconnect();
      awaitingFirstConnect = false;
      navigate("joinCreate", { replace: true });
    });
    $("#connectingBackBtn").addEventListener("click", () => {
      WebRTCManager.disconnect();
      awaitingFirstConnect = false;
      goBack();
    });
  }

  // Reconnect affordance: tapping "offline" status pill on Home takes
  // you back to the onboarding code-exchange (see README — this is the
  // manual-signaling limitation of a fully serverless static app).
  function bindReconnectAffordances() {
    $("#homeStatusPill").addEventListener("click", () => {
      if (!WebRTCManager.isConnected()) navigate("joinCreate");
    });
  }

  // ---------------- Demo mode entry point ----------------
  function bindDemoPreview() {
    const btn = $("#demoPreviewBtn");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      btn.textContent = "Setting up a preview…";
      try {
        await Settings.seedDemoData();
        navigate("home", { replace: true });
        Utils.toast("Previewing with sample data — nothing here is really synced");
      } catch (e) {
        Utils.toast("Couldn't start the preview in this environment");
      } finally {
        btn.textContent = "Preview the app without pairing";
      }
    });
  }

  // ---------------- App Lock gate ----------------
  async function maybeShowAppLock() {
    const profile = await Settings.getProfile();
    if (profile.appLockEnabled) {
      Settings.beginUnlockFlow();
      setActiveScreen("appLock");
      history_.length = 0;
      history_.push("appLock");
      return true;
    }
    return false;
  }

  function unlockSucceeded() {
    const start = DB.flags.get("space_connected", false) ? "home" : "splash";
    history_.length = 0;
    history_.push(start);
    setActiveScreen(start);
    onEnterScreen(start);
  }

  // ---------------- Zoom prevention (belt-and-braces for iOS) ----------------
  // The viewport meta tag + 16px inputs handle most cases, but older iOS
  // Safari versions can still fire a pinch-zoom gesture regardless —
  // this stops that specific gesture without blocking normal scrolling
  // or tapping.
  function preventPinchZoom() {
    document.addEventListener("gesturestart", (e) => e.preventDefault());
    let lastTouchEnd = 0;
    document.addEventListener(
      "touchend",
      (e) => {
        const now = Date.now();
        if (now - lastTouchEnd <= 300) e.preventDefault(); // double-tap zoom
        lastTouchEnd = now;
      },
      { passive: false }
    );
  }

  // ---------------- PWA ----------------
  function registerServiceWorker() {
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("./service-worker.js").catch(() => {});
      });
    }
  }

  // ---------------- Boot ----------------
  function safeInit(name, mod) {
    try {
      mod.init();
    } catch (e) {
      Utils.log(`${name}.init() failed — continuing without it:`, e);
    }
  }

  async function boot() {
    bindGlobalNav();
    bindCreateSpace();
    bindJoinSpace();
    bindConnectionState();
    bindReconnectAffordances();
    bindDemoPreview();
    preventPinchZoom();
    Sync.init();
    safeInit("Chat", Chat);
    safeInit("Notes", Notes);
    safeInit("Tasks", Tasks);
    safeInit("Memories", Memories);
    safeInit("MissYou", MissYou);
    safeInit("LocationShare", LocationShare);
    safeInit("Call", Call);
    safeInit("Settings", Settings);
    registerServiceWorker();

    const locked = await maybeShowAppLock();
    if (!locked) {
      const start = DB.flags.get("space_connected", false) ? "home" : "splash";
      history_.length = 0;
      history_.push(start);
      setActiveScreen(start);
      onEnterScreen(start);
    }
  }

  document.addEventListener("DOMContentLoaded", boot);

  window.App = { navigate, goBack, unlockSucceeded };
})();
