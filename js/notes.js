/* =========================================================
   notes.js — shared notes with checklists, pinning & search.
   Persisted in IndexedDB, synced peer-to-peer as NOTE_CREATE /
   NOTE_UPDATE / NOTE_DELETE packets, resolved last-write-wins.
   ========================================================= */
(function () {
  "use strict";

  let currentNoteId = null;
  let searchTerm = "";
  let saveTimer = null;

  function $(sel) {
    return document.querySelector(sel);
  }

  async function allNotes() {
    const notes = await DB.getAll("notes");
    return notes.sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });
  }

  function matchesSearch(note, term) {
    if (!term) return true;
    const hay = (note.title + " " + note.body + " " + (note.tags || []).join(" ")).toLowerCase();
    return hay.includes(term.toLowerCase());
  }

  function noteCardHtml(note) {
    let bodyHtml = "";
    if (note.checklist && note.checklist.length) {
      bodyHtml = `<div class="checklist-mini">${note.checklist
        .slice(0, 4)
        .map(
          (c) => `<div class="cl-row ${c.done ? "done" : ""}">
            <div class="chk ${c.done ? "checked" : ""}">${c.done ? "✓" : ""}</div>
            <span>${Utils.escapeHtml(c.text)}</span>
          </div>`
        )
        .join("")}</div>`;
    } else if (note.body) {
      bodyHtml = `<div class="nc-body">${Utils.escapeHtml(note.body).slice(0, 120)}</div>`;
    }
    return `
      <div class="glass-panel note-card" data-id="${note.id}">
        <div class="nc-top">
          <div class="nc-title">
            ${note.pinned ? `<svg class="pin-ic" viewBox="0 0 24 24" fill="none"><path d="M12 2l1.5 5.5L19 9l-4.5 3L16 18l-4-3.2L8 18l1.5-6L5 9l5.5-1.5L12 2z" stroke="currentColor" stroke-width="1.4"/></svg>` : ""}
            <span>${Utils.escapeHtml(note.title || "Untitled")}</span>
          </div>
          <button class="nc-menu icon-btn" style="width:26px;height:26px;" data-id="${note.id}" data-action="menu">⋮</button>
        </div>
        ${bodyHtml}
        <div class="nc-meta">Today · ${Utils.formatRelative(note.updatedAt)}</div>
      </div>`;
  }

  async function renderList() {
    const list = $("#notesList");
    if (!list) return;
    const notes = (await allNotes()).filter((n) => !n.archived && matchesSearch(n, searchTerm));
    if (!notes.length) {
      list.innerHTML = `<div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none"><path d="M6 3h9l5 5v13a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z" stroke="white" stroke-width="1.3"/></svg>
        <div class="e-title">No notes yet</div>
        <div class="e-sub">Tap + to write your first note together.</div>
      </div>`;
      return;
    }
    list.innerHTML = notes.map(noteCardHtml).join("");
    list.querySelectorAll(".note-card").forEach((card) => {
      card.addEventListener("click", (e) => {
        if (e.target.closest('[data-action="menu"]')) return;
        openEditor(card.dataset.id);
      });
    });
    list.querySelectorAll('[data-action="menu"]').forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openQuickMenu(btn.dataset.id);
      });
    });
  }

  async function openQuickMenu(id) {
    const note = await DB.get("notes", id);
    if (!note) return;
    Utils.showModal({
      title: note.title || "Untitled",
      actions: [
        {
          label: note.pinned ? "Unpin" : "Pin to top",
          kind: "glass",
          onClick: async (close) => {
            note.pinned = !note.pinned;
            await saveNote(note, "NOTE_UPDATE");
            close();
          },
        },
        {
          label: note.archived ? "Unarchive" : "Archive",
          kind: "glass",
          onClick: async (close) => {
            note.archived = !note.archived;
            await saveNote(note, "NOTE_UPDATE");
            close();
          },
        },
        {
          label: "Delete",
          kind: "danger",
          onClick: async (close) => {
            await DB.remove("notes", id);
            Sync.broadcastChange("NOTE_DELETE", { id });
            renderList();
            close();
          },
        },
      ],
    });
  }

  async function saveNote(note, changeType) {
    const saved = await DB.put("notes", note);
    Sync.broadcastChange(changeType, saved);
    renderList();
    return saved;
  }

  async function createNote() {
    const note = {
      id: Utils.uid(),
      title: "",
      body: "",
      checklist: [],
      pinned: false,
      archived: false,
      tags: [],
    };
    await DB.put("notes", note);
    Sync.broadcastChange("NOTE_CREATE", note);
    openEditor(note.id);
  }

  function renderChecklistEditor(note) {
    const wrap = $("#noteChecklistItems");
    wrap.innerHTML = (note.checklist || [])
      .map(
        (c) => `
      <div class="cl-row" data-cid="${c.id}" style="padding:6px 0;">
        <div class="chk ${c.done ? "checked" : ""}" data-toggle="${c.id}">${c.done ? "✓" : ""}</div>
        <input class="text-input" data-edit="${c.id}" style="border:none;background:none;padding:2px 0;flex:1;${c.done ? "color:var(--text-3);text-decoration:line-through;" : ""}" value="${Utils.escapeHtml(c.text)}" />
        <button data-remove="${c.id}" style="background:none;border:none;color:var(--text-3);padding:4px;">✕</button>
      </div>`
      )
      .join("");

    wrap.querySelectorAll("[data-toggle]").forEach((el) =>
      el.addEventListener("click", async () => {
        const cur = await DB.get("notes", currentNoteId);
        const item = cur.checklist.find((c) => c.id === el.dataset.toggle);
        item.done = !item.done;
        await saveNote(cur, "NOTE_UPDATE");
        renderChecklistEditor(cur);
      })
    );
    wrap.querySelectorAll("[data-edit]").forEach((el) =>
      el.addEventListener(
        "input",
        Utils.debounce(async () => {
          const cur = await DB.get("notes", currentNoteId);
          const item = cur.checklist.find((c) => c.id === el.dataset.edit);
          item.text = el.value;
          await saveNote(cur, "NOTE_UPDATE");
        }, 400)
      )
    );
    wrap.querySelectorAll("[data-remove]").forEach((el) =>
      el.addEventListener("click", async () => {
        const cur = await DB.get("notes", currentNoteId);
        cur.checklist = cur.checklist.filter((c) => c.id !== el.dataset.remove);
        await saveNote(cur, "NOTE_UPDATE");
        renderChecklistEditor(cur);
      })
    );
  }

  async function openEditor(id) {
    currentNoteId = id;
    const note = await DB.get("notes", id);
    if (!note) return;
    $("#noteTitleInput").value = note.title || "";
    $("#noteBodyInput").value = note.body || "";
    $("#noteMetaText").textContent = "Last edited " + Utils.formatRelative(note.updatedAt);
    $("#pinNoteBtn").style.opacity = note.pinned ? "1" : ".55";
    renderChecklistEditor(note);
    App.navigate("noteEditor");
  }

  function initEditorBindings() {
    const titleInput = $("#noteTitleInput");
    const bodyInput = $("#noteBodyInput");
    const debouncedSave = Utils.debounce(async () => {
      const note = await DB.get("notes", currentNoteId);
      if (!note) return;
      note.title = titleInput.value;
      note.body = bodyInput.value;
      const saved = await saveNote(note, "NOTE_UPDATE");
      $("#noteMetaText").textContent = "Last edited " + Utils.formatRelative(saved.updatedAt);
    }, 500);
    titleInput.addEventListener("input", debouncedSave);
    bodyInput.addEventListener("input", debouncedSave);

    $("#pinNoteBtn").addEventListener("click", async () => {
      const note = await DB.get("notes", currentNoteId);
      note.pinned = !note.pinned;
      await saveNote(note, "NOTE_UPDATE");
      $("#pinNoteBtn").style.opacity = note.pinned ? "1" : ".55";
      Utils.toast(note.pinned ? "Pinned" : "Unpinned");
    });

    $("#deleteNoteBtn").addEventListener("click", async () => {
      const ok = await Utils.confirmModal({
        title: "Delete this note?",
        sub: "This can't be undone on this device.",
        confirmLabel: "Delete",
      });
      if (!ok) return;
      await DB.remove("notes", currentNoteId);
      Sync.broadcastChange("NOTE_DELETE", { id: currentNoteId });
      App.navigate("notes");
    });

    $("#addChecklistItemBtn").addEventListener("click", async () => {
      const note = await DB.get("notes", currentNoteId);
      note.checklist = note.checklist || [];
      note.checklist.push({ id: Utils.uid(), text: "", done: false });
      await saveNote(note, "NOTE_UPDATE");
      renderChecklistEditor(note);
      const inputs = $("#noteChecklistItems").querySelectorAll("input");
      inputs[inputs.length - 1]?.focus();
    });

    $("#addNoteBtn").addEventListener("click", createNote);
    $("#noteSearchInput").addEventListener("input", (e) => {
      searchTerm = e.target.value;
      renderList();
    });
  }

  function handleRemoteChange() {
    renderList();
    if (currentNoteId && document.querySelector('.screen[data-screen="noteEditor"]').classList.contains("active")) {
      openEditor(currentNoteId);
    }
  }

  function init() {
    Sync.onType("NOTE_CREATE", handleRemoteChange);
    Sync.onType("NOTE_UPDATE", handleRemoteChange);
    Sync.onType("NOTE_DELETE", () => renderList());
    initEditorBindings();
  }

  window.Notes = { init, renderList };
})();
