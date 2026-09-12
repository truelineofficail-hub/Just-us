/* =========================================================
   memories.js — shared Photos & Files grid.

   A memory's small metadata (caption, filename, size) is announced
   instantly as a MEMORY_METADATA packet so a placeholder appears on
   the partner's screen right away. The actual bytes then stream over
   WebRTC's chunked file transfer (see webrtc.js) and are attached to
   the same record once fully received — this keeps big photos from
   ever blocking the rest of the sync traffic.
   ========================================================= */
(function () {
  "use strict";

  let activeTab = "photos";
  let progressToastEl = null;

  function $(sel) {
    return document.querySelector(sel);
  }

  async function allMemories() {
    const items = await DB.getAll("memories");
    return items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  function tileHtml(mem) {
    const url = mem.blob ? URL.createObjectURL(mem.blob) : null;
    if (mem.kind === "photo" || mem.kind === "video") {
      const media = !url
        ? `<div class="shimmer" style="width:100%;height:100%;"></div>`
        : mem.kind === "video"
        ? `<video src="${url}" muted preload="metadata"></video>`
        : `<img src="${url}" alt="${Utils.escapeHtml(mem.caption || "")}" />`;
      const playBadge =
        mem.kind === "video"
          ? `<div class="video-badge"><svg width="13" height="13" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7L8 5z"/></svg></div>`
          : "";
      return `
        <div class="memory-tile" data-id="${mem.id}">
          ${media}
          ${playBadge}
          ${mem.caption ? `<div class="cap">${Utils.escapeHtml(mem.caption)}</div>` : ""}
          <div class="del-x" data-del="${mem.id}">✕</div>
        </div>`;
    }
    return `
      <div class="memory-tile" data-id="${mem.id}" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M6 3h9l5 5v13a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z" stroke="white" stroke-width="1.3"/></svg>
        <span style="font-size:11px;color:var(--text-2);padding:0 8px;text-align:center;">${Utils.escapeHtml(mem.fileName || "File")}</span>
        <span style="font-size:10px;color:var(--text-3);">${mem.size ? Utils.formatBytes(mem.size) : ""}</span>
        <div class="del-x" data-del="${mem.id}">✕</div>
      </div>`;
  }

  async function render() {
    const items = await allMemories();
    const photos = items.filter((m) => m.kind === "photo" || m.kind === "video");
    const files = items.filter((m) => m.kind === "file");

    const photoGrid = $("#memoryGridPhotos");
    const fileGrid = $("#memoryGridFiles");

    photoGrid.innerHTML =
      photos.map(tileHtml).join("") +
      `<div class="memory-tile add-tile" id="addPhotoTile">
         <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
       </div>`;

    fileGrid.innerHTML =
      files.map(tileHtml).join("") +
      `<div class="memory-tile add-tile" id="addFileTile">
         <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
       </div>`;

    bindTileEvents(photoGrid);
    bindTileEvents(fileGrid);
    $("#addPhotoTile").addEventListener("click", () => $("#memoryFileInput").click());
    $("#addFileTile").addEventListener("click", () => $("#memoryDocInput").click());
  }

  function bindTileEvents(grid) {
    grid.querySelectorAll("[data-del]").forEach((el) =>
      el.addEventListener("click", async (e) => {
        e.stopPropagation();
        const ok = await Utils.confirmModal({ title: "Delete this memory?", confirmLabel: "Delete" });
        if (!ok) return;
        await DB.remove("memories", el.dataset.del);
        render();
      })
    );
    grid.querySelectorAll(".memory-tile[data-id]").forEach((tile) => {
      tile.addEventListener("click", async () => {
        const mem = await DB.get("memories", tile.dataset.id);
        if (mem && (mem.kind === "photo" || mem.kind === "video") && mem.blob) openPreview(mem);
      });
    });
  }

  function openPreview(mem) {
    const url = URL.createObjectURL(mem.blob);
    const media =
      mem.kind === "video"
        ? `<video src="${url}" controls playsinline style="width:100%;border-radius:16px;margin:6px 0;"></video>`
        : `<img src="${url}" style="width:100%;border-radius:16px;margin:6px 0;" />`;
    Utils.showModal({
      title: mem.caption || (mem.kind === "video" ? "Video" : "Photo"),
      bodyHtml: media,
      actions: [{ label: "Close", kind: "glass" }],
    });
  }

  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll(".tab-switch button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    $("#memoryGridPhotos").style.display = tab === "photos" ? "grid" : "none";
    $("#memoryGridFiles").style.display = tab === "files" ? "grid" : "none";
    const sampleBtn = $("#addSampleMemoryBtn");
    if (sampleBtn) sampleBtn.textContent = tab === "photos" ? "Add a sample photo" : "Add a sample file";
  }

  function showProgress(text) {
    if (!progressToastEl) {
      progressToastEl = document.createElement("div");
      progressToastEl.className = "progress-toast";
      document.getElementById("appShell").appendChild(progressToastEl);
    }
    progressToastEl.textContent = text;
  }
  function hideProgress() {
    if (progressToastEl) {
      progressToastEl.remove();
      progressToastEl = null;
    }
  }

  async function addPhoto(file, presetCaption) {
    const caption = presetCaption !== undefined ? presetCaption : await promptCaption();
    const isVideo = file.type && file.type.startsWith("video/");
    const record = {
      id: Utils.uid(),
      kind: isVideo ? "video" : "photo",
      caption: caption || "",
      fileName: file.name,
      mime: file.type,
      size: file.size,
      blob: file,
    };
    await DB.put("memories", record);
    render();
    Sync.broadcastChange("MEMORY_METADATA", { ...record, blob: undefined });
    transferMemoryFile(record.id, file);
  }

  async function addDoc(file) {
    const record = {
      id: Utils.uid(),
      kind: "file",
      caption: "",
      fileName: file.name,
      mime: file.type,
      size: file.size,
      blob: file,
    };
    await DB.put("memories", record);
    render();
    Sync.broadcastChange("MEMORY_METADATA", { ...record, blob: undefined });
    transferMemoryFile(record.id, file);
  }

  /**
   * Generates a real, guaranteed-to-work photo (or file) locally —
   * canvas-drawn PNG / plain text — with no file picker or network
   * involved. This is here so the Memories grid, preview modal, and
   * delete flow can all be verified instantly, separate from whether
   * this browser/frame allows picking a real file from disk.
   */
  async function addSampleForActiveTab() {
    if (activeTab === "photos") {
      const blob = Utils.makeSampleImageBlob("Sample memory ♡");
      const file = new File([blob], `sample-${Date.now()}.png`, { type: "image/png" });
      await addPhoto(file, "A generated sample photo");
      Utils.toast("Sample photo added");
    } else {
      const blob = Utils.makeSampleTextBlob();
      const file = new File([blob], `sample-note-${Date.now()}.txt`, { type: "text/plain" });
      await addDoc(file);
      Utils.toast("Sample file added");
    }
  }

  function promptCaption() {
    return new Promise((resolve) => {
      Utils.showModal({
        title: "Add a caption",
        sub: "Optional — you can leave this blank.",
        bodyHtml: `<input class="text-input" id="captionInput" placeholder="A little context for this memory…" />`,
        actions: [
          { label: "Skip", kind: "glass", onClick: (close) => { close(); resolve(""); } },
          {
            label: "Save",
            kind: "primary",
            onClick: (close) => {
              const v = document.getElementById("captionInput").value.trim();
              close();
              resolve(v);
            },
          },
        ],
      });
    });
  }

  /**
   * Stores a memory record directly, with no caption prompt and no
   * network broadcast/transfer. Used when a photo or video has
   * already traveled to the other device by some other means (right
   * now: chat) — this just mirrors a local copy into Memories on
   * both ends without sending the same bytes over WebRTC twice.
   */
  async function saveLocalOnly({ kind, blob, fileName, mime, size, caption }) {
    const record = {
      id: Utils.uid(),
      kind: kind === "video" ? "video" : "photo",
      caption: caption || "",
      fileName: fileName || "",
      mime: mime || "",
      size: size || (blob && blob.size) || 0,
      blob,
    };
    await DB.put("memories", record);
    render();
    return record;
  }

  async function transferMemoryFile(id, file) {
    if (!WebRTCManager.isConnected()) {
      Utils.toast("Saved — will share once you're both connected");
      return;
    }
    showProgress(`Sending ${file.name}… 0%`);
    try {
      await WebRTCManager.sendFile(file, { kind: "memory", forId: id });
      showProgress(`Sent ${file.name} ✓`);
      setTimeout(hideProgress, 1400);
    } catch {
      hideProgress();
      Utils.toast("Couldn't send — saved locally for now");
    }
  }

  function handleFileEvent(evt) {
    if (!evt.meta) return;
    if (evt.meta.kind !== "memory") return;
    if (evt.sending) {
      if (evt.phase === "progress") {
        const pct = Math.round((evt.sentBytes / evt.total) * 100);
        showProgress(`Sending… ${pct}%`);
      }
      return;
    }
    if (evt.phase === "start") {
      showProgress(`Receiving ${evt.meta.name}… 0%`);
      return;
    }
    if (evt.phase === "progress") {
      const pct = Math.round((evt.receivedBytes / evt.total) * 100);
      showProgress(`Receiving ${evt.meta.name}… ${pct}%`);
      return;
    }
    if (evt.phase === "complete") {
      hideProgress();
      DB.get("memories", evt.meta.forId).then(async (mem) => {
        if (!mem) {
          const mime = evt.meta.mime || "";
          mem = {
            id: evt.meta.forId,
            kind: mime.startsWith("video/") ? "video" : mime.startsWith("image/") ? "photo" : "file",
            fileName: evt.meta.name,
            mime,
            size: evt.meta.size,
            caption: "",
          };
        }
        mem.blob = evt.blob;
        await DB.putRaw("memories", mem);
        render();
        Utils.toast("Received a new memory ♡");
      });
    }
  }

  function init() {
    document.querySelectorAll(".tab-switch button").forEach((btn) =>
      btn.addEventListener("click", () => switchTab(btn.dataset.tab))
    );
    $("#memoryFileInput").addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (f) addPhoto(f);
      e.target.value = "";
    });
    $("#memoryDocInput").addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (f) addDoc(f);
      e.target.value = "";
    });
    Sync.onType("MEMORY_METADATA", render);
    WebRTCManager.on("file", handleFileEvent);
    $("#addSampleMemoryBtn").addEventListener("click", addSampleForActiveTab);
  }

  window.Memories = { init, render, saveLocalOnly };
})();
