/* =========================================================
   tasks.js — shared to-do list, synced as TASK_CREATE / _UPDATE /
   _DELETE packets with the same last-write-wins rule as notes.
   ========================================================= */
(function () {
  "use strict";

  function $(sel) {
    return document.querySelector(sel);
  }

  async function allTasks() {
    const tasks = await DB.getAll("tasks");
    return tasks.sort((a, b) => {
      if (!!a.done !== !!b.done) return a.done ? 1 : -1;
      return new Date(a.createdAt) - new Date(b.createdAt);
    });
  }

  function rowHtml(task) {
    return `
      <div class="task-row ${task.done ? "done" : ""}" data-id="${task.id}">
        <div class="task-check ${task.done ? "checked" : ""}" data-toggle="${task.id}">
          ${task.done ? '<svg viewBox="0 0 24 24" fill="none"><path d="M4 12l5 5L20 6" stroke="black" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ""}
        </div>
        <input class="t-text edit-input" data-edit="${task.id}" value="${Utils.escapeHtml(task.text)}" />
        <span data-del="${task.id}" class="task-del">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m1 0v13a1 1 0 01-1 1H8a1 1 0 01-1-1V7h10z" stroke="currentColor" stroke-width="1.4"/></svg>
        </span>
      </div>`;
  }

  async function render() {
    const list = $("#taskList");
    if (!list) return;
    const tasks = await allTasks();
    if (!tasks.length) {
      list.innerHTML = `<div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none"><path d="M9 11l2.5 2.5L16 8" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><rect x="3.5" y="3.5" width="17" height="17" rx="4" stroke="white" stroke-width="1.3"/></svg>
        <div class="e-title">Nothing to do yet</div>
        <div class="e-sub">Add your first shared task below.</div>
      </div>`;
      return;
    }
    list.innerHTML = tasks.map(rowHtml).join("");

    list.querySelectorAll("[data-toggle]").forEach((el) =>
      el.addEventListener("click", async () => {
        const task = await DB.get("tasks", el.dataset.toggle);
        task.done = !task.done;
        await saveTask(task, "TASK_UPDATE");
      })
    );
    list.querySelectorAll("[data-edit]").forEach((el) => {
      el.style.background = "none";
      el.style.border = "none";
      el.style.color = "inherit";
      el.style.font = "inherit";
      el.addEventListener(
        "change",
        Utils.debounce(async () => {
          const task = await DB.get("tasks", el.dataset.edit);
          task.text = el.value;
          await saveTask(task, "TASK_UPDATE", false);
        }, 300)
      );
    });
    list.querySelectorAll("[data-del]").forEach((el) =>
      el.addEventListener("click", async () => {
        await DB.remove("tasks", el.dataset.del);
        Sync.broadcastChange("TASK_DELETE", { id: el.dataset.del });
        render();
      })
    );
  }

  async function saveTask(task, changeType, rerender = true) {
    const saved = await DB.put("tasks", task);
    Sync.broadcastChange(changeType, saved);
    if (rerender) render();
    return saved;
  }

  async function addTask() {
    const input = $("#taskInput");
    const text = input.value.trim();
    if (!text) return;
    const task = { id: Utils.uid(), text, done: false };
    await DB.put("tasks", task);
    Sync.broadcastChange("TASK_CREATE", task);
    input.value = "";
    render();
  }

  function init() {
    Sync.onType("TASK_CREATE", render);
    Sync.onType("TASK_UPDATE", render);
    Sync.onType("TASK_DELETE", render);
    $("#taskAddBtn").addEventListener("click", addTask);
    $("#taskInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") addTask();
    });
  }

  window.Tasks = { init, render };
})();
