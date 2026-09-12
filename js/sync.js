/* =========================================================
   sync.js — routes packets between the two peers and keeps
   both IndexedDBs eventually consistent.

   Packet types (see brief):
   MESSAGE, NOTE_CREATE, NOTE_UPDATE, NOTE_DELETE,
   TASK_CREATE, TASK_UPDATE, TASK_DELETE,
   MEMORY_METADATA, FILE_START/CHUNK/END (handled in webrtc.js),
   PING, PONG

   Conflict handling: every synced record carries updatedAt +
   deviceId. When a packet for an existing id arrives, we only
   overwrite the local copy if the incoming updatedAt is newer
   (deterministic last-write-wins). Ties are broken by deviceId
   so both sides converge on the same winner.

   Offline handling: if the DataChannel isn't open when a change
   is made, the packet is stored in the `syncQueue` IndexedDB
   store instead of being sent. As soon as the peer reconnects,
   the queue is flushed in order, oldest first.
   ========================================================= */
(function () {
  "use strict";

  const storeForType = {
    NOTE_CREATE: "notes",
    NOTE_UPDATE: "notes",
    NOTE_DELETE: "notes",
    TASK_CREATE: "tasks",
    TASK_UPDATE: "tasks",
    TASK_DELETE: "tasks",
    MEMORY_METADATA: "memories",
  };

  const handlers = {}; // type -> [fn]

  function onType(type, fn) {
    (handlers[type] = handlers[type] || []).push(fn);
  }

  function dispatch(packet) {
    (handlers[packet.type] || []).forEach((fn) => {
      try {
        fn(packet);
      } catch (e) {
        Utils.log("handler error for", packet.type, e);
      }
    });
  }

  function isNewer(incoming, local) {
    if (!local) return true;
    if (incoming.updatedAt === local.updatedAt) {
      return (incoming.deviceId || "") > (local.deviceId || "");
    }
    return new Date(incoming.updatedAt) > new Date(local.updatedAt);
  }

  /**
   * Send (or queue) a change packet describing something the local
   * user just did. `record` must already be saved locally by the
   * caller before this is invoked.
   */
  async function broadcastChange(type, record) {
    const packet = { type, record, sentAt: Utils.nowISO() };
    const sent = WebRTCManager.isConnected() && WebRTCManager.sendData(packet);
    if (!sent) {
      await DB.put("syncQueue", { id: Utils.uid(), packet, queuedAt: Utils.nowISO() });
    }
  }

  function broadcastChat(message) {
    const packet = { type: "MESSAGE", message, sentAt: Utils.nowISO() };
    const sent = WebRTCManager.isConnected() && WebRTCManager.sendData(packet);
    if (!sent) {
      DB.put("syncQueue", { id: Utils.uid(), packet, queuedAt: Utils.nowISO() });
    }
    return sent;
  }

  function broadcastRaw(packet) {
    const sent = WebRTCManager.isConnected() && WebRTCManager.sendData(packet);
    if (!sent) {
      DB.put("syncQueue", { id: Utils.uid(), packet, queuedAt: Utils.nowISO() });
    }
    return sent;
  }

  async function flushQueue() {
    if (!WebRTCManager.isConnected()) return;
    const queued = await DB.getAll("syncQueue");
    queued.sort((a, b) => new Date(a.queuedAt) - new Date(b.queuedAt));
    for (const item of queued) {
      const ok = WebRTCManager.sendData(item.packet);
      if (ok) await DB.remove("syncQueue", item.id);
      else break; // connection dropped mid-flush; stop and retry next time
    }
    if (queued.length) Utils.log(`Flushed ${queued.length} queued changes`);
  }

  // ---- built-in handling for CRUD-style store packets ----
  async function applyStoreChange(packet) {
    const store = storeForType[packet.type];
    if (!store) return;
    const incoming = packet.record;
    if (packet.type.endsWith("_DELETE")) {
      await DB.remove(store, incoming.id);
      dispatch(packet);
      return;
    }
    const local = await DB.get(store, incoming.id);
    if (isNewer(incoming, local)) {
      await DB.putRaw(store, incoming);
    }
    dispatch(packet);
  }

  Object.keys(storeForType).forEach((type) => {
    onType(type, () => {}); // ensure key exists so external modules can push more handlers
  });

  function init() {
    WebRTCManager.on("message", (packet) => {
      if (storeForType[packet.type]) {
        applyStoreChange(packet);
      } else {
        dispatch(packet);
      }
    });
    WebRTCManager.on("state", ({ state }) => {
      if (state === "connected") flushQueue();
      dispatch({ type: "__CONN_STATE__", state });
    });
  }

  window.Sync = {
    onType,
    broadcastChange,
    broadcastChat,
    broadcastRaw,
    flushQueue,
    isNewer,
    init,
  };
})();
