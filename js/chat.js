/* =========================================================
   chat.js — private two-person chat.

   Messages are stored in IndexedDB (`messages` store) so the
   whole history stays on-device. Text travels instantly over the
   open DataChannel as a MESSAGE packet. Images and voice notes are
   announced the same way, then their bytes stream separately over
   WebRTC's file-chunk protocol (see webrtc.js) so a big photo never
   blocks the text line behind it.
   ========================================================= */
(function () {
  "use strict";

  let replyingTo = null;
  let typingTimeout = null;
  let mediaRecorder = null;
  let recordedChunks = [];
  let isRecording = false;
  const REACTIONS = ["❤️", "😂", "😮", "🙏", "😢"];

  function $(sel) {
    return document.querySelector(sel);
  }

  async function loadMessages() {
    const all = await DB.getAll("messages");
    all.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    return all;
  }

  function mediaLabel(msg) {
    if (msg.kind === "image") return "Photo";
    if (msg.kind === "video") return "Video";
    if (msg.kind === "voice") return "Voice message";
    if (msg.kind === "location") return "Location";
    return "";
  }

  function bubbleMetaHtml(msg) {
    const mine = msg.senderId === Utils.deviceId();
    let tick = "";
    if (mine) {
      if (msg.status === "seen") {
        tick = `<svg viewBox="0 0 24 24" fill="none"><path d="M2 12l4 4 5-6M11 12l4 4 7-9" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>`;
      } else if (msg.status === "delivered") {
        tick = `<svg viewBox="0 0 24 24" fill="none"><path d="M2 12l4 4 5-6M11 12l4 4 7-9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
      } else {
        tick = `<svg viewBox="0 0 24 24" fill="none"><path d="M5 12l4 4 10-10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
      }
    }
    return `${Utils.formatTime(msg.createdAt)} ${tick}`;
  }

  function renderReactions(msg) {
    const entries = Object.entries(msg.reactions || {}).filter(([, by]) => by && by.length);
    if (!entries.length) return "";
    return `<div class="reactions-row">${entries
      .map(([emoji, by]) => `<span class="reaction-chip">${emoji} ${by.length > 1 ? by.length : ""}</span>`)
      .join("")}</div>`;
  }

  async function renderMessage(msg) {
    const mine = msg.senderId === Utils.deviceId();
    const row = document.createElement("div");
    row.className = "msg-row " + (mine ? "me" : "them");
    row.dataset.id = msg.id;

    let inner = "";
    if (msg.replyTo) {
      const parent = await DB.get("messages", msg.replyTo);
      if (parent) {
        inner += `<div class="reply-preview">${Utils.escapeHtml((parent.text || mediaLabel(parent)).slice(0, 60))}</div>`;
      }
    }

    if (msg.kind === "image") {
      if (msg.blob) {
        const url = URL.createObjectURL(msg.blob);
        inner += `<img class="chat-img" src="${url}" alt="shared photo" />`;
      } else {
        inner += `<div class="shimmer" style="width:180px;height:130px;"></div>`;
      }
      if (msg.text) inner += `<div style="margin-top:6px;">${Utils.escapeHtml(msg.text)}</div>`;
    } else if (msg.kind === "video") {
      if (msg.blob) {
        const url = URL.createObjectURL(msg.blob);
        inner += `<video class="chat-img" src="${url}" controls playsinline preload="metadata"></video>`;
      } else {
        inner += `<div class="shimmer" style="width:180px;height:130px;"></div>`;
      }
      if (msg.text) inner += `<div style="margin-top:6px;">${Utils.escapeHtml(msg.text)}</div>`;
    } else if (msg.kind === "location") {
      const isLive = msg.live && (!msg.expiresAt || new Date(msg.expiresAt) > new Date());
      const isMine = msg.senderId === Utils.deviceId();
      inner += `
        <div class="location-bubble" data-loc-open="${msg.id}">
          <div class="lb-map">
            <svg viewBox="0 0 24 24" fill="none"><path d="M12 21s7-6.5 7-11.5A7 7 0 105 9.5C5 14.5 12 21 12 21z" stroke="white" stroke-width="1.4"/><circle cx="12" cy="9.5" r="2.2" stroke="white" stroke-width="1.3"/></svg>
          </div>
          <div class="lb-info">
            <div class="lb-title">
              ${isLive ? '<span class="live-dot"></span> Live location' : "📍 Location"}
              ${msg.sample ? " (sample)" : ""}
            </div>
            <div class="lb-sub">${isLive ? `Updating · ends ${Utils.escapeHtml(LocationShare.fmtEndTime(new Date(msg.expiresAt).getTime()))}` : "Tap to open in Maps"}</div>
          </div>
          ${isLive && isMine ? `<button class="lb-stop" data-stop-loc="${msg.id}">Stop sharing</button>` : ""}
        </div>`;
    } else if (msg.kind === "voice") {
      if (msg.blob) {
        const url = URL.createObjectURL(msg.blob);
        inner += `
          <div class="voice-bubble">
            <button class="voice-play"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M8 5v14l11-7L8 5z" fill="currentColor"/></svg></button>
            <div class="wave">${Array.from({ length: 18 }).map(() => `<span style="height:${6 + Math.random() * 14}px;"></span>`).join("")}</div>
            <span style="font-size:11px;color:var(--text-3);">${msg.duration || "0:0"}</span>
            <audio src="${url}" preload="none"></audio>
          </div>`;
      } else {
        inner += `<div class="muted" style="font-size:13px;">Receiving voice message…</div>`;
      }
    } else {
      inner += Utils.escapeHtml(msg.text || "");
    }

    row.innerHTML = `
      <div class="bubble" data-role="bubble">${inner}</div>
      ${renderReactions(msg)}
      <div class="msg-meta">${bubbleMetaHtml(msg)}</div>
    `;

    let pressTimer;
    const bubbleEl = row.querySelector('[data-role="bubble"]');
    bubbleEl.addEventListener("pointerdown", () => {
      pressTimer = setTimeout(() => openMessageActions(msg), 420);
    });
    ["pointerup", "pointerleave"].forEach((ev) =>
      bubbleEl.addEventListener(ev, () => clearTimeout(pressTimer))
    );

    const audioEl = row.querySelector("audio");
    const playBtn = row.querySelector(".voice-play");
    if (audioEl && playBtn) {
      playBtn.addEventListener("click", () => {
        if (audioEl.paused) audioEl.play();
        else audioEl.pause();
      });
    }

    const locBubble = row.querySelector("[data-loc-open]");
    if (locBubble) {
      locBubble.addEventListener("click", (e) => {
        if (e.target.closest("[data-stop-loc]")) return;
        if (typeof msg.lat === "number" && typeof msg.lng === "number") {
          window.open(LocationShare.mapsLink(msg.lat, msg.lng), "_blank", "noopener");
        }
      });
    }
    const stopBtn = row.querySelector("[data-stop-loc]");
    if (stopBtn) {
      stopBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        LocationShare.stopIfMine(stopBtn.dataset.stopLoc);
      });
    }

    return row;
  }

  function openMessageActions(msg) {
    const mine = msg.senderId === Utils.deviceId();
    Utils.showModal({
      title: "Message",
      bodyHtml: `
        <div style="display:flex;gap:10px;justify-content:center;margin-bottom:18px;">
          ${REACTIONS.map((e) => `<button class="icon-btn react-pick" data-e="${e}" style="width:42px;height:42px;font-size:19px;">${e}</button>`).join("")}
        </div>`,
      actions: [
        { label: "Reply", kind: "glass", onClick: (close) => { setReply(msg); close(); } },
        ...(mine ? [{ label: "Delete for me", kind: "danger", onClick: (close) => { deleteLocal(msg.id); close(); } }] : []),
      ],
    });
    document.querySelectorAll(".react-pick").forEach((btn) => {
      btn.addEventListener("click", () => {
        toggleReaction(msg.id, btn.dataset.e);
        document.getElementById("modalOverlay").classList.remove("show");
      });
    });
  }

  async function toggleReaction(messageId, emoji) {
    const msg = await DB.get("messages", messageId);
    if (!msg) return;
    msg.reactions = msg.reactions || {};
    const me = Utils.deviceId();
    const list = msg.reactions[emoji] || [];
    const idx = list.indexOf(me);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(me);
    msg.reactions[emoji] = list;
    await DB.put("messages", msg);
    Sync.broadcastRaw({ type: "REACTION", messageId, reactions: msg.reactions, sentAt: Utils.nowISO() });
    refresh();
  }

  function setReply(msg) {
    replyingTo = msg.id;
    $("#replyBar").style.display = "block";
    $("#replyBarText").textContent = "Replying to: " + (msg.text || mediaLabel(msg)).slice(0, 60);
  }
  function clearReply() {
    replyingTo = null;
    $("#replyBar").style.display = "none";
  }

  async function deleteLocal(id) {
    await DB.remove("messages", id);
    refresh();
    Utils.toast("Deleted for you");
  }

  async function sendText() {
    const input = $("#chatInput");
    const text = input.value.trim();
    if (!text) return;
    const record = {
      id: Utils.uid(),
      kind: "text",
      text,
      replyTo: replyingTo,
      reactions: {},
      status: "sent",
      senderId: Utils.deviceId(),
    };
    await DB.put("messages", record);
    input.value = "";
    autoGrow(input);
    clearReply();
    refresh();
    Sync.broadcastChat(record);
    scrollToBottom();
  }

  async function sendImage(file) {
    const kind = file.type && file.type.startsWith("video/") ? "video" : "image";
    const record = {
      id: Utils.uid(),
      kind,
      text: "",
      replyTo: replyingTo,
      reactions: {},
      status: "sent",
      senderId: Utils.deviceId(),
      blob: file,
    };
    await DB.put("messages", record);
    clearReply();
    refresh();
    Sync.broadcastChat({ ...record, blob: undefined });

    // Anything shared in chat also lands in Memories automatically —
    // this is a local-only save (no second network transfer), since
    // the bytes are already about to travel once via the chat file
    // transfer below.
    if (window.Memories) {
      Memories.saveLocalOnly({
        kind: kind === "video" ? "video" : "photo",
        blob: file,
        fileName: file.name,
        mime: file.type,
        size: file.size,
        caption: "Shared in chat",
      });
    }

    try {
      await WebRTCManager.sendFile(file, { kind: "chat-media", transferId: record.id, forId: record.id, mediaKind: kind });
    } catch (e) {
      Utils.toast(`${kind === "video" ? "Video" : "Photo"} saved — will send once you're both connected`);
    }
  }

  async function sendVoice(blob, duration) {
    const file = new File([blob], "voice.webm", { type: blob.type || "audio/webm" });
    const record = {
      id: Utils.uid(),
      kind: "voice",
      duration,
      replyTo: replyingTo,
      reactions: {},
      status: "sent",
      senderId: Utils.deviceId(),
      blob: file,
    };
    await DB.put("messages", record);
    clearReply();
    refresh();
    Sync.broadcastChat({ ...record, blob: undefined });
    try {
      await WebRTCManager.sendFile(file, { kind: "chat-media", transferId: record.id, forId: record.id, duration });
    } catch (e) {
      Utils.toast("Voice note saved — will send once you're both connected");
    }
  }

  function autoGrow(el) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 100) + "px";
  }

  function scrollToBottom() {
    const scroll = $("#chatScroll");
    requestAnimationFrame(() => (scroll.scrollTop = scroll.scrollHeight));
  }

  async function refresh() {
    const scroll = $("#chatScroll");
    if (!scroll) return;
    const msgs = await loadMessages();
    scroll.innerHTML = "";
    if (!msgs.length) {
      scroll.innerHTML = `<div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none"><path d="M21 12a8 8 0 01-11.5 7.2L4 20l1.1-4.2A8 8 0 1121 12z" stroke="white" stroke-width="1.4"/></svg>
        <div class="e-title">Say hello</div>
        <div class="e-sub">Your first message starts this space.</div>
      </div>`;
      return;
    }
    for (const m of msgs) {
      scroll.appendChild(await renderMessage(m));
    }
    scrollToBottom();
    markIncomingAsSeen(msgs);
  }

  function markIncomingAsSeen(msgs) {
    const me = Utils.deviceId();
    const unseenFromThem = msgs.filter((m) => m.senderId !== me && m.status !== "seen");
    if (!unseenFromThem.length) return;
    unseenFromThem.forEach((m) => (m.status = "seen"));
    Sync.broadcastRaw({ type: "SEEN", ids: unseenFromThem.map((m) => m.id), sentAt: Utils.nowISO() });
  }

  function showTyping(show) {
    $("#typingRow").style.display = show ? "flex" : "none";
    if (show) scrollToBottom();
  }

  async function handleIncomingMessage(packet) {
    const msg = packet.message;
    msg.status = "delivered";
    await DB.put("messages", msg);
    refresh();
    if (document.querySelector('.screen[data-screen="chat"]').classList.contains("active")) {
      Sync.broadcastRaw({ type: "SEEN", ids: [msg.id], sentAt: Utils.nowISO() });
    } else {
      Utils.toast("New message ♡");
    }
  }

  async function handleSeen(packet) {
    for (const id of packet.ids) {
      const m = await DB.get("messages", id);
      if (m && m.senderId === Utils.deviceId()) {
        m.status = "seen";
        await DB.put("messages", m);
      }
    }
    refresh();
  }

  async function handleReaction(packet) {
    const m = await DB.get("messages", packet.messageId);
    if (!m) return;
    m.reactions = packet.reactions;
    await DB.put("messages", m);
    refresh();
  }

  function handleFileEvent(evt) {
    if (evt.sending) return; // our own outgoing progress; ignore here
    if (!evt.meta || evt.meta.kind !== "chat-media") return;
    if (evt.phase === "complete") {
      DB.get("messages", evt.meta.forId).then((m) => {
        if (!m) return;
        m.blob = evt.blob;
        DB.put("messages", m).then(refresh);

        // Same auto-save as the sending side, so both people end up
        // with the photo/video in Memories without doing anything
        // extra. Voice notes also travel as "chat-media" but should
        // NOT land in Memories, so this checks the message's own kind
        // rather than trusting transfer metadata alone.
        if (window.Memories && (m.kind === "image" || m.kind === "video")) {
          Memories.saveLocalOnly({
            kind: m.kind === "video" ? "video" : "photo",
            blob: evt.blob,
            fileName: evt.meta.name,
            mime: evt.meta.mime,
            size: evt.meta.size,
            caption: "Shared in chat",
          });
        }
      });
    }
  }

  function initTypingUX() {
    const input = $("#chatInput");
    input.addEventListener("input", () => {
      autoGrow(input);
      Sync.broadcastRaw({ type: "TYPING", on: true });
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => Sync.broadcastRaw({ type: "TYPING", on: false }), 1500);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendText();
      }
    });
  }

  async function toggleVoiceRecording() {
    const btn = $("#chatVoiceBtn");
    if (!isRecording) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        recordedChunks = [];
        mediaRecorder = new MediaRecorder(stream);
        mediaRecorder.ondataavailable = (e) => recordedChunks.push(e.data);
        const startedAt = Date.now();
        mediaRecorder.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          const blob = new Blob(recordedChunks, { type: "audio/webm" });
          const secs = Math.round((Date.now() - startedAt) / 1000);
          const duration = `${Math.floor(secs / 60)}:${(secs % 60).toString().padStart(2, "0")}`;
          sendVoice(blob, duration);
        };
        mediaRecorder.start();
        isRecording = true;
        btn.style.background = "#fff";
        btn.querySelector("svg path,svg rect")?.setAttribute("stroke", "#000");
        Utils.toast("Recording… tap again to send");
      } catch (e) {
        Utils.toast("Microphone access is needed for voice messages");
      }
    } else {
      mediaRecorder.stop();
      isRecording = false;
      btn.style.background = "";
    }
  }

  async function openChatMenu() {
    const profile = await Settings.getProfile();
    const muted = !profile.notificationsEnabled;
    Utils.showModal({
      title: "Chat options",
      bodyHtml: `
        <div class="setting-row" id="chatMenuMemoriesRow" style="cursor:pointer;">
          <div class="sr-icon"><svg width="17" height="17" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke="white" stroke-width="1.4"/><circle cx="8.5" cy="10" r="1.3" stroke="white" stroke-width="1.2"/></svg></div>
          <div class="sr-body"><div class="sr-title">Shared Memories</div><div class="sr-sub">Every photo & video sent here, in one place</div></div>
          <svg class="sr-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <div class="setting-row" id="chatMenuMuteRow" style="cursor:pointer;">
          <div class="sr-icon"><svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9" stroke="white" stroke-width="1.4"/></svg></div>
          <div class="sr-body"><div class="sr-title">${muted ? "Unmute notifications" : "Mute notifications"}</div><div class="sr-sub">Applies to this whole space</div></div>
        </div>
      `,
      actions: [
        {
          label: "Clear chat for me",
          kind: "danger",
          onClick: async (close) => {
            close();
            const ok = await Utils.confirmModal({
              title: "Clear this chat?",
              sub: "Deletes every message on this device only — your partner keeps their copy, and nothing in Memories is affected.",
              confirmLabel: "Clear chat",
            });
            if (ok) {
              await DB.clearStore("messages");
              refresh();
              Utils.toast("Chat cleared on this device");
            }
          },
        },
      ],
    });
    $("#chatMenuMemoriesRow").addEventListener("click", () => {
      document.getElementById("modalOverlay").classList.remove("show");
      App.navigate("memories");
    });
    $("#chatMenuMuteRow").addEventListener("click", async () => {
      await Settings.saveProfile({ notificationsEnabled: muted });
      document.getElementById("modalOverlay").classList.remove("show");
      Utils.toast(muted ? "Notifications unmuted" : "Notifications muted");
    });
  }

  function init() {
    Sync.onType("MESSAGE", handleIncomingMessage);
    Sync.onType("SEEN", handleSeen);
    Sync.onType("REACTION", handleReaction);
    Sync.onType("TYPING", (p) => showTyping(!!p.on));
    WebRTCManager.on("file", handleFileEvent);

    $("#chatSendBtn").addEventListener("click", sendText);
    $("#cancelReplyBtn").addEventListener("click", clearReply);
    $("#chatAttachBtn").addEventListener("click", () => {
      Utils.showModal({
        title: "Share a photo or video",
        sub: "Pick one from this device, or send a generated sample to test how it looks. Anything shared here is saved to Memories automatically.",
        actions: [
          {
            label: "Send sample photo",
            kind: "glass",
            onClick: (close) => {
              close();
              const blob = Utils.makeSampleImageBlob("Sample photo ♡");
              const file = new File([blob], `sample-${Date.now()}.png`, { type: "image/png" });
              sendImage(file);
            },
          },
          {
            label: "Choose from device",
            kind: "primary",
            onClick: (close) => {
              close();
              $("#chatFileInput").click();
            },
          },
        ],
      });
    });
    $("#chatMenuBtn").addEventListener("click", openChatMenu);
    $("#chatFileInput").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) sendImage(file);
      e.target.value = "";
    });
    $("#chatVoiceBtn").addEventListener("click", toggleVoiceRecording);
    initTypingUX();
  }

  window.Chat = { init, refresh };
})();
