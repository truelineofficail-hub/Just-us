/* =========================================================
   webrtc.js — peer connection + serverless "signaling".

   WHY MANUAL SIGNALING
   ---------------------
   WebRTC still needs *some* way for two devices to swap an SDP
   offer/answer before a direct connection can open. A normal app
   runs a small signaling server for that. This app has explicitly
   no backend and must run from GitHub Pages as static files, so
   there is nothing that can relay that first handshake for us.

   The closest valid backend-free architecture is manual signaling:
   we gather ICE candidates up front (non-trickle), pack the finished
   offer/answer into a single compact text "code", and let the two
   people move that code between their phones themselves — paste it
   in a chat app, AirDrop, read it aloud, whatever they already use.
   Once that one code has been exchanged, WebRTC's DataChannel takes
   over completely and every future message, note, task, photo, and
   file goes directly device-to-device, end-to-end, over the
   browser's own encrypted transport (DTLS/SRTP) — never through us,
   because there is no "us" to go through.

   MAX_PEERS = 2
   -------------
   There is no room server, so "room full" is enforced at the UX
   layer, not cryptographically: a space is just one RTCPeerConnection
   between two browsers. Once the creator has completed the
   offer → answer exchange with one partner, there is no third slot —
   the creator's single offer can only be answered once in this UI.
   ========================================================= */
(function () {
  "use strict";

  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  const CHUNK_SIZE = 16 * 1024; // 16KB — safe default for RTCDataChannel
  const ICE_GATHER_TIMEOUT_MS = 6000;

  let pc = null;
  let channel = null;
  let role = null; // 'host' | 'guest'
  let state = "idle"; // idle | connecting | waiting | connected | disconnected | reconnecting | failed
  let listeners = { state: [], message: [], file: [], call: [] };
  let incomingFiles = new Map(); // transferId -> { meta, chunks, receivedBytes }

  // ---- Voice/video call state ----
  // A call is just the SAME RTCPeerConnection carrying audio/video
  // tracks alongside the data channel — no new signaling server
  // needed, because the already-open data channel IS the signaling
  // channel for this renegotiation (unlike the very first connection,
  // which had nobody to carry that handshake for us).
  let callState = "idle"; // idle | outgoing | incoming | connected | ended | declined
  let isVideoCall = false;
  let localCallStream = null;
  let remoteCallStream = null;
  let pendingCallOffer = null; // { sdp, video } while an incoming call awaits accept/decline

  function emit(kind, payload) {
    listeners[kind].forEach((fn) => {
      try {
        fn(payload);
      } catch (e) {
        Utils.log("listener error", e);
      }
    });
  }

  function on(kind, fn) {
    listeners[kind].push(fn);
  }

  function setState(s, extra) {
    state = s;
    emit("state", { state: s, ...extra });
  }

  function closeExistingConnection() {
    // Called before starting a brand new Create/Join attempt so an old,
    // still-open (or half-open) RTCPeerConnection from a previous code
    // never lingers in memory and can never be accidentally completed
    // by a stale code arriving late.
    if (callState !== "idle") resetCallState("idle");
    try {
      if (channel) channel.close();
      if (pc) pc.close();
    } catch {}
    channel = null;
    pc = null;
  }

  function newPeerConnection() {
    const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    conn.oniceconnectionstatechange = () => {
      Utils.log("ice state:", conn.iceConnectionState);
      if (conn.iceConnectionState === "disconnected") {
        setState("reconnecting");
      } else if (conn.iceConnectionState === "failed") {
        setState("failed");
      } else if (conn.iceConnectionState === "closed") {
        setState("disconnected");
      }
    };
    // Fires when the partner's audio/video track starts arriving during
    // a call — see the CALL_* section below. Not related to the data
    // channel at all, just the media side of the same connection.
    conn.ontrack = (e) => {
      remoteCallStream = e.streams[0];
      emitCall("connected");
    };
    return conn;
  }

  function waitForIceGatheringComplete(conn) {
    return new Promise((resolve) => {
      if (conn.iceGatheringState === "complete") return resolve();
      const timer = setTimeout(() => resolve(), ICE_GATHER_TIMEOUT_MS);
      conn.onicegatheringstatechange = () => {
        if (conn.iceGatheringState === "complete") {
          clearTimeout(timer);
          resolve();
        }
      };
    });
  }

  function wireDataChannel(dc) {
    channel = dc;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      setState("connected");
      Utils.toast("Connected to your person ♡");
    };
    channel.onclose = () => {
      if (state !== "idle") setState("disconnected");
    };
    channel.onerror = (e) => Utils.log("channel error", e);
    channel.onmessage = (e) => handleIncoming(e.data);
  }

  function emitCall(phase, extra) {
    callState = phase;
    emit("call", { phase, video: isVideoCall, localStream: localCallStream, remoteStream: remoteCallStream, ...extra });
  }

  function resetCallState(phase) {
    if (localCallStream) {
      try {
        localCallStream.getTracks().forEach((t) => t.stop());
      } catch {}
    }
    localCallStream = null;
    remoteCallStream = null;
    pendingCallOffer = null;
    emitCall(phase);
    isVideoCall = false;
  }

  function handleIncoming(data) {
    let packet;
    try {
      packet = typeof data === "string" ? JSON.parse(data) : null;
    } catch {
      packet = null;
    }
    if (!packet) return;

    if (packet.type === "FILE_START") {
      incomingFiles.set(packet.transferId, {
        meta: packet.meta,
        chunks: [],
        receivedBytes: 0,
      });
      emit("file", { phase: "start", transferId: packet.transferId, meta: packet.meta });
      return;
    }
    if (packet.type === "FILE_CHUNK") {
      const f = incomingFiles.get(packet.transferId);
      if (!f) return;
      const binary = Utils.fromBase64Url(packet.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      f.chunks.push(bytes);
      f.receivedBytes += bytes.length;
      emit("file", {
        phase: "progress",
        transferId: packet.transferId,
        receivedBytes: f.receivedBytes,
        total: f.meta.size,
      });
      return;
    }
    if (packet.type === "FILE_END") {
      const f = incomingFiles.get(packet.transferId);
      if (!f) return;
      const blob = new Blob(f.chunks, { type: f.meta.mime || "application/octet-stream" });
      incomingFiles.delete(packet.transferId);
      emit("file", { phase: "complete", transferId: packet.transferId, meta: f.meta, blob });
      return;
    }
    if (packet.type === "PING") {
      sendData({ type: "PONG" });
      return;
    }
    if (packet.type === "PONG") return;

    if (packet.type === "CALL_OFFER") {
      pendingCallOffer = { sdp: packet.sdp, video: !!packet.video };
      isVideoCall = !!packet.video;
      emitCall("incoming");
      return;
    }
    if (packet.type === "CALL_ANSWER") {
      pc.setRemoteDescription({ type: "answer", sdp: packet.sdp })
        .then(() => emitCall("connected"))
        .catch((e) => Utils.log("call answer error", e));
      return;
    }
    if (packet.type === "CALL_DECLINE") {
      resetCallState("declined");
      setTimeout(() => emitCall("idle"), 1400);
      return;
    }
    if (packet.type === "CALL_HANGUP") {
      resetCallState("ended");
      setTimeout(() => emitCall("idle"), 1400);
      return;
    }

    emit("message", packet);
  }

  // ---------------- Host flow (Create Space) ----------------
  async function createRoom() {
    closeExistingConnection();
    role = "host";
    setState("connecting");
    pc = newPeerConnection();
    const dc = pc.createDataChannel("justus", { ordered: true });
    wireDataChannel(dc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);

    setState("waiting");

    const payload = {
      v: 1,
      role: "offer",
      roomId: Utils.uid(),
      sdp: pc.localDescription.sdp,
    };
    return Utils.toBase64Url(JSON.stringify(payload));
  }

  // Host: once the guest sends back their answer code, call this.
  async function completeAsHost(answerCode) {
    if (!pc) throw new Error("No active room to complete.");
    // A code can only ever be answered once: after the first answer is
    // applied, WebRTC's own signaling state moves past "have-local-offer"
    // and won't accept a second one. We check this explicitly up front
    // so a stale/reused code gives a clear message instead of a raw
    // browser exception.
    if (pc.signalingState !== "have-local-offer") {
      throw new Error("This space code has already been used — go back and create a new one.");
    }
    let payload;
    try {
      payload = JSON.parse(Utils.fromBase64Url(answerCode.trim()));
    } catch {
      throw new Error("That code doesn't look right.");
    }
    if (payload.role !== "answer") throw new Error("This isn't an answer code.");
    await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
    setState("connecting");
  }

  // ---------------- Guest flow (Join Space) ----------------
  async function joinRoom(offerCode) {
    let payload;
    try {
      payload = JSON.parse(Utils.fromBase64Url(offerCode.trim()));
    } catch {
      throw new Error("That code doesn't look right.");
    }
    if (payload.role !== "offer") {
      throw new Error("This isn't a space code — ask your partner for the Create Space code.");
    }

    closeExistingConnection();
    role = "guest";
    setState("connecting");
    pc = newPeerConnection();
    pc.ondatachannel = (e) => wireDataChannel(e.channel);

    await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(pc);

    const answerPayload = {
      v: 1,
      role: "answer",
      roomId: payload.roomId,
      sdp: pc.localDescription.sdp,
    };
    return Utils.toBase64Url(JSON.stringify(answerPayload));
  }

  // ---------------- Voice/video calls ----------------
  async function startCall(withVideo) {
    if (!isConnected()) throw new Error("You need to be connected to your partner first.");
    if (callState !== "idle") throw new Error("A call is already in progress.");
    isVideoCall = withVideo;
    localCallStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
    localCallStream.getTracks().forEach((track) => pc.addTrack(track, localCallStream));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendData({ type: "CALL_OFFER", sdp: pc.localDescription.sdp, video: withVideo });
    emitCall("outgoing");
  }

  async function acceptCall() {
    if (!pendingCallOffer) return;
    const { sdp, video } = pendingCallOffer;
    isVideoCall = video;
    await pc.setRemoteDescription({ type: "offer", sdp });
    localCallStream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
    localCallStream.getTracks().forEach((track) => pc.addTrack(track, localCallStream));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendData({ type: "CALL_ANSWER", sdp: pc.localDescription.sdp });
    pendingCallOffer = null;
    emitCall("connected");
  }

  function declineCall() {
    sendData({ type: "CALL_DECLINE" });
    resetCallState("idle");
  }

  function hangupCall() {
    sendData({ type: "CALL_HANGUP" });
    resetCallState("ended");
    setTimeout(() => emitCall("idle"), 1400);
  }

  function toggleMic(enabled) {
    if (localCallStream) localCallStream.getAudioTracks().forEach((t) => (t.enabled = enabled));
  }
  function toggleCamera(enabled) {
    if (localCallStream) localCallStream.getVideoTracks().forEach((t) => (t.enabled = enabled));
  }
  function getCallState() {
    return callState;
  }

  function sendData(obj) {
    if (!channel || channel.readyState !== "open") return false;
    channel.send(JSON.stringify(obj));
    return true;
  }

  async function sendFile(file, extraMeta = {}) {
    if (!channel || channel.readyState !== "open") {
      throw new Error("Not connected — this will need to be sent once you're both online.");
    }
    const transferId = Utils.uid();
    const buffer = await Utils.readFileAsArrayBuffer(file);
    const bytes = new Uint8Array(buffer);
    const meta = {
      name: file.name,
      size: bytes.length,
      mime: file.type,
      ...extraMeta,
    };
    sendData({ type: "FILE_START", transferId, meta });

    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
      const slice = bytes.subarray(offset, offset + CHUNK_SIZE);
      let binary = "";
      for (let i = 0; i < slice.length; i++) binary += String.fromCharCode(slice[i]);
      sendData({ type: "FILE_CHUNK", transferId, data: Utils.toBase64Url(binary) });
      emit("file", {
        phase: "progress",
        transferId,
        sending: true,
        sentBytes: Math.min(offset + CHUNK_SIZE, bytes.length),
        total: bytes.length,
      });
      // Yield to the event loop so large files don't block the UI thread.
      await new Promise((r) => setTimeout(r, 0));
    }
    sendData({ type: "FILE_END", transferId, meta });
    emit("file", { phase: "complete", transferId, sending: true, meta });
    return transferId;
  }

  function disconnect() {
    if (callState !== "idle") resetCallState("idle");
    try {
      if (channel) channel.close();
      if (pc) pc.close();
    } catch {}
    channel = null;
    pc = null;
    role = null;
    setState("idle");
  }

  function getState() {
    return state;
  }
  function isConnected() {
    return state === "connected" && channel && channel.readyState === "open";
  }

  window.WebRTCManager = {
    on,
    createRoom,
    completeAsHost,
    joinRoom,
    sendData,
    sendFile,
    disconnect,
    getState,
    isConnected,
    startCall,
    acceptCall,
    declineCall,
    hangupCall,
    toggleMic,
    toggleCamera,
    getCallState,
  };
})();
