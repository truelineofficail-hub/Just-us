/* =========================================================
   location.js — "Share Location" (current pin or live-for-a-while).

   Design choice, on purpose: this is NEVER background/automatic.
   Location only leaves the device when you open this screen and
   tap Send, and "live" sharing is always time-boxed with a visible
   end time and a one-tap Stop — the same shape as a normal chat
   messaging app's live location, not silent tracking. See the
   product conversation this was built from: continuous background
   location in a couples app is exactly the kind of feature that
   can quietly enable controlling behavior, so it's deliberately
   scoped out here.

   Transport: a location share is just a chat MESSAGE (kind:
   "location") — reuses Chat's existing send/receive plumbing.
   Live updates use two small extra packet types that update that
   one message in place: LOCATION_LIVE_UPDATE and LOCATION_LIVE_STOP.
   ========================================================= */
(function () {
  "use strict";

  const DURATIONS = { 15: 15 * 60000, 60: 60 * 60000, 480: 8 * 3600000 };
  let selected = "current";
  let lastKnownPosition = null;
  const activeLiveShares = new Map(); // messageId -> { watchId, timeoutId, expiresAt }

  function $(sel) {
    return document.querySelector(sel);
  }

  function getPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("Geolocation isn't available in this browser."));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
        (err) => reject(err),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 15000 }
      );
    });
  }

  function sampleLocation() {
    // A fixed, clearly-labeled demo pin (Eiffel Tower) — used when
    // geolocation is denied/unavailable, e.g. inside a sandboxed
    // preview frame, so the feature can still be tested end to end.
    return { lat: 48.8584, lng: 2.2945, accuracy: 30, sample: true };
  }

  function mapsLink(lat, lng) {
    return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
  }

  function fmtEndTime(expiresAt) {
    return new Date(expiresAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  // ---------------- Geometry (pure math, no map library needed) ----------------
  function toRad(deg) {
    return (deg * Math.PI) / 180;
  }
  function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function bearingDeg(lat1, lng1, lat2, lng2) {
    const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
    const x =
      Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
      Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
    return (Math.atan2(y, x) * 180) / Math.PI + 360;
  }
  function compassName(deg) {
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return dirs[Math.round(((deg % 360) / 45)) % 8];
  }
  function fmtDistance(km) {
    if (km < 1) return `${Math.round(km * 1000)} m`;
    if (km < 10) return `${km.toFixed(1)} km`;
    return `${Math.round(km)} km`;
  }

  // ---------------- Our Location (combined radar view) ----------------
  async function getLatestLocationFor(senderId) {
    const all = await DB.getAll("messages");
    const mine = all
      .filter((m) => m.kind === "location" && m.senderId === senderId)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    if (!mine.length) return null;
    const activeLive = mine.find((m) => m.live && (!m.expiresAt || new Date(m.expiresAt) > new Date()));
    return activeLive || mine[0];
  }

  async function renderOurLocation() {
    const profile = await Settings.getProfile();
    const me = Utils.deviceId();
    const [mine, theirs] = await Promise.all([getLatestLocationFor(me), findPartnerLocation(me)]);

    $("#radarLabelMe").textContent = profile.myName || "You";
    $("#radarLabelThem").textContent = profile.partnerName || "Partner";
    $("#ourLocMeTitle").textContent = profile.myName || "You";
    $("#ourLocThemTitle").textContent = profile.partnerName || "Partner";

    describeRow("#ourLocMeSub", mine);
    describeRow("#ourLocThemSub", theirs);

    const themPin = $("#radarPinThem");
    const shareBtn = $("#ourLocShareBtn");
    shareBtn.textContent = mine && mine.live ? "Update sharing" : "Share your location";

    if (!theirs || typeof theirs.lat !== "number") {
      themPin.style.display = "none";
      $("#radarSummaryText").textContent = mine
        ? `${profile.partnerName || "Your partner"} hasn't shared their location yet.`
        : "Neither of you has shared a location yet.";
      return;
    }

    themPin.style.display = "flex";
    if (!mine || typeof mine.lat !== "number") {
      $("#radarSummaryText").textContent = `${profile.partnerName || "Your partner"} shared their location — share yours to see how far apart you are.`;
      placePin(themPin, 0, 0.55); // no bearing reference without my own position; park at a fixed offset
      return;
    }

    const distKm = haversineKm(mine.lat, mine.lng, theirs.lat, theirs.lng);
    const bearing = bearingDeg(mine.lat, mine.lng, theirs.lat, theirs.lng);
    placePin(themPin, bearing, distanceToRadius(distKm));

    if (distKm < 0.1) {
      $("#radarSummaryText").textContent = "You're in the same place ♡";
    } else {
      $("#radarSummaryText").textContent = `${profile.partnerName || "Your partner"} is ${fmtDistance(distKm)} away, to the ${compassName(bearing)}`;
    }
  }

  function describeRow(sel, loc) {
    if (!loc) {
      $(sel).textContent = "No location shared yet";
      return;
    }
    const isLive = loc.live && (!loc.expiresAt || new Date(loc.expiresAt) > new Date());
    const when = Utils.formatRelative(loc.updatedAt || loc.createdAt);
    $(sel).textContent = isLive ? `Live · updating · last update ${when}` : `Last shared ${when}`;
  }

  // Distances are shown relatively, not to real-world scale — this is
  // a "which direction and roughly how far" glance, not a navigation
  // tool. A log curve keeps nearby vs far apart visually distinct
  // without the dot flying off-panel for long-distance pairs.
  function distanceToRadius(km) {
    const r = 0.22 + Math.log10(1 + km) * 0.2;
    return Math.min(0.9, Math.max(0.22, r));
  }

  function placePin(el, bearing, radiusFraction) {
    const panel = $(".radar-panel");
    const size = panel.clientWidth;
    const radiusPx = (size / 2) * radiusFraction;
    const angleRad = toRad(bearing); // 0 = N (up), clockwise
    const x = Math.sin(angleRad) * radiusPx;
    const y = -Math.cos(angleRad) * radiusPx;
    el.style.left = `calc(50% + ${x}px)`;
    el.style.top = `calc(50% + ${y}px)`;
  }

  async function findPartnerLocation(myId) {
    const all = await DB.getAll("messages");
    const theirs = all
      .filter((m) => m.kind === "location" && m.senderId !== myId)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    if (!theirs.length) return null;
    const activeLive = theirs.find((m) => m.live && (!m.expiresAt || new Date(m.expiresAt) > new Date()));
    return activeLive || theirs[0];
  }

  function refreshOurLocationIfActive() {
    if (document.querySelector('.screen[data-screen="ourLocation"]')?.classList.contains("active")) {
      renderOurLocation();
    }
  }

  // ---------------- Share Location screen ----------------
  async function enterScreen() {
    selected = "current";
    document.querySelectorAll(".loc-option").forEach((el) => el.classList.toggle("selected", el.dataset.loc === "current"));
    $("#locStatusText").textContent = "Finding your location…";
    try {
      lastKnownPosition = await getPosition();
      $("#locStatusText").textContent = lastKnownPosition.sample ? "Using a sample location" : "Location found";
    } catch (e) {
      lastKnownPosition = null;
      $("#locStatusText").textContent = "Couldn't get your location — allow location access, or use a sample pin below.";
    }
  }

  function selectOption(loc) {
    selected = loc;
    document.querySelectorAll(".loc-option").forEach((el) => el.classList.toggle("selected", el.dataset.loc === loc));
  }

  async function handleSend() {
    let pos = lastKnownPosition;
    if (!pos) {
      try {
        pos = await getPosition();
      } catch {
        Utils.toast("Location still unavailable — try the sample pin instead");
        return;
      }
    }
    if (selected === "current") {
      sendCurrentLocation(pos);
    } else {
      startLiveShare(DURATIONS[selected], pos);
    }
    App.navigate("chat");
  }

  function useSample() {
    lastKnownPosition = sampleLocation();
    $("#locStatusText").textContent = "Using a sample location";
    Utils.toast("Using a sample pin — real deployments will use your actual location");
  }

  // ---------------- Sending ----------------
  function sendCurrentLocation(pos) {
    const record = {
      id: Utils.uid(),
      kind: "location",
      lat: pos.lat,
      lng: pos.lng,
      accuracy: pos.accuracy,
      sample: !!pos.sample,
      live: false,
      senderId: Utils.deviceId(),
      status: "sent",
      reactions: {},
      replyTo: null,
    };
    DB.put("messages", record).then(() => {
      Chat.refresh();
      Sync.broadcastChat(record);
      Utils.toast("Location sent ♡");
      refreshOurLocationIfActive();
    });
  }

  function startLiveShare(durationMs, pos) {
    const expiresAt = Date.now() + durationMs;
    const record = {
      id: Utils.uid(),
      kind: "location",
      lat: pos.lat,
      lng: pos.lng,
      accuracy: pos.accuracy,
      sample: !!pos.sample,
      live: true,
      expiresAt: new Date(expiresAt).toISOString(),
      senderId: Utils.deviceId(),
      status: "sent",
      reactions: {},
      replyTo: null,
    };
    DB.put("messages", record).then((saved) => {
      Chat.refresh();
      Sync.broadcastChat(saved);
      Utils.toast(`Sharing live location until ${fmtEndTime(expiresAt)}`);
      beginWatch(saved.id, expiresAt);
      refreshOurLocationIfActive();
    });
  }

  function beginWatch(messageId, expiresAt) {
    let watchId = null;
    if (navigator.geolocation && !lastKnownPosition?.sample) {
      try {
        watchId = navigator.geolocation.watchPosition(
          (pos) => pushLiveUpdate(messageId, pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
          () => {},
          { enableHighAccuracy: true, maximumAge: 10000 }
        );
      } catch {
        /* fine — the initial pin still stands even if live watching fails */
      }
    }
    const timeoutId = setTimeout(() => stopLiveShare(messageId, true), Math.max(0, expiresAt - Date.now()));
    activeLiveShares.set(messageId, { watchId, timeoutId, expiresAt });
  }

  async function pushLiveUpdate(messageId, lat, lng, accuracy) {
    const msg = await DB.get("messages", messageId);
    if (!msg || !msg.live) return;
    msg.lat = lat;
    msg.lng = lng;
    msg.accuracy = accuracy;
    await DB.put("messages", msg);
    Sync.broadcastRaw({ type: "LOCATION_LIVE_UPDATE", messageId, lat, lng, accuracy, updatedAt: Utils.nowISO() });
    if (document.querySelector('.screen[data-screen="chat"]').classList.contains("active")) Chat.refresh();
    refreshOurLocationIfActive();
  }

  async function stopLiveShare(messageId, expired) {
    const share = activeLiveShares.get(messageId);
    if (share) {
      if (share.watchId != null) navigator.geolocation.clearWatch(share.watchId);
      clearTimeout(share.timeoutId);
      activeLiveShares.delete(messageId);
    }
    const msg = await DB.get("messages", messageId);
    if (msg) {
      msg.live = false;
      msg.endedAt = Utils.nowISO();
      await DB.put("messages", msg);
      Chat.refresh();
    }
    Sync.broadcastRaw({ type: "LOCATION_LIVE_STOP", messageId });
    if (!expired) Utils.toast("Stopped sharing your location");
    refreshOurLocationIfActive();
  }

  // ---------------- Receiving ----------------
  async function handleLiveUpdate(packet) {
    const msg = await DB.get("messages", packet.messageId);
    if (!msg) return;
    msg.lat = packet.lat;
    msg.lng = packet.lng;
    msg.accuracy = packet.accuracy;
    await DB.put("messages", msg);
    Chat.refresh();
    refreshOurLocationIfActive();
  }

  async function handleLiveStop(packet) {
    const msg = await DB.get("messages", packet.messageId);
    if (!msg) return;
    msg.live = false;
    msg.endedAt = Utils.nowISO();
    await DB.put("messages", msg);
    Chat.refresh();
    refreshOurLocationIfActive();
  }

  // Exposed for chat.js's message-action sheet (long-press → "Stop sharing").
  function stopIfMine(messageId) {
    return stopLiveShare(messageId, false);
  }

  function init() {
    document.querySelectorAll(".loc-option").forEach((el) =>
      el.addEventListener("click", () => selectOption(el.dataset.loc))
    );
    $("#locSendBtn").addEventListener("click", handleSend);
    $("#locUseSampleBtn").addEventListener("click", useSample);
    $("#chatLocationBtn").addEventListener("click", () => App.navigate("shareLocation"));
    $("#ourLocShareBtn").addEventListener("click", () => App.navigate("shareLocation"));
    Sync.onType("LOCATION_LIVE_UPDATE", handleLiveUpdate);
    Sync.onType("LOCATION_LIVE_STOP", handleLiveStop);
    Sync.onType("MESSAGE", (packet) => {
      if (packet.message && packet.message.kind === "location") refreshOurLocationIfActive();
    });
  }

  window.LocationShare = { init, enterScreen, stopIfMine, mapsLink, fmtEndTime, renderOurLocation };
})();
