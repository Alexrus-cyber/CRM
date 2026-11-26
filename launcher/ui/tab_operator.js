import {
  apiJson,
  esc,
  formatDateTime,
  renderMarkdown,
  showToast,
  subscribeAppEvents,
  withHtQuery,
} from "/app.js";

export function mountOperatorTab(root, ctx) {
  const bootState = ctx.getState();
  const presets = bootState.presets || {};
  const opDefaults = bootState.localSettings?.operatorValues || {};

  const st = {
    subtab: "desk",
    tasks: [],
    selectedTaskId: 0,
    taskDetail: null,
    operatorRunning: Boolean(bootState.operatorRunning),
    planConvs: [],
    activePlanId: 0,
    planMessages: [],
    planSystemPrompt: "",
    connections: [],
    selectedConnId: 0,
    tokens: [],
    newTokenReveal: "",
    botStatus: null,
  };

  root.innerHTML = `
    <div class="col">
      <!-- Панель встроенного Оператора desktop_operator.py -->
      <div class="card-sm">
        <div class="row-between">
          <div class="row">
            <span id="op-proc-badge" class="badge">
              <span class="dot ${st.operatorRunning ? "dot-green" : "dot-gray"}"></span>
              Локальный Оператор: ${st.operatorRunning ? "слушает очередь" : "остановлен"}
            </span>
            <span id="op-bot-status-pill" class="muted" style="font-size:11px;"></span>
          </div>
          <div class="row">
            <button type="button" id="op-run-watch" class="btn btn-xs btn-emerald">▶ Слушать очередь CRM</button>
            <button type="button" id="op-run-once" class="btn btn-xs">▶ Выполнить 1 задачу</button>
            <button type="button" id="op-stop-proc" class="btn btn-xs btn-danger">⏹ Остановить</button>
          </div>
        </div>
      </div>

      <!-- Подвкладки Оператора -->
      <div class="subtabs-bar" role="tablist">
        <button type="button" class="subtab-btn active" data-op-subtab="desk">🖥 Пульт</button>
        <button type="button" class="subtab-btn" data-op-subtab="planner">📝 Планировщик</button>
        <button type="button" class="subtab-btn" data-op-subtab="runs">📋 Запуски</button>
        <button type="button" class="subtab-btn" data-op-subtab="setup">🔌 Подключение и настройки бота</button>
      </div>

      <!-- 1. Пульт -->
      <div id="op-panel-desk" class="op-subpanel">
        <div class="split-layout">
          <aside class="sidebar-col">
            <div class="card">
              <div style="font-weight:600; font-size:14px;" class="mb-2">Новое задание Оператору</div>
              <textarea id="op-new-prompt" class="textarea" rows="4" placeholder="Что бот должен сделать на вашем рабочем столе?"></textarea>
              <div class="grid-2 mt-2">
                <div>
                  <label class="field-label">Режим</label>
                  <select id="op-task-mode" class="select select-sm">
                    <option value="autonomous">Автономный</option>
                    <option value="copilot" selected>Помощник (copilot)</option>
                    <option value="game">Игровой (WASD/камера)</option>
                  </select>
                </div>
                <div>
                  <label class="field-label">Доверие</label>
                  <select id="op-trust" class="select select-sm">
                    <option value="verified">Проверенные</option>
                    <option value="full">Полное</option>
                    <option value="none">Минимальное</option>
                  </select>
                </div>
              </div>
              <div class="grid-2 mt-2">
                <div>
                  <label class="field-label">Советчик Агента</label>
                  <select id="op-coach" class="select select-sm">
                    <option value="agent">Включён (Агент)</option>
                    <option value="off">Выключен</option>
                  </select>
                </div>
                <div>
                  <label class="field-label">Макс. шагов</label>
                  <input id="op-max-steps" type="number" class="input input-sm" value="${esc(opDefaults.max_steps || 30)}" />
                </div>
              </div>
              <button type="button" id="op-create-task-btn" class="btn btn-primary mt-3" style="width:100%;">🚀 Отправить в очередь</button>
            </div>

            <div class="card">
              <div class="row-between mb-2">
                <div style="font-weight:600;">Очередь заданий</div>
                <button type="button" id="op-tasks-refresh" class="btn btn-xs">↻</button>
              </div>
              <div id="op-tasks-sidebar" class="item-list"></div>
            </div>
          </aside>

          <div class="main-col">
            <div class="card" id="op-task-detail-card">
              <div class="muted">Выберите задание слева или создайте новое.</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 2. Планировщик -->
      <div id="op-panel-planner" class="op-subpanel" hidden>
        <div class="split-layout">
          <aside class="sidebar-col">
            <div class="card">
              <div class="row-between mb-2">
                <div style="font-weight:600;">Чаты планирования</div>
                <button type="button" id="pl-new-btn" class="btn btn-xs btn-primary">+ Новый</button>
              </div>
              <div id="pl-conv-list" class="item-list"></div>
              <label class="field-label mt-2">Системный промпт чата</label>
              <textarea id="pl-sys-prompt" class="textarea" rows="3"></textarea>
              <button type="button" id="pl-save-sys" class="btn btn-xs mt-1">Сохранить промпт</button>
            </div>
          </aside>
          <div class="main-col">
            <div class="chat-box">
              <div id="pl-messages" class="chat-messages"></div>
              <div class="composer">
                <div class="row">
                  <textarea id="pl-input" class="textarea" style="flex:1; min-height:46px;" placeholder="Опишите задачу — модель составит точный пошаговый план для Оператора…"></textarea>
                  <button type="button" id="pl-send-btn" class="btn btn-primary" style="height:42px;">Составить план</button>
                  <button type="button" id="pl-launch-btn" class="btn btn-emerald" style="height:42px;">▶ В очередь Оператора</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 3. Запуски -->
      <div id="op-panel-runs" class="op-subpanel" hidden>
        <div class="card">
          <div class="row-between mb-2">
            <div style="font-weight:600; font-size:14px;">История запусков Оператора</div>
            <button type="button" id="op-runs-refresh" class="btn btn-xs">↻ Обновить</button>
          </div>
          <div id="op-runs-table-host" style="overflow-x:auto;"></div>
        </div>
      </div>

      <!-- 4. Подключение и локальные параметры -->
      <div id="op-panel-setup" class="op-subpanel" hidden>
        <div class="grid-2">
          <div class="card">
            <div style="font-weight:600; font-size:14px;" class="mb-2">🔌 Подключения и токены бота в CRM</div>
            <div id="op-conn-host"></div>
          </div>
          <div class="card">
            <div style="font-weight:600; font-size:14px;" class="mb-2">⚙ Параметры встроенного desktop_operator.py</div>
            <div class="grid-2">
              <div>
                <label class="field-label">Пресет модели</label>
                <select id="op-cfg-preset" class="select select-sm">
                  <option value="">— оставить текущую —</option>
                  ${Object.entries(presets).map(([k, p]) => `<option value="${esc(k)}">${esc(p.label)}</option>`).join("")}
                </select>
              </div>
              <div>
                <label class="field-label">Base URL</label>
                <input id="op-cfg-url" class="input input-sm" value="${esc(bootState.localSettings?.baseUrl || "")}" />
              </div>
            </div>
            <div class="grid-2 mt-2">
              <div>
                <label class="field-label">Модель (с vision)</label>
                <input id="op-cfg-model" class="input input-sm" value="${esc(bootState.localSettings?.model || "")}" />
              </div>
              <div>
                <label class="field-label">API ключ (если нужен)</label>
                <input id="op-cfg-key" type="password" class="input input-sm" />
              </div>
            </div>
            <div class="grid-2 mt-2">
              <div>
                <label class="field-label">Токен Оператора (автоподстановка из CRM)</label>
                <input id="op-cfg-token" type="password" class="input input-sm" value="${esc(opDefaults.crm_token || "")}" />
              </div>
              <div>
                <label class="field-label">Пауза между шагами (сек)</label>
                <input id="op-cfg-delay" type="number" step="0.2" class="input input-sm" value="${esc(opDefaults.delay ?? 1.2)}" />
              </div>
            </div>
            <div class="row mt-2" style="font-size:11.5px;">
              <label class="row"><input id="op-cfg-yes" type="checkbox" ${opDefaults.yes ? "checked" : ""} /> Без подтверждения шагов (--yes)</label>
              <label class="row"><input id="op-cfg-dry" type="checkbox" ${opDefaults.dry_run ? "checked" : ""} /> Холостой прогон (--dry-run)</label>
              <label class="row"><input id="op-cfg-textonly" type="checkbox" ${opDefaults.text_only ? "checked" : ""} /> Только текст (без скринов)</label>
            </div>
            <div class="mt-2">
              <label class="field-label">Разовое локальное задание (--task)</label>
              <div class="row">
                <input id="op-cfg-once-task" class="input input-sm" style="flex:1" placeholder="Например: открой калькулятор и посчитай 12*45" />
                <button type="button" id="op-run-task-btn" class="btn btn-sm btn-primary">▶ Выполнить</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  root.querySelectorAll("[data-op-subtab]").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.getAttribute("data-op-subtab");
      st.subtab = id;
      root.querySelectorAll("[data-op-subtab]").forEach((b) => b.classList.toggle("active", b.getAttribute("data-op-subtab") === id));
      root.querySelectorAll(".op-subpanel").forEach((p) => { p.hidden = p.id !== `op-panel-${id}`; });
      if (id === "planner") refreshPlans();
      if (id === "runs") refreshTasks();
      if (id === "setup") refreshConnections();
    };
  });

  function setOperatorBadge(running) {
    st.operatorRunning = Boolean(running);
    ctx.updateHeaderStatuses({ operatorRunning: st.operatorRunning });
    const b = root.querySelector("#op-proc-badge");
    if (b) {
      b.innerHTML = `<span class="dot ${st.operatorRunning ? "dot-green" : "dot-gray"}"></span> Локальный Оператор: ${st.operatorRunning ? "слушает очередь" : "остановлен"}`;
    }
  }

  function collectOperatorLaunchOpts(mode, extraTask = "") {
    const opts = {
      mode,
      task: extraTask,
      trust_level: root.querySelector("#op-trust").value,
      task_mode: root.querySelector("#op-task-mode").value === "game" ? "game" : "copilot",
      coach_mode: root.querySelector("#op-coach").value,
      max_steps: Number(root.querySelector("#op-max-steps").value || 30) || 30,
      delay: Number(root.querySelector("#op-cfg-delay").value || 1.2) || 1.2,
      yes: root.querySelector("#op-cfg-yes").checked,
      dry_run: root.querySelector("#op-cfg-dry").checked,
      text_only: root.querySelector("#op-cfg-textonly").checked,
    };
    const u = root.querySelector("#op-cfg-url").value.trim();
    const m = root.querySelector("#op-cfg-model").value.trim();
    const k = root.querySelector("#op-cfg-key").value.trim();
    const t = root.querySelector("#op-cfg-token").value.trim();
    if (u) opts.base_url = u;
    if (m) opts.model = m;
    if (k) opts.api_key = k;
    if (t) opts.crm_token = t;
    return opts;
  }

  root.querySelector("#op-run-watch").onclick = async () => {
    try {
      await apiJson("/api/app/operator/start", { method: "POST", body: JSON.stringify(collectOperatorLaunchOpts("watch")) });
      setOperatorBadge(true);
      showToast("Встроенный Оператор запущен в режиме очереди CRM", "ok");
    } catch (err) { showToast(err.message, "error"); }
  };
  root.querySelector("#op-run-once").onclick = async () => {
    try {
      await apiJson("/api/app/operator/start", { method: "POST", body: JSON.stringify(collectOperatorLaunchOpts("once")) });
      setOperatorBadge(true);
      showToast("Встроенный Оператор взял следующую задачу", "ok");
    } catch (err) { showToast(err.message, "error"); }
  };
  root.querySelector("#op-run-task-btn").onclick = async () => {
    const task = root.querySelector("#op-cfg-once-task").value.trim();
    if (!task) return showToast("Введите текст разового задания", "error");
    try {
      await apiJson("/api/app/operator/start", { method: "POST", body: JSON.stringify(collectOperatorLaunchOpts("task", task)) });
      setOperatorBadge(true);
      showToast("Оператор выполняет разовое задание", "ok");
    } catch (err) { showToast(err.message, "error"); }
  };
  root.querySelector("#op-stop-proc").onclick = async () => {
    await apiJson("/api/app/operator/stop", { method: "POST", body: "{}" });
    setOperatorBadge(false);
    showToast("Локальный Оператор остановлен", "info");
  };

  root.querySelector("#op-cfg-preset").onchange = (ev) => {
    const p = presets[ev.target.value];
    if (!p) return;
    if (p.base_url) root.querySelector("#op-cfg-url").value = p.base_url;
    if (p.model) root.querySelector("#op-cfg-model").value = p.model;
  };

  // ---- Очередь и Пульт ----
  async function refreshTasks() {
    try {
      const res = await apiJson("/api/agent/tasks");
      st.tasks = res.tasks || [];
      if (!st.selectedTaskId && st.tasks.length) {
        st.selectedTaskId = st.tasks[0].id;
      }
      renderTasksSidebar();
      renderRunsTable();
      if (st.selectedTaskId) await loadTaskDetail(st.selectedTaskId);
    } catch (err) { showToast(err.message, "error"); }
  }

  function renderTasksSidebar() {
    const host = root.querySelector("#op-tasks-sidebar");
    host.innerHTML = st.tasks.map((t) => `
      <div class="list-item ${t.id === st.selectedTaskId ? "active" : ""}" data-op-tid="${t.id}">
        <div style="min-width:0; flex:1;">
          <div style="font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">#${t.id} ${esc(t.prompt)}</div>
          <div class="muted" style="font-size:10px;">${esc(t.status)} · шаги: ${t.steps || 0}/${t.maxSteps || "∞"}</div>
        </div>
      </div>
    `).join("") || `<div class="muted" style="font-size:11px;">Заданий нет</div>`;
    host.querySelectorAll("[data-op-tid]").forEach((el) => {
      el.onclick = () => {
        st.selectedTaskId = Number(el.getAttribute("data-op-tid"));
        renderTasksSidebar();
        loadTaskDetail(st.selectedTaskId);
      };
    });
  }

  async function loadTaskDetail(id) {
    try {
      const res = await apiJson(`/api/agent/tasks/${id}`);
      st.taskDetail = res;
      renderTaskDetail();
    } catch {}
  }

  function renderTaskDetail() {
    const card = root.querySelector("#op-task-detail-card");
    const d = st.taskDetail;
    if (!d || !d.task) {
      card.innerHTML = `<div class="muted">Выберите задание слева</div>`;
      return;
    }
    const { task, events = [], latestScreen } = d;
    const isFinished = ["done", "failed", "cancelled"].includes(task.status);
    card.innerHTML = `
      <div class="row-between mb-2">
        <div>
          <div style="font-weight:700; font-size:14.5px;">Задание #${task.id} · <span class="badge ${task.status === "done" ? "badge-emerald" : task.status === "failed" ? "badge-red" : "badge-accent"}">${esc(task.status)}</span></div>
          <div class="muted" style="font-size:11px;">Режим: ${esc(task.taskMode)} · Доверие: ${esc(task.trustLevel)} · Шаги: ${task.steps || 0}/${task.maxSteps || "∞"}</div>
        </div>
        <div class="row">
          ${!isFinished ? `
            <button type="button" id="op-td-extend" class="btn btn-xs">+15 шагов</button>
            <button type="button" id="op-td-coach" class="btn btn-xs btn-primary">💡 Совет Агента</button>
            <button type="button" id="op-td-cancel" class="btn btn-xs btn-danger">Отменить</button>
          ` : ""}
        </div>
      </div>
      <div class="card-sm mb-2">${esc(task.prompt)}</div>
      ${task.result ? `<div class="alert-box alert-ok mb-2">${esc(task.result)}</div>` : ""}
      ${latestScreen ? `<div class="mb-2"><img src="${esc(latestScreen)}" class="screen-preview" alt="Последний скриншот" /></div>` : ""}
      ${task.status === "awaiting_approval" ? `
        <div class="approval-card mb-2">
          <b>Оператор ждёт подтверждения действия</b>
          <div class="row mt-2">
            <button type="button" id="op-td-approve" class="btn btn-sm btn-emerald">✓ Разрешить</button>
            <button type="button" id="op-td-reject" class="btn btn-sm btn-danger">✕ Отклонить</button>
          </div>
        </div>
      ` : ""}
      ${!isFinished ? `
        <div class="row mb-2">
          <input id="op-td-guidance" class="input input-sm" style="flex:1" placeholder="Отправить подсказку / инструкцию Оператору на ходу…" />
          <button type="button" id="op-td-send-guid" class="btn btn-sm btn-primary">Отправить</button>
        </div>
      ` : ""}
      <div style="font-weight:600; font-size:12px;" class="mb-1">Лента событий (${events.length})</div>
      <div class="col" style="max-height:360px; overflow-y:auto;">
        ${events.slice().reverse().slice(0, 80).map((e) => `
          <div class="card-sm">
            <div class="row-between">
              <span><b>${esc(e.kind)}</b> ${e.action ? `· ${esc(e.action)}` : ""}</span>
              <span class="muted" style="font-size:10.5px;">${esc(formatDateTime(e.createdAt))}</span>
            </div>
            ${e.text ? `<div class="mt-1" style="white-space:pre-wrap;">${esc(e.text)}</div>` : ""}
            ${e.fileName ? `<div class="mt-1"><a class="btn btn-xs" href="${esc(withHtQuery(`/api/agent/file/${e.id}`))}">⬇ ${esc(e.fileName)}</a></div>` : ""}
          </div>
        `).join("")}
      </div>
    `;

    const bind = (id, fn) => { const el = card.querySelector(id); if (el) el.onclick = fn; };
    bind("#op-td-cancel", async () => { await apiJson(`/api/agent/tasks/${task.id}`, { method: "POST", body: JSON.stringify({ action: "cancel" }) }); await loadTaskDetail(task.id); });
    bind("#op-td-extend", async () => { await apiJson(`/api/agent/tasks/${task.id}`, { method: "POST", body: JSON.stringify({ action: "extend_steps", addSteps: 15 }) }); await loadTaskDetail(task.id); });
    bind("#op-td-approve", async () => { await apiJson(`/api/agent/tasks/${task.id}`, { method: "POST", body: JSON.stringify({ action: "approve" }) }); await loadTaskDetail(task.id); });
    bind("#op-td-reject", async () => { await apiJson(`/api/agent/tasks/${task.id}`, { method: "POST", body: JSON.stringify({ action: "reject" }) }); await loadTaskDetail(task.id); });
    bind("#op-td-send-guid", async () => {
      const txt = card.querySelector("#op-td-guidance").value.trim();
      if (!txt) return;
      await apiJson(`/api/agent/tasks/${task.id}`, { method: "POST", body: JSON.stringify({ action: "guidance", text: txt }) });
      await loadTaskDetail(task.id);
    });
    bind("#op-td-coach", async () => {
      try {
        const res = await apiJson("/api/ai/agent/coach", {
          method: "POST",
          body: JSON.stringify({
            taskId: task.id,
            userHint: card.querySelector("#op-td-guidance")?.value || "",
            settings: {
              baseUrl: root.querySelector("#op-cfg-url").value.trim(),
              model: root.querySelector("#op-cfg-model").value.trim(),
              apiKey: root.querySelector("#op-cfg-key").value.trim(),
            },
          }),
        });
        showToast(res.adviceForUser || "Совет отправлен Оператору", "ok");
        await loadTaskDetail(task.id);
      } catch (err) { showToast(err.message, "error"); }
    });
  }

  function renderRunsTable() {
    const host = root.querySelector("#op-runs-table-host");
    host.innerHTML = st.tasks.length ? `
      <table class="data-table">
        <thead><tr><th>ID</th><th>Статус</th><th>Задание</th><th>Режим</th><th>Шаги</th><th></th></tr></thead>
        <tbody>
          ${st.tasks.map((t) => `
            <tr>
              <td>#${t.id}</td>
              <td><span class="badge">${esc(t.status)}</span></td>
              <td>${esc((t.prompt || "").slice(0, 110))}</td>
              <td>${esc(t.taskMode)}</td>
              <td>${t.steps || 0}/${t.maxSteps || "∞"}</td>
              <td><button type="button" class="btn btn-xs" data-open-task="${t.id}">Открыть</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    ` : `<div class="muted">Запусков пока нет</div>`;
    host.querySelectorAll("[data-open-task]").forEach((b) => {
      b.onclick = () => {
        st.selectedTaskId = Number(b.getAttribute("data-open-task"));
        root.querySelector('[data-op-subtab="desk"]').click();
        loadTaskDetail(st.selectedTaskId);
      };
    });
  }

  root.querySelector("#op-create-task-btn").onclick = async () => {
    const prompt = root.querySelector("#op-new-prompt").value.trim();
    if (!prompt) return showToast("Опишите задание", "error");
    try {
      const res = await apiJson("/api/agent/tasks", {
        method: "POST",
        body: JSON.stringify({
          prompt,
          taskMode: root.querySelector("#op-task-mode").value,
          trustLevel: root.querySelector("#op-trust").value,
          coachMode: root.querySelector("#op-coach").value,
          maxSteps: Number(root.querySelector("#op-max-steps").value || 30) || 30,
        }),
      });
      root.querySelector("#op-new-prompt").value = "";
      st.selectedTaskId = res.task.id;
      showToast(`Задание #${res.task.id} добавлено в очередь`, "ok");
      await refreshTasks();
    } catch (err) { showToast(err.message, "error"); }
  };
  root.querySelector("#op-tasks-refresh").onclick = refreshTasks;
  root.querySelector("#op-runs-refresh").onclick = refreshTasks;

  // ---- Планировщик ----
  async function refreshPlans() {
    try {
      const res = await apiJson("/api/agent/conversations?kind=plan");
      st.planConvs = res.conversations || [];
      const host = root.querySelector("#pl-conv-list");
      host.innerHTML = st.planConvs.map((c) => `
        <div class="list-item ${c.id === st.activePlanId ? "active" : ""}" data-pl-id="${c.id}">
          <div style="flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(c.title)}</div>
          <button type="button" class="btn btn-xs btn-ghost text-red" data-del-pl="${c.id}">✕</button>
        </div>
      `).join("") || `<div class="muted" style="font-size:11px;">Планов пока нет</div>`;
      host.querySelectorAll("[data-pl-id]").forEach((el) => {
        el.onclick = async (ev) => {
          if (ev.target.closest("[data-del-pl]")) return;
          st.activePlanId = Number(el.getAttribute("data-pl-id"));
          const det = await apiJson(`/api/agent/conversations/${st.activePlanId}`);
          st.planMessages = det.messages || [];
          st.planSystemPrompt = det.conversation?.systemPrompt || "";
          root.querySelector("#pl-sys-prompt").value = st.planSystemPrompt;
          renderPlanMessages();
          refreshPlans();
        };
      });
      host.querySelectorAll("[data-del-pl]").forEach((b) => {
        b.onclick = async (ev) => {
          ev.stopPropagation();
          await apiJson(`/api/agent/conversations/${b.getAttribute("data-del-pl")}`, { method: "DELETE" });
          await refreshPlans();
        };
      });
    } catch {}
  }

  function renderPlanMessages() {
    const h = root.querySelector("#pl-messages");
    h.innerHTML = st.planMessages.map((m) => `
      <div class="bubble ${m.role === "user" ? "bubble-user" : "bubble-assistant"}">
        <div class="bubble-meta"><span>${m.role === "user" ? "Вы" : "Планировщик"}</span></div>
        ${renderMarkdown(m.content || "")}
      </div>
    `).join("") || `<div class="card-2" style="padding:16px; margin:auto;">Опишите цель — модель составит пошаговый план для Оператора.</div>`;
    h.scrollTop = h.scrollHeight;
  }

  root.querySelector("#pl-new-btn").onclick = async () => {
    const res = await apiJson("/api/agent/conversations", { method: "POST", body: JSON.stringify({ kind: "plan", title: "Новый план" }) });
    st.activePlanId = res.conversation.id;
    st.planMessages = [];
    st.planSystemPrompt = res.conversation.systemPrompt || "";
    root.querySelector("#pl-sys-prompt").value = st.planSystemPrompt;
    await refreshPlans();
    renderPlanMessages();
  };
  root.querySelector("#pl-save-sys").onclick = async () => {
    if (!st.activePlanId) return;
    await apiJson(`/api/agent/conversations/${st.activePlanId}`, {
      method: "PATCH",
      body: JSON.stringify({ systemPrompt: root.querySelector("#pl-sys-prompt").value }),
    });
    showToast("Промпт сохранён", "ok");
  };
  root.querySelector("#pl-send-btn").onclick = async () => {
    const text = root.querySelector("#pl-input").value.trim();
    if (!text) return;
    if (!st.activePlanId) {
      const c = await apiJson("/api/agent/conversations", { method: "POST", body: JSON.stringify({ kind: "plan", title: text.slice(0, 60) }) });
      st.activePlanId = c.conversation.id;
    }
    root.querySelector("#pl-input").value = "";
    st.planMessages.push({ role: "user", content: text });
    renderPlanMessages();
    apiJson(`/api/agent/conversations/${st.activePlanId}/messages`, { method: "POST", body: JSON.stringify({ role: "user", content: text }) }).catch(() => {});
    try {
      const res = await apiJson("/api/agent/plan", {
        method: "POST",
        body: JSON.stringify({
          messages: st.planMessages.map((m) => ({ role: m.role, content: m.content })),
          systemPrompt: root.querySelector("#pl-sys-prompt").value,
          settings: {
            baseUrl: root.querySelector("#op-cfg-url").value.trim(),
            model: root.querySelector("#op-cfg-model").value.trim(),
            apiKey: root.querySelector("#op-cfg-key").value.trim(),
          },
        }),
      });
      const reply = res.reply || "";
      st.planMessages.push({ role: "assistant", content: reply });
      renderPlanMessages();
      apiJson(`/api/agent/conversations/${st.activePlanId}/messages`, { method: "POST", body: JSON.stringify({ role: "assistant", content: reply }) }).catch(() => {});
      await refreshPlans();
    } catch (err) { showToast(err.message, "error"); }
  };
  root.querySelector("#pl-launch-btn").onclick = () => {
    const lastPlan = [...st.planMessages].reverse().find((m) => m.role === "assistant")?.content || root.querySelector("#pl-input").value.trim();
    if (!lastPlan) return showToast("Сначала получите план", "error");
    root.querySelector("#op-new-prompt").value = lastPlan;
    root.querySelector('[data-op-subtab="desk"]').click();
  };

  // ---- Подключения и токены ----
  async function refreshConnections() {
    try {
      const [cRes, bRes] = await Promise.all([
        apiJson("/api/agent/connections"),
        apiJson("/api/agent/bot/status").catch(() => null),
      ]);
      st.connections = cRes.connections || [];
      st.botStatus = bRes;
      if (!st.selectedConnId && st.connections.length) st.selectedConnId = st.connections[0].id;
      if (st.selectedConnId) {
        const tRes = await apiJson(`/api/agent/tokens?connectionId=${st.selectedConnId}`).catch(() => ({ tokens: [] }));
        st.tokens = tRes.tokens || [];
      }
      renderConnections();
    } catch {}
  }

  function renderConnections() {
    const host = root.querySelector("#op-conn-host");
    const online = st.botStatus?.state === "online";
    const queued = st.botStatus?.queue?.queued ?? 0;
    const running = st.botStatus?.queue?.running ?? 0;
    host.innerHTML = `
      <div class="row-between mb-2">
        <span class="muted" style="font-size:11.5px;">Бот в сети: ${online ? `<b class="text-emerald">да</b>` : `нет (${esc(st.botStatus?.state || "не проверено")})`} · В очереди: ${queued} (в работе: ${running})</span>
        <button type="button" id="op-conn-refresh" class="btn btn-xs">↻ Проверить статус</button>
      </div>
      ${st.newTokenReveal ? `<div class="alert-box alert-ok mb-2">Новый токен: <span class="mono">${esc(st.newTokenReveal)}</span></div>` : ""}
      <div class="col mb-2">
        ${st.connections.map((c) => `
          <div class="list-item ${c.id === st.selectedConnId ? "active" : ""}" data-conn-id="${c.id}">
            <div><b>${esc(c.name)}</b> <span class="muted mono" style="font-size:10.5px;">${esc(c.serverUrl)}</span></div>
          </div>
        `).join("")}
      </div>
      <div class="row mb-2">
        <input id="op-new-tok-name" class="input input-sm" style="flex:1" placeholder="Имя токена (напр. Рабочий ПК)" />
        <button type="button" id="op-create-tok" class="btn btn-sm btn-primary">+ Токен</button>
      </div>
      <div class="col">
        ${st.tokens.map((t) => `
          <div class="card-sm row-between">
            <div><b>${esc(t.name)}</b> <span class="mono muted">${esc(t.hint)}</span></div>
            <div class="row">
              <button type="button" class="btn btn-xs" data-reissue-tok="${t.id}">Перевыпустить</button>
              <button type="button" class="btn btn-xs btn-danger" data-del-tok="${t.id}">✕</button>
            </div>
          </div>
        `).join("")}
      </div>
    `;
    host.querySelector("#op-conn-refresh").onclick = refreshConnections;
    host.querySelectorAll("[data-conn-id]").forEach((el) => {
      el.onclick = () => { st.selectedConnId = Number(el.getAttribute("data-conn-id")); refreshConnections(); };
    });
    host.querySelector("#op-create-tok").onclick = async () => {
      if (!st.selectedConnId) return;
      const name = host.querySelector("#op-new-tok-name").value.trim() || "CRM Desktop";
      const res = await apiJson("/api/agent/tokens", { method: "POST", body: JSON.stringify({ connectionId: st.selectedConnId, name }) });
      if (res.token) {
        st.newTokenReveal = res.token;
        root.querySelector("#op-cfg-token").value = res.token;
      }
      await refreshConnections();
    };
    host.querySelectorAll("[data-reissue-tok]").forEach((b) => {
      b.onclick = async () => {
        const res = await apiJson("/api/agent/tokens", { method: "POST", body: JSON.stringify({ action: "reissue", id: Number(b.getAttribute("data-reissue-tok")) }) });
        if (res.token) {
          st.newTokenReveal = res.token;
          root.querySelector("#op-cfg-token").value = res.token;
        }
        await refreshConnections();
      };
    });
    host.querySelectorAll("[data-del-tok]").forEach((b) => {
      b.onclick = async () => {
        await apiJson(`/api/agent/tokens?id=${b.getAttribute("data-del-tok")}`, { method: "DELETE" });
        await refreshConnections();
      };
    });
  }

  subscribeAppEvents((ev) => {
    if (ev?.scope === "agent" || ev?.scope === "operator") {
      refreshTasks();
    }
  });

  apiJson("/api/ai/settings").then((res) => {
    const s = res?.settings || {};
    const uEl = root.querySelector("#op-cfg-url");
    const mEl = root.querySelector("#op-cfg-model");
    const kEl = root.querySelector("#op-cfg-key");
    if (uEl && !uEl.value.trim() && s.baseUrl) uEl.value = s.baseUrl;
    if (mEl && !mEl.value.trim() && s.model) mEl.value = s.model;
    if (kEl && s.hasApiKey) kEl.placeholder = `В БД CRM: ${s.apiKeyHint || "сохранён"}`;
  }).catch(() => {});

  refreshTasks();
  return { refresh: refreshTasks };
}
