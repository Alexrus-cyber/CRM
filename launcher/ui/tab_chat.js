import {
  apiFetch,
  apiJson,
  consumeSseStream,
  esc,
  formatBytes,
  formatTokens,
  readBrowserFileToAttachment,
  readClipboardImages,
  renderMarkdown,
  showToast,
} from "/app.js";

function splitIntoChunks(text, chunkSize = 1800, overlap = 200) {
  const clean = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  const out = [];
  let i = 0;
  while (i < clean.length) {
    out.push(clean.slice(i, i + chunkSize));
    if (i + chunkSize >= clean.length) break;
    i += Math.max(200, chunkSize - overlap);
  }
  return out;
}

export function mountChatTab(root, ctx) {
  const bootState = ctx.getState();
  const profile = bootState.profile || {};
  const limits = profile.limits || {};
  const presets = bootState.presets || {};
  const reasoningModes = bootState.reasoningModes || [];

  const st = {
    chats: [],
    activeChatId: 0,
    messages: [],
    ragFolders: [],
    selectedRagId: 0,
    ragQuery: "",
    ragSearchHits: [],
    models: [],
    capabilitiesByModel: {},
    pendingFiles: [],
    streaming: false,
    abortCtrl: null,
    showSettings: false,
    settings: {
      baseUrl: bootState.localSettings?.baseUrl || "http://127.0.0.1:1234/v1",
      apiKey: "",
      model: bootState.localSettings?.model || "",
      hasSavedKey: false,
      apiKeyHint: "",
    },
    params: {
      system: "Ты — ассистент внутри CRM. Отвечай кратко и по делу, на русском языке.",
      temperature: null,
      topP: null,
      maxTokens: null,
      seed: null,
      reasoning: "default",
      thinkingBudget: null,
      sendThinkingFlag: true,
      ragChunks: 8,
      ragFull: false,
      contextLimit: 0,
      streamUsage: true,
    },
    monthlyUsed: limits.monthlyUsed || 0,
    monthlyLimit: limits.monthlyTokens,
  };

  root.innerHTML = `
    <div class="split-layout">
      <aside class="sidebar-col">
        <div class="card">
          <div class="row-between mb-2">
            <div>
              <div style="font-weight:600;">Диалоги</div>
              <div class="muted" style="font-size:11px;">Синхронизировано с БД сайта</div>
            </div>
            <button type="button" id="chat-new-btn" class="btn btn-sm btn-primary">+ Новый</button>
          </div>
          <div id="chat-list" class="item-list"></div>
        </div>

        <div class="card" id="chat-rag-card" ${limits.rag === false ? 'style="opacity:0.6"' : ""}>
          <div class="row-between mb-2">
            <div>
              <div style="font-weight:600;">База знаний (RAG)</div>
              <div class="muted" style="font-size:11px;">${limits.rag === false ? "Недоступно для вашей роли" : "Папки с документами"}</div>
            </div>
            <button type="button" id="rag-refresh-btn" class="btn btn-xs">↻</button>
          </div>
          <div class="row mb-2">
            <input id="rag-new-name" class="input input-sm" style="flex:1" placeholder="Новая папка RAG" ${limits.rag === false ? "disabled" : ""} />
            <button type="button" id="rag-create-btn" class="btn btn-sm" ${limits.rag === false ? "disabled" : ""}>+</button>
          </div>
          <div id="rag-folder-list" class="item-list" style="max-height:170px;"></div>
          <div class="row mt-2" ${limits.rag === false ? 'style="display:none"' : ""}>
            <label class="btn btn-sm" style="flex:1; cursor:pointer;">
              📄 Загрузить файлы
              <input id="rag-files-input" type="file" multiple hidden />
            </label>
            <label class="btn btn-sm" style="flex:1; cursor:pointer;">
              📁 Папка ПК
              <input id="rag-dir-input" type="file" webkitdirectory directory multiple hidden />
            </label>
          </div>
          <div id="rag-upload-status" class="muted mt-1" style="font-size:11px;"></div>

          <div class="mt-2" ${limits.rag === false ? 'style="display:none"' : ""}>
            <div class="row">
              <input id="rag-search-q" class="input input-sm" style="flex:1" placeholder="Проверить поиск в папке…" />
              <button type="button" id="rag-search-btn" class="btn btn-xs">Найти</button>
            </div>
            <div id="rag-search-results" class="col mt-1" style="max-height:140px; overflow-y:auto;"></div>
          </div>
        </div>
      </aside>

      <div class="main-col">
        <div class="card-sm">
          <div class="row-between">
            <div class="row">
              <span id="chat-active-title" style="font-weight:600; font-size:13.5px;">Новый чат</span>
              <span id="chat-tokens-badge" class="badge">токены: 0</span>
              <span id="chat-monthly-badge" class="badge badge-emerald">месяц: ${esc(formatTokens(st.monthlyUsed))} / ${esc(formatTokens(st.monthlyLimit))}</span>
            </div>
            <div class="row">
              <span id="chat-model-pill" class="badge badge-accent">${esc(st.settings.model || "модель из CRM или локальная")}</span>
              <button type="button" id="chat-toggle-settings" class="btn btn-sm">⚙ Модель и параметры</button>
            </div>
          </div>

          <div id="chat-settings-panel" class="mt-3 pt-2" style="display:none; border-top:1px solid var(--border);">
            <div class="grid-3">
              <div>
                <label class="field-label">Пресет провайдера</label>
                <select id="chat-preset" class="select select-sm">
                  <option value="">— выбрать пресет —</option>
                  ${Object.entries(presets).map(([k, p]) => `<option value="${esc(k)}">${esc(p.label)}</option>`).join("")}
                </select>
              </div>
              <div>
                <label class="field-label">Base URL (/v1)</label>
                <input id="chat-base-url" class="input input-sm" value="${esc(st.settings.baseUrl)}" placeholder="http://127.0.0.1:1234/v1" />
              </div>
              <div>
                <label class="field-label">API ключ <span id="chat-key-hint" class="muted"></span></label>
                <input id="chat-api-key" type="password" class="input input-sm" placeholder="Оставьте пустым, если сохранён в CRM или локальный" />
              </div>
            </div>

            <div class="grid-3 mt-2">
              <div>
                <label class="field-label">Модель</label>
                <div class="row">
                  <input id="chat-model-input" class="input input-sm" style="flex:1" list="chat-models-datalist" value="${esc(st.settings.model)}" placeholder="например qwen3-8b или gpt-4o-mini" />
                  <datalist id="chat-models-datalist"></datalist>
                  <button type="button" id="chat-fetch-models" class="btn btn-xs">Список</button>
                </div>
                <div id="chat-model-caps" class="muted mt-1" style="font-size:10.5px;"></div>
              </div>
              <div>
                <label class="field-label">Тип раздумий (Thinking)</label>
                <select id="chat-reasoning" class="select select-sm">
                  ${reasoningModes.map(([val, lbl]) => `<option value="${esc(val)}">${esc(lbl)}</option>`).join("")}
                </select>
              </div>
              <div>
                <label class="field-label">Бюджет / Контекст (токенов)</label>
                <div class="row">
                  <input id="chat-thinking-budget" type="number" class="input input-sm" placeholder="Budget" title="thinking_budget" />
                  <input id="chat-context-limit" type="number" class="input input-sm" placeholder="Контекст (0=авто)" title="Лимит контекста модели" />
                </div>
              </div>
            </div>

            <div class="grid-4 mt-2">
              <div>
                <label class="field-label">Temperature</label>
                <input id="chat-temp" type="number" step="0.05" min="0" max="2" class="input input-sm" placeholder="по умолчанию" />
              </div>
              <div>
                <label class="field-label">Top-P</label>
                <input id="chat-top-p" type="number" step="0.05" min="0" max="1" class="input input-sm" placeholder="по умолчанию" />
              </div>
              <div>
                <label class="field-label">Max tokens</label>
                <input id="chat-max-tokens" type="number" min="64" class="input input-sm" placeholder="по умолчанию" />
              </div>
              <div>
                <label class="field-label">RAG фрагментов / Режим</label>
                <div class="row">
                  <input id="chat-rag-chunks" type="number" min="0" max="200" class="input input-sm" style="width:72px" value="8" />
                  <label class="row" style="font-size:11px; cursor:pointer;">
                    <input id="chat-rag-full" type="checkbox" /> Вся база
                  </label>
                </div>
              </div>
            </div>

            <div class="mt-2">
              <label class="field-label">Системный промпт</label>
              <textarea id="chat-system" class="textarea" rows="2">${esc(st.params.system)}</textarea>
            </div>

            <div class="row-between mt-2">
              <label class="row" style="font-size:11px; cursor:pointer;">
                <input id="chat-send-thinking-flag" type="checkbox" checked />
                <span>Передавать enable_thinking (Qwen3 / Unsloth)</span>
              </label>
              <div class="row">
                <button type="button" id="chat-save-crm-settings" class="btn btn-sm btn-primary">💾 Сохранить настройки модели в БД CRM</button>
              </div>
            </div>
          </div>
        </div>

        <div class="chat-box">
          <div id="chat-messages" class="chat-messages">
            <div class="card-2" style="padding:18px; text-align:center; margin:auto;">
              <div style="font-weight:600; font-size:14px;">Чат с моделью</div>
              <p class="muted mt-1" style="max-width:460px;">
                Поддерживаются локальные серверы (LM Studio, Ollama, llama.cpp) и облачные API через CRM.
                Перетащите файлы, картинки (Ctrl+V) или выберите папку RAG слева.
              </p>
            </div>
          </div>

          <div id="chat-composer" class="composer">
            <div id="chat-att-chips" class="att-chips"></div>
            <div class="row" style="align-items:flex-end;">
              <label class="btn btn-sm" title="Прикрепить файлы или картинки (DOCX, XLSX, PPTX, текст, код, PNG/JPG)" style="cursor:pointer;">
                📎
                <input id="chat-file-input" type="file" multiple hidden />
              </label>
              <textarea id="chat-input" class="textarea" style="flex:1; min-height:46px; max-height:180px;" placeholder="Напишите сообщение модели… (Enter — отправить, Shift+Enter — перенос, Ctrl+V — вставить картинку)"></textarea>
              <button type="button" id="chat-send-btn" class="btn btn-primary" style="height:42px;">Отправить</button>
              <button type="button" id="chat-stop-btn" class="btn btn-danger" style="height:42px; display:none;">Стоп</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const elChats = root.querySelector("#chat-list");
  const elMsgs = root.querySelector("#chat-messages");
  const elInput = root.querySelector("#chat-input");
  const elComposer = root.querySelector("#chat-composer");
  const elChips = root.querySelector("#chat-att-chips");
  const elSend = root.querySelector("#chat-send-btn");
  const elStop = root.querySelector("#chat-stop-btn");

  const renderChatList = () => {
    if (!st.chats.length) {
      elChats.innerHTML = `<div class="muted" style="font-size:11.5px; padding:6px;">Чатов пока нет</div>`;
      return;
    }
    elChats.innerHTML = st.chats.map((c) => `
      <div class="list-item ${c.id === st.activeChatId ? "active" : ""}" data-chat-id="${c.id}">
        <div style="min-width:0; flex:1;">
          <div style="font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(c.title || "Новый чат")}</div>
          <div class="muted" style="font-size:10.5px;">${esc(formatTokens(c.tokensTotal || 0))} ток.${c.tokensLeft !== null && c.tokensLeft !== undefined ? ` · ост. ${esc(formatTokens(c.tokensLeft))}` : ""}</div>
        </div>
        <button type="button" class="btn btn-xs btn-ghost text-red" data-del-chat="${c.id}" title="Удалить чат">✕</button>
      </div>
    `).join("");

    elChats.querySelectorAll("[data-chat-id]").forEach((row) => {
      row.onclick = (ev) => {
        if (ev.target.closest("[data-del-chat]")) return;
        loadChat(Number(row.getAttribute("data-chat-id")));
      };
    });
    elChats.querySelectorAll("[data-del-chat]").forEach((btn) => {
      btn.onclick = async (ev) => {
        ev.stopPropagation();
        const id = Number(btn.getAttribute("data-del-chat"));
        try {
          await apiJson(`/api/ai/chats?id=${id}`, { method: "DELETE" });
          if (st.activeChatId === id) {
            st.activeChatId = 0;
            st.messages = [];
          }
          await refreshChats();
          renderMessages();
        } catch (err) {
          showToast(err.message, "error");
        }
      };
    });
  };

  const renderRagFolders = () => {
    const host = root.querySelector("#rag-folder-list");
    const items = [
      `<div class="list-item ${st.selectedRagId === 0 ? "active" : ""}" data-rag-id="0"><div>Без папки (RAG выкл.)</div></div>`,
      ...st.ragFolders.map((f) => `
        <div class="list-item ${st.selectedRagId === f.id ? "active" : ""}" data-rag-id="${f.id}">
          <div style="min-width:0; flex:1;">
            <div style="font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">📁 ${esc(f.name)}</div>
            <div class="muted" style="font-size:10px;">${f.filesCount} файл. · ${f.chunksCount} фрагм.</div>
          </div>
          <button type="button" class="btn btn-xs btn-ghost text-red" data-del-rag="${f.id}">✕</button>
        </div>
      `),
    ];
    host.innerHTML = items.join("");
    host.querySelectorAll("[data-rag-id]").forEach((el) => {
      el.onclick = (ev) => {
        if (ev.target.closest("[data-del-rag]")) return;
        st.selectedRagId = Number(el.getAttribute("data-rag-id"));
        renderRagFolders();
      };
    });
    host.querySelectorAll("[data-del-rag]").forEach((btn) => {
      btn.onclick = async (ev) => {
        ev.stopPropagation();
        const id = Number(btn.getAttribute("data-del-rag"));
        try {
          await apiJson(`/api/ai/rag?id=${id}`, { method: "DELETE" });
          if (st.selectedRagId === id) st.selectedRagId = 0;
          await refreshRag();
        } catch (err) {
          showToast(err.message, "error");
        }
      };
    });
  };

  const renderPendingChips = () => {
    elChips.innerHTML = st.pendingFiles.map((f, idx) => `
      <span class="att-chip">
        ${f.preview ? `<img src="${esc(f.preview)}" class="att-thumb" alt="" />` : "<span>📄</span>"}
        <span>${esc(f.name)}</span>
        <span class="muted">(${esc(formatBytes(f.size))})</span>
        <button type="button" class="btn btn-xs btn-ghost" data-rm-att="${idx}">✕</button>
      </span>
    `).join("");
    elChips.querySelectorAll("[data-rm-att]").forEach((b) => {
      b.onclick = () => {
        st.pendingFiles.splice(Number(b.getAttribute("data-rm-att")), 1);
        renderPendingChips();
      };
    });
  };

  const renderMessages = () => {
    const active = st.chats.find((c) => c.id === st.activeChatId);
    root.querySelector("#chat-active-title").textContent = active ? active.title : "Новый чат";
    root.querySelector("#chat-tokens-badge").textContent = `токены: ${formatTokens(active?.tokensTotal || 0)}`;
    root.querySelector("#chat-monthly-badge").textContent = `месяц: ${formatTokens(st.monthlyUsed)} / ${formatTokens(st.monthlyLimit)}`;

    if (!st.messages.length) {
      elMsgs.innerHTML = `
        <div class="card-2" style="padding:18px; text-align:center; margin:auto;">
          <div style="font-weight:600; font-size:14px;">Диалог пуст</div>
          <p class="muted mt-1">Отправьте первый вопрос — история автоматически сохранится в базе CRM.</p>
        </div>
      `;
      return;
    }

    elMsgs.innerHTML = st.messages.map((m, idx) => {
      const isUser = m.role === "user";
      const atts = Array.isArray(m.attachments) ? m.attachments : [];
      const reasoningHtml = !isUser && m.reasoning
        ? `<details class="reasoning-box" ${m.streaming && !m.text ? "open" : ""}>
             <summary class="reasoning-toggle">
               <span>🧠 Раздумья модели (${m.reasoning.length} симв.)</span>
               ${m.streaming ? '<span class="dot dot-amber dot-pulse"></span>' : ""}
             </summary>
             <div class="reasoning-body">${esc(m.reasoning)}</div>
           </details>`
        : "";
      const attHtml = atts.length
        ? `<div class="att-chips mt-1">${atts.map((a) => `<span class="att-chip">📎 ${esc(a.name)}</span>`).join("")}</div>`
        : "";
      const usageLine = !isUser && m.usage
        ? `<span>${formatTokens(m.usage.total)} ток.${m.ragHits ? ` · RAG: ${m.ragHits}` : ""}</span>`
        : "";
      return `
        <div class="bubble ${isUser ? "bubble-user" : "bubble-assistant"} ${m.error ? "bubble-error" : ""}" data-msg-idx="${idx}">
          <div class="bubble-meta">
            <span>${isUser ? "Вы" : "ИИ"}</span>
            <span>${usageLine}</span>
          </div>
          ${reasoningHtml}
          <div class="md-content">${isUser ? esc(m.text).replace(/\n/g, "<br/>") : renderMarkdown(m.text || (m.streaming ? "…" : ""))}</div>
          ${attHtml}
        </div>
      `;
    }).join("");
    elMsgs.scrollTop = elMsgs.scrollHeight;
  };

  async function refreshChats() {
    try {
      const res = await apiJson("/api/ai/chats");
      st.chats = res.chats || [];
      renderChatList();
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  async function loadChat(id) {
    try {
      const res = await apiJson(`/api/ai/chats/${id}`);
      st.activeChatId = id;
      st.messages = (res.messages || []).map((m) => {
        let atts = [];
        try { atts = typeof m.attachments === "string" ? JSON.parse(m.attachments || "[]") : (m.attachments || []); } catch {}
        return {
          role: m.role,
          text: m.content || "",
          reasoning: m.reasoning || "",
          attachments: atts,
          usage: m.tokens ? { total: m.tokens, prompt: m.promptTokens || 0, completion: m.completionTokens || 0 } : null,
        };
      });
      renderChatList();
      renderMessages();
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  async function refreshRag() {
    if (limits.rag === false) return;
    try {
      const res = await apiJson("/api/ai/rag");
      st.ragFolders = res.folders || [];
      renderRagFolders();
    } catch {
      /* ignore */
    }
  }

  async function loadSavedAiSettings() {
    try {
      const res = await apiJson("/api/ai/settings");
      const s = res.settings || {};
      if (s.baseUrl) {
        st.settings.baseUrl = s.baseUrl;
        root.querySelector("#chat-base-url").value = s.baseUrl;
      }
      if (s.model) {
        st.settings.model = s.model;
        root.querySelector("#chat-model-input").value = s.model;
        root.querySelector("#chat-model-pill").textContent = s.model;
      }
      st.settings.hasSavedKey = Boolean(s.hasApiKey);
      st.settings.apiKeyHint = s.apiKeyHint || "";
      root.querySelector("#chat-key-hint").textContent = s.hasApiKey ? `(в БД: ${s.apiKeyHint})` : "";
    } catch {
      /* ignore */
    }
  }

  function syncSettingsFromDom() {
    st.settings.baseUrl = root.querySelector("#chat-base-url").value.trim();
    st.settings.apiKey = root.querySelector("#chat-api-key").value.trim();
    st.settings.model = root.querySelector("#chat-model-input").value.trim();
    root.querySelector("#chat-model-pill").textContent = st.settings.model || "модель";
    const numOrNull = (id) => {
      const v = root.querySelector(id).value.trim();
      return v === "" ? null : Number(v);
    };
    st.params.system = root.querySelector("#chat-system").value;
    st.params.temperature = numOrNull("#chat-temp");
    st.params.topP = numOrNull("#chat-top-p");
    st.params.maxTokens = numOrNull("#chat-max-tokens");
    st.params.reasoning = root.querySelector("#chat-reasoning").value || "default";
    st.params.thinkingBudget = numOrNull("#chat-thinking-budget");
    st.params.contextLimit = Number(root.querySelector("#chat-context-limit").value || 0) || 0;
    st.params.ragChunks = Number(root.querySelector("#chat-rag-chunks").value || 8) || 0;
    st.params.ragFull = Boolean(root.querySelector("#chat-rag-full").checked);
    st.params.sendThinkingFlag = Boolean(root.querySelector("#chat-send-thinking-flag").checked);
  }

  async function sendMessage() {
    if (st.streaming) return;
    syncSettingsFromDom();
    const text = elInput.value.trim();
    if (!text && st.pendingFiles.length === 0) return;

    const outgoingContent = (() => {
      const textFiles = st.pendingFiles.filter((f) => f.kind === "text" && f.text);
      const images = st.pendingFiles.filter((f) => f.kind === "image" && f.preview);
      const metaOnly = st.pendingFiles.filter((f) => f.kind === "unreadable");
      let combined = text;
      if (textFiles.length) {
        combined += "\n\n" + textFiles.map((f) => `--- Файл ${f.name} ---\n${f.text}`).join("\n\n");
      }
      if (metaOnly.length) {
        combined += "\n\n" + metaOnly.map((f) => `[Вложение ${f.name}: ${f.note}]`).join("\n");
      }
      if (images.length) {
        return [
          { type: "text", text: combined || "Посмотри на приложенные изображения" },
          ...images.map((img) => ({ type: "image_url", image_url: { url: img.preview } })),
        ];
      }
      return combined;
    })();

    const attMeta = st.pendingFiles.map((f) => ({ name: f.name, kind: f.kind, size: f.size, note: f.note }));
    const historyToSend = [
      ...st.messages.map((m) => ({ role: m.role, content: m.rawContent || m.text })),
      { role: "user", content: outgoingContent },
    ];

    st.messages.push({ role: "user", text: text || "[Файлы]", rawContent: outgoingContent, attachments: attMeta });
    const assistantMsg = { role: "assistant", text: "", reasoning: "", streaming: true };
    st.messages.push(assistantMsg);
    elInput.value = "";
    st.pendingFiles = [];
    renderPendingChips();
    renderMessages();

    st.streaming = true;
    st.abortCtrl = new AbortController();
    elSend.style.display = "none";
    elStop.style.display = "";

    try {
      const res = await apiFetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: st.abortCtrl.signal,
        body: JSON.stringify({
          chatId: st.activeChatId || 0,
          messages: historyToSend,
          params: st.params,
          ragFolderId: st.selectedRagId || 0,
          ragQuery: text,
          attachments: attMeta,
          settings: {
            baseUrl: st.settings.baseUrl,
            apiKey: st.settings.apiKey,
            model: st.settings.model,
          },
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      await consumeSseStream(res, (_ev, data) => {
        if (!data || typeof data !== "object") return;
        if (data.delta) assistantMsg.text += String(data.delta);
        if (data.reasoning) assistantMsg.reasoning += String(data.reasoning);
        if (data.usage) assistantMsg.usage = data.usage;
        if (data.ragHits) assistantMsg.ragHits = data.ragHits;
        if (data.done) {
          if (data.chat?.id) st.activeChatId = data.chat.id;
          if (data.monthly) {
            st.monthlyUsed = data.monthly.used;
            st.monthlyLimit = data.monthly.limit;
          }
          if (data.reasoningDowngraded) {
            showToast("Режим раздумий понижен по правилам вашей роли", "info");
          }
        }
        renderMessages();
      });
    } catch (err) {
      if (err.name !== "AbortError") {
        assistantMsg.error = true;
        assistantMsg.text = assistantMsg.text || `Ошибка: ${err.message}`;
        showToast(err.message, "error");
      }
    } finally {
      assistantMsg.streaming = false;
      st.streaming = false;
      st.abortCtrl = null;
      elSend.style.display = "";
      elStop.style.display = "none";
      renderMessages();
      await refreshChats();
    }
  }

  root.querySelector("#chat-toggle-settings").onclick = () => {
    const p = root.querySelector("#chat-settings-panel");
    st.showSettings = !st.showSettings;
    p.style.display = st.showSettings ? "block" : "none";
  };

  root.querySelector("#chat-preset").onchange = (ev) => {
    const preset = presets[ev.target.value];
    if (!preset) return;
    if (preset.base_url) root.querySelector("#chat-base-url").value = preset.base_url;
    if (preset.model) root.querySelector("#chat-model-input").value = preset.model;
    syncSettingsFromDom();
  };

  root.querySelector("#chat-fetch-models").onclick = async () => {
    syncSettingsFromDom();
    try {
      const res = await apiJson("/api/ai/models", {
        method: "POST",
        body: JSON.stringify({
          baseUrl: st.settings.baseUrl,
          apiKey: st.settings.apiKey,
          model: st.settings.model,
        }),
      });
      st.models = res.models || [];
      st.capabilitiesByModel = res.capabilitiesByModel || {};
      root.querySelector("#chat-models-datalist").innerHTML = st.models
        .map((m) => `<option value="${esc(m)}"></option>`)
        .join("");
      if (!st.settings.model && st.models.length) {
        root.querySelector("#chat-model-input").value = st.models[0];
      }
      const cap = res.capabilities || st.capabilitiesByModel[root.querySelector("#chat-model-input").value];
      if (cap) {
        const badges = [
          cap.supportsVision ? "Vision" : "",
          cap.supportsReasoning ? "Thinking" : "",
          cap.contextLength ? `ctx: ${formatTokens(cap.contextLength)}` : "",
        ].filter(Boolean).join(" · ");
        root.querySelector("#chat-model-caps").textContent = badges || "Стандартные возможности";
      }
      showToast(`Найдено моделей: ${st.models.length}`, "ok");
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  root.querySelector("#chat-save-crm-settings").onclick = async () => {
    syncSettingsFromDom();
    try {
      const res = await apiJson("/api/ai/settings", {
        method: "PUT",
        body: JSON.stringify({
          baseUrl: st.settings.baseUrl,
          model: st.settings.model,
          ...(st.settings.apiKey ? { apiKey: st.settings.apiKey } : {}),
        }),
      });
      await apiJson("/api/app/prefs", {
        method: "POST",
        body: JSON.stringify({
          localModel: { baseUrl: st.settings.baseUrl, model: st.settings.model, apiKey: st.settings.apiKey },
        }),
      }).catch(() => {});
      root.querySelector("#chat-key-hint").textContent = res.settings?.hasApiKey ? `(в БД: ${res.settings.apiKeyHint})` : "";
      showToast("Настройки модели сохранены в БД CRM", "ok");
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  root.querySelector("#chat-new-btn").onclick = async () => {
    try {
      const res = await apiJson("/api/ai/chats", { method: "POST", body: "{}" });
      if (res.chat?.id) {
        st.activeChatId = res.chat.id;
        st.messages = [];
        await refreshChats();
        renderMessages();
      }
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  root.querySelector("#rag-refresh-btn").onclick = refreshRag;
  root.querySelector("#rag-create-btn").onclick = async () => {
    const inp = root.querySelector("#rag-new-name");
    const name = inp.value.trim();
    if (!name) return;
    try {
      const res = await apiJson("/api/ai/rag", { method: "POST", body: JSON.stringify({ name }) });
      inp.value = "";
      if (res.folder?.id) st.selectedRagId = res.folder.id;
      await refreshRag();
      showToast(`Папка «${name}» создана`, "ok");
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  async function uploadRagFiles(fileList) {
    if (!fileList || !fileList.length) return;
    if (!st.selectedRagId) {
      showToast("Сначала выберите или создайте папку RAG слева", "error");
      return;
    }
    const statusEl = root.querySelector("#rag-upload-status");
    statusEl.textContent = `Индексация ${fileList.length} файл(ов)…`;
    const batch = [];
    for (const file of fileList) {
      try {
        const parsed = await readBrowserFileToAttachment(file);
        if (parsed.text) {
          const chunks = splitIntoChunks(parsed.text);
          if (chunks.length) batch.push({ path: file.webkitRelativePath || file.name, chunks });
        }
      } catch {
        /* skip */
      }
    }
    if (!batch.length) {
      statusEl.textContent = "Нет текстовых данных для индексации";
      return;
    }
    try {
      const res = await apiJson("/api/ai/rag/chunks", {
        method: "POST",
        body: JSON.stringify({ folderId: st.selectedRagId, items: batch }),
      });
      statusEl.textContent = `✓ Загружено фрагментов: ${res.added}`;
      await refreshRag();
    } catch (err) {
      statusEl.textContent = `Ошибка: ${err.message}`;
      showToast(err.message, "error");
    }
  }

  root.querySelector("#rag-files-input").onchange = (ev) => uploadRagFiles(ev.target.files);
  root.querySelector("#rag-dir-input").onchange = (ev) => uploadRagFiles(ev.target.files);

  root.querySelector("#rag-search-btn").onclick = async () => {
    if (!st.selectedRagId) {
      showToast("Выберите папку RAG", "error");
      return;
    }
    const q = root.querySelector("#rag-search-q").value.trim();
    if (!q) return;
    try {
      const res = await apiJson("/api/ai/rag/search", {
        method: "POST",
        body: JSON.stringify({ folderId: st.selectedRagId, query: q, limit: 5 }),
      });
      const hits = res.hits || [];
      const host = root.querySelector("#rag-search-results");
      host.innerHTML = hits.length
        ? hits.map((h) => `<div class="card-sm" style="padding:6px 8px;"><div style="font-weight:600; font-size:10.5px;">${esc(h.path)}</div><div class="muted" style="font-size:10.5px;">${esc((h.text || "").slice(0, 140))}…</div></div>`).join("")
        : `<div class="muted" style="font-size:11px;">Совпадений не найдено</div>`;
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  async function addFiles(files) {
    for (const f of files) {
      try {
        const parsed = await readBrowserFileToAttachment(f);
        st.pendingFiles.push(parsed);
      } catch (err) {
        showToast(`${f.name}: ${err.message}`, "error");
      }
    }
    renderPendingChips();
  }

  root.querySelector("#chat-file-input").onchange = (ev) => {
    addFiles(ev.target.files);
    ev.target.value = "";
  };
  elInput.onpaste = async (ev) => {
    const files = await readClipboardImages(ev.clipboardData);
    if (files.length) {
      ev.preventDefault();
      await addFiles(files);
    }
  };
  elComposer.ondragover = (ev) => {
    ev.preventDefault();
    elComposer.classList.add("drag-over");
  };
  elComposer.ondragleave = () => elComposer.classList.remove("drag-over");
  elComposer.ondrop = async (ev) => {
    ev.preventDefault();
    elComposer.classList.remove("drag-over");
    if (ev.dataTransfer?.files?.length) await addFiles(ev.dataTransfer.files);
  };

  elInput.onkeydown = (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      sendMessage();
    }
  };
  elSend.onclick = sendMessage;
  elStop.onclick = () => {
    if (st.abortCtrl) st.abortCtrl.abort();
  };

  refreshChats();
  refreshRag();
  loadSavedAiSettings();

  return { refresh: () => { refreshChats(); refreshRag(); } };
}
