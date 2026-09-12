/* =========================================================
   missyou.js — one-tap "thinking of you" ping.

   Sends a tiny MISS_YOU_PING packet straight over the open
   DataChannel — nothing is stored anywhere except a timestamp used
   to show "Alex missed you 5m ago" on Home, and a short send
   cooldown so it stays a sweet nudge rather than something that can
   be spammed.

   HONEST LIMITATION: like the rest of this app, this only works
   while both devices are actually connected. There is no push
   notification here — if your partner's app is fully closed, they
   won't feel a buzz until they reopen it, because true background
   push would require a server, which this app deliberately doesn't
   have. See webrtc.js for the same reasoning applied elsewhere.
   ========================================================= */
(function () {
  "use strict";

  const COOLDOWN_MS = 20000;
  const BANNER_VISIBLE_WINDOW_MS = 60 * 60000; // show "Xm ago" banner for up to an hour

  let cooldownUntil = 0;
  let cooldownTimer = null;

  function $(sel) {
    return document.querySelector(sel);
  }

  function relTime(iso) {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins === 1) return "1m ago";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    return `${hrs}h ago`;
  }

  function vibrate(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch {
      /* Vibration API isn't available on every device (notably iOS
         Safari) — this is just a nice-to-have, never required. */
    }
  }

  /**
   * Drops a handful of hearts that float up and fade — pure CSS
   * animation, cleans up after itself.
   */
  function burstHearts(count = 10) {
    const host = $("#heartBurstOverlay");
    if (!host) return;
    for (let i = 0; i < count; i++) {
      const el = document.createElement("div");
      el.className = "floating-heart";
      const size = 18 + Math.random() * 26;
      const left = 8 + Math.random() * 84;
      const delay = Math.random() * 0.5;
      const duration = 1.5 + Math.random() * 0.8;
      const rot = -20 + Math.random() * 40;
      el.style.left = left + "vw";
      el.style.width = size + "px";
      el.style.height = size + "px";
      el.style.animationDelay = delay + "s";
      el.style.animationDuration = duration + "s";
      el.style.setProperty("--rot", rot + "deg");
      el.innerHTML =
        '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7.5-4.6-10.1-9.1C.4 8.8 1.6 5 5.1 4.1 7.4 3.5 9.7 4.5 12 7c2.3-2.5 4.6-3.5 6.9-2.9 3.5.9 4.7 4.7 3.2 7.8C19.5 16.4 12 21 12 21z"/></svg>';
      host.appendChild(el);
      setTimeout(() => el.remove(), (delay + duration) * 1000 + 200);
    }
  }

  // ---------------- Sending ----------------
  function updateButtonState() {
    const btn = $("#missYouBtn");
    if (!btn) return;
    const label = $("#missYouLabel");
    const remaining = cooldownUntil - Date.now();
    if (remaining > 0) {
      btn.classList.add("on-cooldown");
      label.textContent = `Sent ♡ · wait ${Math.ceil(remaining / 1000)}s`;
    } else {
      btn.classList.remove("on-cooldown");
      label.textContent = "Send a little love";
      clearInterval(cooldownTimer);
    }
  }

  function startCooldown() {
    cooldownUntil = Date.now() + COOLDOWN_MS;
    updateButtonState();
    clearInterval(cooldownTimer);
    cooldownTimer = setInterval(() => {
      updateButtonState();
      if (Date.now() >= cooldownUntil) clearInterval(cooldownTimer);
    }, 1000);
  }

  function sendPing() {
    if (Date.now() < cooldownUntil) return;
    const sent = Sync.broadcastRaw({ type: "MISS_YOU_PING", sentAt: Utils.nowISO() });
    burstHearts(10);
    vibrate(30);
    Utils.toast(sent ? "Sent — they'll feel that ♡" : "Saved — they'll see it once you're both connected");
    startCooldown();
  }

  // ---------------- Receiving ----------------
  async function handleIncomingPing() {
    burstHearts(14);
    vibrate([20, 60, 20, 60, 40]);
    const profile = await Settings.getProfile();
    Utils.toast(`${profile.partnerName} is missing you ♡`);
    DB.flags.set("last_ping_received_at", Utils.nowISO());
    renderBanner();
  }

  async function renderBanner() {
    const banner = $("#pingBanner");
    if (!banner) return;
    const at = DB.flags.get("last_ping_received_at", null);
    if (!at || Date.now() - new Date(at).getTime() > BANNER_VISIBLE_WINDOW_MS) {
      banner.style.display = "none";
      return;
    }
    const profile = await Settings.getProfile();
    $("#pingBannerText").textContent = `${profile.partnerName} is missing you · ${relTime(at)}`;
    banner.style.display = "flex";
  }

  function dismissBanner() {
    DB.flags.remove("last_ping_received_at");
    $("#pingBanner").style.display = "none";
  }

  function init() {
    Sync.onType("MISS_YOU_PING", handleIncomingPing);
    $("#missYouBtn").addEventListener("click", sendPing);
    $("#pingBannerReplyBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      sendPing();
      dismissBanner();
    });
    $("#pingBannerDismissBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      dismissBanner();
    });
    updateButtonState();
  }

  window.MissYou = { init, renderBanner, updateButtonState };
})();
