/* =========================================================
   call.js — voice/video call UI on top of WebRTCManager's call
   plumbing (see webrtc.js for how the actual media negotiation
   works — this file only reacts to call state changes and drives
   the full-screen overlay).
   ========================================================= */
(function () {
  "use strict";

  let ringTimer = null;
  let durationTimer = null;
  let callStartedAt = null;
  let micOn = true;
  let camOn = true;

  function $(sel) {
    return document.querySelector(sel);
  }

  function fmtDuration(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = (s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  }

  function showOverlay() {
    $("#callOverlay").classList.add("show");
  }
  function hideOverlay() {
    $("#callOverlay").classList.remove("show");
    $("#callOverlay").classList.remove("video-mode", "connected");
  }

  function setActionRow(which) {
    $("#callIncomingActions").style.display = which === "incoming" ? "flex" : "none";
    $("#callConnectedActions").style.display = which === "connected" ? "flex" : "none";
    $("#callOutgoingActions").style.display = which === "outgoing" ? "flex" : "none";
  }

  async function openChooser() {
    if (!WebRTCManager.isConnected()) {
      Utils.toast("You need to be connected to your partner first");
      return;
    }
    const profile = await Settings.getProfile();
    Utils.showModal({
      title: `Call ${profile.partnerName || "your partner"}`,
      actions: [
        {
          label: "🎥 Video call",
          kind: "primary",
          onClick: (close) => {
            close();
            place(true);
          },
        },
        {
          label: "📞 Voice call",
          kind: "glass",
          onClick: (close) => {
            close();
            place(false);
          },
        },
      ],
    });
  }

  async function place(withVideo) {
    try {
      await WebRTCManager.startCall(withVideo);
    } catch (e) {
      Utils.toast(e.message || "Couldn't start the call — check camera/microphone access");
    }
  }

  async function onCallEvent(evt) {
    const profile = await Settings.getProfile();
    $("#callName").textContent = profile.partnerName || "Partner";
    $("#callAvatar").textContent = Utils.initials(profile.partnerName);

    const overlay = $("#callOverlay");
    overlay.classList.toggle("video-mode", !!evt.video);

    if (evt.phase === "outgoing") {
      showOverlay();
      overlay.classList.remove("connected");
      $("#callStatusText").textContent = evt.video ? "Video calling…" : "Calling…";
      setActionRow("outgoing");
    } else if (evt.phase === "incoming") {
      showOverlay();
      overlay.classList.remove("connected");
      $("#callStatusText").textContent = evt.video ? "Incoming video call…" : "Incoming call…";
      setActionRow("incoming");
      vibrateRing();
    } else if (evt.phase === "connected") {
      showOverlay();
      overlay.classList.add("connected");
      setActionRow("connected");
      attachStreams(evt.localStream, evt.remoteStream);
      if (!callStartedAt) {
        callStartedAt = Date.now();
        durationTimer = setInterval(() => {
          $("#callStatusText").textContent = fmtDuration(Date.now() - callStartedAt);
        }, 1000);
      }
      $("#callCameraBtn").style.display = evt.video ? "flex" : "none";
      clearInterval(ringTimer);
    } else if (evt.phase === "declined") {
      $("#callStatusText").textContent = "Call declined";
      setActionRow("none");
      cleanupAfterDelay();
    } else if (evt.phase === "ended") {
      $("#callStatusText").textContent = "Call ended";
      setActionRow("none");
      cleanupAfterDelay();
    } else if (evt.phase === "idle") {
      hideOverlay();
      resetLocalState();
    }
  }

  function attachStreams(localStream, remoteStream) {
    const localVideo = $("#callLocalVideo");
    const remoteVideo = $("#callRemoteVideo");
    const remoteAudio = $("#callRemoteAudio");
    if (localStream && localVideo.srcObject !== localStream) localVideo.srcObject = localStream;
    if (remoteStream) {
      if (remoteVideo.srcObject !== remoteStream) remoteVideo.srcObject = remoteStream;
      if (remoteAudio.srcObject !== remoteStream) remoteAudio.srcObject = remoteStream;
    }
  }

  function cleanupAfterDelay() {
    clearInterval(durationTimer);
    durationTimer = null;
    callStartedAt = null;
  }

  function resetLocalState() {
    micOn = true;
    camOn = true;
    $("#callMuteBtn").classList.remove("active");
    $("#callCameraBtn").classList.remove("active");
    $("#callLocalVideo").srcObject = null;
    $("#callRemoteVideo").srcObject = null;
    $("#callRemoteAudio").srcObject = null;
  }

  function vibrateRing() {
    try {
      navigator.vibrate && navigator.vibrate([300, 200, 300, 200, 300]);
    } catch {}
  }

  function init() {
    WebRTCManager.on("call", onCallEvent);

    $("#chatCallBtn").addEventListener("click", openChooser);
    $("#callAcceptBtn").addEventListener("click", async () => {
      try {
        await WebRTCManager.acceptCall();
      } catch (e) {
        Utils.toast("Couldn't join the call — check camera/microphone access");
        WebRTCManager.declineCall();
      }
    });
    $("#callDeclineBtn").addEventListener("click", () => WebRTCManager.declineCall());
    $("#callCancelBtn").addEventListener("click", () => WebRTCManager.hangupCall());
    $("#callHangupBtn").addEventListener("click", () => WebRTCManager.hangupCall());

    $("#callMuteBtn").addEventListener("click", () => {
      micOn = !micOn;
      WebRTCManager.toggleMic(micOn);
      $("#callMuteBtn").classList.toggle("active", !micOn);
    });
    $("#callCameraBtn").addEventListener("click", () => {
      camOn = !camOn;
      WebRTCManager.toggleCamera(camOn);
      $("#callCameraBtn").classList.toggle("active", !camOn);
    });
  }

  window.Call = { init };
})();
