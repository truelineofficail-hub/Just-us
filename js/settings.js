/* =========================================================
   settings.js — profile, relationship date, notifications,
   local App Lock PIN, data export/import/clear, leave space.

   IMPORTANT HONESTY NOTE (see brief's SECURITY section):
   App Lock is a LOCAL convenience lock only. The PIN is hashed
   with SHA-256 before being stored in localStorage purely so it
   isn't sitting there in plain text — this is NOT encryption of
   your notes/messages/photos, it does not protect the IndexedDB
   contents from someone with device access, and it is not a
   substitute for your phone's own lock screen. It only gates the
   in-app UI on this one device.
   ========================================================= */
(function () {
  "use strict";

  const PROFILE_ID = "profile";
  let pinBuffer = "";
  let lockMode = "unlock"; // 'unlock' | 'setup' | 'confirm'
  let pendingFirstPin = "";

  function $(sel) {
    return document.querySelector(sel);
  }

  function avatarInnerHtml(blob, name, includeBadge) {
    const badge = includeBadge
      ? '<div class="avatar-edit-badge"><svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1z" stroke="white" stroke-width="1.6"/><circle cx="12" cy="13.5" r="3.2" stroke="white" stroke-width="1.6"/></svg></div>'
      : "";
    if (blob) {
      const url = URL.createObjectURL(blob);
      return `<img src="${url}" alt="" />` + badge;
    }
    return Utils.escapeHtml(Utils.initials(name)) + badge;
  }

  async function getProfile() {
    let p = await DB.get("settings", PROFILE_ID);
    if (!p) {
      p = {
        id: PROFILE_ID,
        myName: "You",
        partnerName: "Partner",
        startDate: "",
        notificationsEnabled: true,
        appLockEnabled: false,
        pinHash: null,
        pairingCode: "",
      };
      await DB.put("settings", p);
    }
    return p;
  }

  async function saveProfile(patch) {
    const p = await getProfile();
    Object.assign(p, patch);
    await DB.put("settings", p);
    return p;
  }

  async function sha256(text) {
    try {
      const enc = new TextEncoder().encode(text);
      const hash = await crypto.subtle.digest("SHA-256", enc);
      return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      // crypto.subtle needs a secure context and isn't available in
      // every sandboxed preview frame. Fall back to a simple obscuring
      // hash so App Lock still functions there — same caveat as
      // always applies: this is a local UI gate, not encryption.
      let h = 0;
      for (let i = 0; i < text.length; i++) {
        h = (h << 5) - h + text.charCodeAt(i);
        h |= 0;
      }
      return "fallback_" + h;
    }
  }

  // ---------------- Our Space + Settings rendering ----------------
  async function renderOurSpace() {
    const p = await getProfile();
    $("#spaceCoupleNames").textContent = `${p.partnerName} & You`;
    $("#spaceAvatar").innerHTML = avatarInnerHtml(p.partnerAvatar, p.partnerName, false);
    $("#spacePairCode").textContent = p.pairingCode || "—";
    $("#spaceTogetherDays").textContent = `${Utils.daysTogether(p.startDate)} days`;
    $("#notifSub").textContent = p.notificationsEnabled ? "Enabled" : "Off";
    $("#notifToggle").classList.toggle("on", p.notificationsEnabled);
    const connected = WebRTCManager.isConnected() || DB.flags.get("demo_mode", false);
    $("#devicesConnectedSub").textContent = connected ? "2 devices connected" : "1 device connected";
    const pill = $("#spaceStatusPill");
    pill.innerHTML = connected
      ? '<span class="status-dot online"></span> Connected'
      : '<span class="status-dot offline"></span> Offline';
  }

  async function renderHome() {
    const p = await getProfile();
    $("#homeNameMe").textContent = p.myName;
    $("#homeNameThem").textContent = p.partnerName;
    $("#homeAvatarMe").innerHTML = avatarInnerHtml(p.myAvatar, p.myName, true);
    $("#homeAvatarThem").innerHTML = avatarInnerHtml(p.partnerAvatar, p.partnerName, false);
    $("#homeTogetherDays").textContent = `${Utils.daysTogether(p.startDate)} days ♡`;
    const connected = WebRTCManager.isConnected() || DB.flags.get("demo_mode", false);
    $("#homeStatusPill").innerHTML = connected
      ? '<span class="status-dot online"></span> Connected'
      : '<span class="status-dot offline"></span> Waiting to connect';
    $("#homeStatusSub").textContent = connected ? "Your private space is ready" : "Reconnect from Our Space when you're both online";
  }

  async function renderSettingsScreen() {
    const p = await getProfile();
    $("#settingsAvatarPreview").innerHTML = avatarInnerHtml(p.myAvatar, p.myName, false);
    $("#myNameInput").value = p.myName;
    $("#partnerNameInput").value = p.partnerName;
    $("#startDateInput").value = p.startDate || "";
    $("#settingsNotifSub").textContent = p.notificationsEnabled ? "Enabled" : "Off";
    $("#settingsNotifToggle").classList.toggle("on", p.notificationsEnabled);
    $("#appLockSub").textContent = p.appLockEnabled ? "On" : "Off";
    $("#appLockToggle").classList.toggle("on", p.appLockEnabled);
  }

  function bindProfileInputs() {
    $("#myNameInput").addEventListener(
      "change",
      Utils.debounce(async (e) => {
        await saveProfile({ myName: e.target.value.trim() || "You" });
        renderHome();
        renderOurSpace();
      }, 200)
    );
    $("#partnerNameInput").addEventListener(
      "change",
      Utils.debounce(async (e) => {
        await saveProfile({ partnerName: e.target.value.trim() || "Partner" });
        renderHome();
        renderOurSpace();
      }, 200)
    );
    $("#startDateInput").addEventListener("change", async (e) => {
      await saveProfile({ startDate: e.target.value });
      renderHome();
      renderOurSpace();
    });
  }

  function bindToggles() {
    async function toggleNotif() {
      const p = await getProfile();
      await saveProfile({ notificationsEnabled: !p.notificationsEnabled });
      renderSettingsScreen();
      renderOurSpace();
    }
    $("#notifToggle").addEventListener("click", toggleNotif);
    $("#settingsNotifToggle").addEventListener("click", toggleNotif);
    $("#notifRow").addEventListener("click", (e) => {
      if (!e.target.closest(".toggle")) toggleNotif();
    });

    $("#appLockToggle").addEventListener("click", async () => {
      const p = await getProfile();
      if (p.appLockEnabled) {
        const ok = await Utils.confirmModal({ title: "Turn off App Lock?", confirmLabel: "Turn off", danger: true });
        if (!ok) return;
        await saveProfile({ appLockEnabled: false, pinHash: null });
        renderSettingsScreen();
      } else {
        beginPinSetup();
      }
    });
  }

  function beginPinSetup() {
    lockMode = "setup";
    pinBuffer = "";
    pendingFirstPin = "";
    $("#lockTitle").textContent = "Create a PIN";
    $("#lockSub").textContent = "Choose a 4-digit PIN for this device.";
    $("#appLockBackBtn").style.visibility = "visible";
    renderPinDots();
    App.navigate("appLock");
  }

  function renderPinDots() {
    const dots = $("#pinDots").querySelectorAll("span");
    dots.forEach((d, i) => d.classList.toggle("filled", i < pinBuffer.length));
  }

  async function handlePinComplete() {
    if (lockMode === "setup") {
      pendingFirstPin = pinBuffer;
      pinBuffer = "";
      renderPinDots();
      lockMode = "confirm";
      $("#lockTitle").textContent = "Confirm PIN";
      $("#lockSub").textContent = "Enter the same PIN again.";
      return;
    }
    if (lockMode === "confirm") {
      if (pinBuffer !== pendingFirstPin) {
        shakeDots();
        pinBuffer = "";
        lockMode = "setup";
        $("#lockTitle").textContent = "Create a PIN";
        $("#lockSub").textContent = "PINs didn't match — try again.";
        renderPinDots();
        return;
      }
      const hash = await sha256(pinBuffer);
      await saveProfile({ appLockEnabled: true, pinHash: hash });
      Utils.toast("App Lock enabled");
      pinBuffer = "";
      App.navigate("settings");
      renderSettingsScreen();
      return;
    }
    if (lockMode === "unlock") {
      const p = await getProfile();
      const hash = await sha256(pinBuffer);
      if (hash === p.pinHash) {
        pinBuffer = "";
        App.unlockSucceeded();
      } else {
        shakeDots();
        pinBuffer = "";
        renderPinDots();
        Utils.toast("Incorrect PIN");
      }
    }
  }

  function shakeDots() {
    const dots = $("#pinDots");
    dots.classList.add("shake");
    setTimeout(() => dots.classList.remove("shake"), 400);
  }

  function beginUnlockFlow() {
    lockMode = "unlock";
    pinBuffer = "";
    $("#lockTitle").textContent = "App Locked";
    $("#lockSub").textContent = "Enter your PIN to continue.";
    $("#appLockBackBtn").style.visibility = "hidden";
    renderPinDots();
  }

  function bindPinPad() {
    document.querySelectorAll(".pin-key[data-key]").forEach((key) => {
      key.addEventListener("click", () => {
        if (pinBuffer.length >= 4) return;
        pinBuffer += key.dataset.key;
        renderPinDots();
        if (pinBuffer.length === 4) handlePinComplete();
      });
    });
    $("#pinBackspace").addEventListener("click", () => {
      pinBuffer = pinBuffer.slice(0, -1);
      renderPinDots();
    });
    $("#appLockBackBtn").addEventListener("click", () => {
      if (lockMode === "unlock") return; // no escaping a real lock via back
      pinBuffer = "";
      App.navigate("settings");
    });
    $("#forgotPinBtn").addEventListener("click", async () => {
      const ok = await Utils.confirmModal({
        title: "Reset App Lock?",
        sub: "Since there's no server, the only way to reset a forgotten PIN is to turn App Lock off. Your notes, chat and memories on this device are not affected.",
        confirmLabel: "Turn off App Lock",
      });
      if (ok) {
        await saveProfile({ appLockEnabled: false, pinHash: null });
        App.navigate("home");
      }
    });
  }

  // ---------------- Data management ----------------
  function bindDataRows() {
    $("#exportDataRow").addEventListener("click", async () => {
      const dump = await DB.exportAll();
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `just-us-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      Utils.toast("Backup downloaded");
    });

    $("#importDataRow").addEventListener("click", () => $("#importFileInput").click());
    $("#importFileInput").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      try {
        const text = await file.text();
        const dump = JSON.parse(text);
        await DB.importAll(dump);
        Utils.toast("Backup imported");
        renderHome();
        renderOurSpace();
        Notes.renderList();
        Tasks.render();
        Memories.render();
      } catch {
        Utils.toast("That file couldn't be read");
      }
    });

    $("#clearDataRow").addEventListener("click", async () => {
      const ok = await Utils.confirmModal({
        title: "Clear all local data?",
        sub: "This permanently deletes notes, chat, memories and tasks stored on this device. This cannot be undone.",
        confirmLabel: "Clear everything",
      });
      if (!ok) return;
      await DB.clearAll();
      DB.flags.remove("space_connected");
      WebRTCManager.disconnect();
      Utils.toast("Local data cleared");
      App.navigate("splash");
    });
  }

  function bindLeaveSpace() {
    async function leave() {
      const ok = await Utils.confirmModal({
        title: "Leave this space?",
        sub: "You'll be disconnected from your partner and this device will forget the pairing. Your local notes and memories stay on this device unless you also clear local data.",
        confirmLabel: "Leave Space",
      });
      if (!ok) return;
      WebRTCManager.disconnect();
      DB.flags.remove("space_connected");
      DB.flags.remove("demo_mode");
      await saveProfile({ pairingCode: "" });
      Utils.toast("You left the space");
      App.navigate("splash");
    }
    $("#leaveSpaceBtn").addEventListener("click", leave);
    $("#settingsLeaveBtn").addEventListener("click", leave);
  }

  // ---------------- Demo mode (preview without pairing) ----------------
  // Lets you click through every screen — chat, notes, memories,
  // chat, notes, tasks, memories, our space — without two real devices
  // doing the WebRTC
  // code exchange. Nothing here touches WebRTCManager; it just seeds
  // sample local data and flips a flag that renderHome/renderOurSpace
  // treat as "connected" for display purposes.
  async function seedDemoData() {
    const already = await DB.getAll("notes");
    if (already.length || (await DB.getAll("messages")).length) return; // don't duplicate on repeat visits

    await saveProfile({
      myName: "You",
      partnerName: "Alex",
      startDate: new Date(Date.now() - 92 * 86400000).toISOString().slice(0, 10),
      pairingCode: "DEMO-MODE",
    });

    const me = Utils.deviceId();
    const them = "demo-partner-device";

    await DB.put("notes", {
      title: "Our Plans ♡",
      body: "",
      checklist: [
        { id: Utils.uid(), text: "Go to the mountains", done: true },
        { id: Utils.uid(), text: "Visit Kashmir", done: false },
        { id: Utils.uid(), text: "Build our dream life", done: false },
      ],
      pinned: true,
      archived: false,
      tags: [],
    });
    await DB.put("notes", {
      title: "Random Thoughts",
      body: "You make everything better.",
      checklist: [],
      pinned: false,
      archived: false,
      tags: [],
    });

    for (const t of ["Complete DSA", "Read a book", "Workout", "Learn something new", "Be a better version of myself"]) {
      await DB.put("tasks", { text: t, done: t === "Complete DSA" });
    }

    const chat = [
      { text: "Heyy", senderId: them, minsAgo: 30 },
      { text: "Heyy 😊", senderId: me, minsAgo: 29 },
      { text: "Miss you 🥹", senderId: them, minsAgo: 20 },
      { text: "Same here ❤️", senderId: me, minsAgo: 18 },
    ];
    for (const m of chat) {
      const createdAt = new Date(Date.now() - m.minsAgo * 60000).toISOString();
      await DB.put("messages", {
        kind: "text",
        text: m.text,
        senderId: m.senderId,
        status: "seen",
        reactions: {},
        replyTo: null,
        createdAt,
      });
    }

    DB.flags.set("demo_mode", true);
    DB.flags.set("space_connected", true);
  }

  function isDemoMode() {
    return DB.flags.get("demo_mode", false);
  }

  // ---------------- Profile photo ----------------
  function openAvatarPicker() {
    getProfile().then((p) => {
      const actions = [
        {
          label: "Choose from device",
          kind: "primary",
          onClick: (close) => {
            close();
            $("#avatarFileInput").click();
          },
        },
        {
          label: "Use a sample avatar",
          kind: "glass",
          onClick: (close) => {
            close();
            const blob = Utils.makeSampleImageBlob("Sample photo");
            setMyAvatar(new File([blob], "sample-avatar.png", { type: "image/png" }));
          },
        },
      ];
      if (p.myAvatar) {
        actions.push({
          label: "Remove photo",
          kind: "danger",
          onClick: (close) => {
            close();
            clearMyAvatar();
          },
        });
      }
      Utils.showModal({
        title: "Profile photo",
        sub: "Your partner will see this too, synced automatically.",
        actions,
      });
    });
  }

  async function setMyAvatar(file) {
    await saveProfile({ myAvatar: file });
    renderHome();
    renderSettingsScreen();
    Utils.toast("Photo updated ♡");
    Sync.broadcastRaw({ type: "PROFILE_AVATAR", hasAvatar: true });
    if (WebRTCManager.isConnected()) {
      try {
        await WebRTCManager.sendFile(file, { kind: "avatar" });
      } catch {
        Utils.toast("Saved — will send once you're both connected");
      }
    }
  }

  async function clearMyAvatar() {
    const p = await getProfile();
    delete p.myAvatar;
    await DB.put("settings", p);
    renderHome();
    renderSettingsScreen();
    Sync.broadcastRaw({ type: "PROFILE_AVATAR", hasAvatar: false });
    Utils.toast("Photo removed");
  }

  async function handleAvatarFileEvent(evt) {
    if (!evt.meta || evt.meta.kind !== "avatar" || evt.sending) return;
    if (evt.phase === "complete") {
      await saveProfile({ partnerAvatar: evt.blob });
      renderHome();
      renderOurSpace();
    }
  }

  function bindAvatarUI() {
    $("#homeAvatarMe").addEventListener("click", openAvatarPicker);
    $("#settingsAvatarRow").addEventListener("click", openAvatarPicker);
    $("#avatarFileInput").addEventListener("change", (e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (f) setMyAvatar(f);
    });
    WebRTCManager.on("file", handleAvatarFileEvent);
    Sync.onType("PROFILE_AVATAR", async (packet) => {
      if (!packet.hasAvatar) {
        const p = await getProfile();
        delete p.partnerAvatar;
        await DB.put("settings", p);
        renderHome();
        renderOurSpace();
      }
      // hasAvatar:true is just an early heads-up — the actual photo
      // arrives moments later via the file transfer above.
    });
  }

  function init() {
    bindProfileInputs();
    bindToggles();
    bindPinPad();
    bindDataRows();
    bindLeaveSpace();
    bindAvatarUI();
  }

  window.Settings = {
    init,
    getProfile,
    saveProfile,
    renderOurSpace,
    renderHome,
    renderSettingsScreen,
    beginUnlockFlow,
    seedDemoData,
    isDemoMode,
  };
})();
