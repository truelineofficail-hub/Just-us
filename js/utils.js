/* =========================================================
   utils.js — small shared helpers used across every module.
   No dependencies. Attaches everything to window.Utils.
   ========================================================= */
(function () {
  "use strict";

  // Set to false before shipping to production to silence debug logs.
  // This is the "production flag" referenced in the brief — it only
  // controls console noise, it has no effect on security.
  const DEBUG = false;

  function log(...args) {
    if (DEBUG) console.log("[JustUs]", ...args);
  }

  function uid() {
    // Good enough unique id for local records — not a security token.
    return (
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 10)
    );
  }

  let memoryDeviceId = null;
  function deviceId() {
    try {
      let id = localStorage.getItem("ju_device_id");
      if (!id) {
        id = uid();
        localStorage.setItem("ju_device_id", id);
      }
      return id;
    } catch {
      // localStorage blocked (e.g. sandboxed preview) — keep a stable
      // id for the lifetime of this tab instead of crashing.
      if (!memoryDeviceId) memoryDeviceId = uid();
      return memoryDeviceId;
    }
  }

  function nowISO() {
    return new Date().toISOString();
  }

  function formatTime(iso) {
    const d = new Date(iso);
    let h = d.getHours();
    const m = d.getMinutes().toString().padStart(2, "0");
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${m} ${ampm}`;
  }

  function formatRelative(iso) {
    const then = new Date(iso).getTime();
    const diff = Date.now() - then;
    const min = Math.floor(diff / 60000);
    if (min < 1) return "Just now";
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function daysTogether(startDateStr) {
    if (!startDateStr) return 0;
    const start = new Date(startDateStr + "T00:00:00");
    const now = new Date();
    const diff = Math.floor((now - start) / 86400000);
    return Math.max(diff, 0);
  }

  function escapeHtml(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function initials(name) {
    if (!name) return "?";
    return name.trim().charAt(0).toUpperCase();
  }

  function toast(message, ms = 2800) {
    const host = document.getElementById("toastHost");
    if (!host) return;
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  /**
   * Simple bottom-sheet modal.
   * opts: { title, sub, bodyHtml, actions:[{label, kind:'primary'|'glass'|'danger', onClick}] }
   * Returns a close() function.
   */
  function showModal(opts) {
    const overlay = document.getElementById("modalOverlay");
    const titleEl = document.getElementById("modalTitle");
    const subEl = document.getElementById("modalSub");
    const bodyEl = document.getElementById("modalBody");
    const actionsEl = document.getElementById("modalActions");

    titleEl.textContent = opts.title || "";
    subEl.textContent = opts.sub || "";
    subEl.style.display = opts.sub ? "block" : "none";
    bodyEl.innerHTML = opts.bodyHtml || "";
    actionsEl.innerHTML = "";

    function close() {
      overlay.classList.remove("show");
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);

    (opts.actions || []).forEach((a) => {
      const btn = document.createElement("button");
      btn.className =
        "btn " +
        (a.kind === "danger"
          ? "btn-danger-ghost"
          : a.kind === "glass"
          ? "btn-glass"
          : "btn-primary");
      btn.textContent = a.label;
      btn.addEventListener("click", () => {
        if (a.onClick) a.onClick(close);
        else close();
      });
      actionsEl.appendChild(btn);
    });

    overlay.classList.add("show");
    overlay.onclick = (e) => {
      if (e.target === overlay) close();
    };
    return close;
  }

  function confirmModal({ title, sub, confirmLabel = "Confirm", danger = true }) {
    return new Promise((resolve) => {
      showModal({
        title,
        sub,
        actions: [
          {
            label: "Cancel",
            kind: "glass",
            onClick: (close) => {
              close();
              resolve(false);
            },
          },
          {
            label: confirmLabel,
            kind: danger ? "danger" : "primary",
            onClick: (close) => {
              close();
              resolve(true);
            },
          },
        ],
      });
    });
  }

  function debounce(fn, wait) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  // Base64url helpers for compact code payloads
  function toBase64Url(str) {
    return btoa(unescape(encodeURIComponent(str)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }
  function fromBase64Url(b64) {
    let s = b64.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return decodeURIComponent(escape(atob(s)));
  }

  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsArrayBuffer(file);
    });
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  /**
   * Builds a short, pleasant three-note chime as a real playable WAV
   * Blob — entirely with math (PCM samples + a WAV header), no
   * network, no file access, no AudioContext/autoplay policy
   * involved. This exists so "Add a sample sound" always works
   * instantly, which also proves the play/pause/progress pipeline
   * itself is fine — useful for telling apart "my code is broken"
   * from "this browser/frame is blocking file access."
   */
  function makeSampleToneWavBlob() {
    const sampleRate = 44100;
    const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
    const noteDur = 0.22;
    const gap = 0.03;
    const totalDur = notes.length * (noteDur + gap) + 0.2;
    const numSamples = Math.floor(sampleRate * totalDur);
    const data = new Float32Array(numSamples);

    notes.forEach((freq, i) => {
      const startSample = Math.floor(i * (noteDur + gap) * sampleRate);
      const noteSamples = Math.floor(noteDur * sampleRate);
      for (let s = 0; s < noteSamples; s++) {
        const idx = startSample + s;
        if (idx >= numSamples) break;
        const t = s / sampleRate;
        const attack = Math.min(1, t / 0.015);
        const release = Math.min(1, (noteDur - t) / 0.08);
        const envelope = Math.max(0, Math.min(attack, release));
        data[idx] += Math.sin(2 * Math.PI * freq * t) * 0.28 * envelope;
      }
    });

    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);
    const writeString = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeString(0, "RIFF");
    view.setUint32(4, 36 + numSamples * 2, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, numSamples * 2, true);

    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
      const s = Math.max(-1, Math.min(1, data[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
    return new Blob([view], { type: "audio/wav" });
  }

  function dataUrlToBlob(dataUrl) {
    const [header, b64] = dataUrl.split(",");
    const mime = header.match(/:(.*?);/)[1];
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  /**
   * Draws a simple heart-on-gradient PNG on an offscreen canvas and
   * returns it as a Blob — synchronously, via toDataURL, no network
   * or file access needed. Used for "Add a sample photo" so the
   * Memories grid/preview flow can be proven out instantly.
   */
  function makeSampleImageBlob(label) {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 640;
    const ctx = canvas.getContext("2d");
    const grad = ctx.createLinearGradient(0, 0, 640, 640);
    grad.addColorStop(0, "#1a1a1a");
    grad.addColorStop(1, "#050505");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 640, 640);

    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath();
    const x = 320,
      y = 250;
    ctx.moveTo(x, y + 46);
    ctx.bezierCurveTo(x, y, x - 90, y, x - 90, y + 56);
    ctx.bezierCurveTo(x - 90, y + 120, x, y + 165, x, y + 220);
    ctx.bezierCurveTo(x, y + 165, x + 90, y + 120, x + 90, y + 56);
    ctx.bezierCurveTo(x + 90, y, x, y, x, y + 46);
    ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "26px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(label || "Sample memory", 320, 520);

    return dataUrlToBlob(canvas.toDataURL("image/png"));
  }

  /**
   * A tiny plain-text sample "document" Blob, for testing the Files
   * tab in Memories without needing real file-picker access.
   */
  function makeSampleTextBlob() {
    const text = "Just Us — sample file\n\nThis is a generated placeholder so you can test\nadding a file to Memories without picking a real one.";
    return new Blob([text], { type: "text/plain" });
  }

  window.Utils = {
    DEBUG,
    log,
    uid,
    deviceId,
    nowISO,
    formatTime,
    formatRelative,
    daysTogether,
    escapeHtml,
    initials,
    toast,
    showModal,
    confirmModal,
    debounce,
    toBase64Url,
    fromBase64Url,
    readFileAsDataURL,
    readFileAsArrayBuffer,
    formatBytes,
    makeSampleToneWavBlob,
    makeSampleImageBlob,
    makeSampleTextBlob,
  };
})();
