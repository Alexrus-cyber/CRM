import { mountChatTab } from "/tab_chat.js";
import { mountAgentTab } from "/tab_agent.js";
import { mountOperatorTab } from "/tab_operator.js";
import { mountLimitsTab } from "/tab_limits.js";

const TOKEN = document.querySelector('meta[name="crm-harness-token"]')?.getAttribute("content") || "";

export function harnessToken() {
  return TOKEN;
}

export function withHtQuery(url) {
  if (!TOKEN) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}ht=${encodeURIComponent(TOKEN)}`;
}

export async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (TOKEN) headers.set("X-Harness-Token", TOKEN);
  const res = await fetch(url, { ...options, headers });
  return res;
}

let authRecoverPromise = null;
let authBannerNotice = "";

async function handleUnexpectedUnauthorized() {
  if (authRecoverPromise) return authRecoverPromise;
  authRecoverPromise = (async () => {
    try {
      const checkRes = await apiFetch("/api/app/crm/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (checkRes.status === 401) {
        if (appState.eventsSource) {
          try { appState.eventsSource.close(); } catch {}
          appState.eventsSource = null;
        }
        authBannerNotice = "Сессия CRM истекла или недействительна — войдите заново.";
        await boot({ skipRefresh: true });
      }
    } catch {
      /* сеть временно недоступна */
    } finally {
      setTimeout(() => { authRecoverPromise = null; }, 2000);
    }
  })();
  return authRecoverPromise;
}

export async function apiJson(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && typeof options.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await apiFetch(url, { ...options, headers });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    if (res.status === 401 && !String(url).startsWith("/api/app/crm/")) {
      handleUnexpectedUnauthorized();
    }
    throw err;
  }
  return data;
}

export function showToast(message, kind = "info", timeoutMs = 4200) {
  const host = document.getElementById("toast-container");
  if (!host) return;
  const el = document.createElement("div");
  el.className = `toast ${kind === "error" ? "toast-error" : kind === "ok" ? "toast-ok" : ""}`;
  el.textContent = String(message || "");
  host.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, timeoutMs);
}

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatTokens(n) {
  if (n === null || n === undefined) return "без лимита";
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  return new Intl.NumberFormat("ru-RU").format(Math.round(num));
}

export function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} Б`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} КБ`;
  return `${(b / (1024 * 1024)).toFixed(1)} МБ`;
}

export function formatDateTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(iso);
  }
}

export function sanitizeLinkUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (trimmed.startsWith("/")) return trimmed;
  try {
    const u = new URL(trimmed);
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
  } catch {
    /* ignore */
  }
  return "#";
}

export function renderMarkdown(mdText) {
  const source = String(mdText || "");
  const codeBlocks = [];
  const withPlaceholders = source.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: lang || "code", code: String(code || "").replace(/\n$/, "") });
    return `\u0000CODEBLOCK_${idx}\u0000`;
  });

  const renderInline = (line) => {
    let out = esc(line);
    out = out.replace(/`([^`\n]+)`/g, (_m, code) => `<code class="inline-code">${code}</code>`);
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
      const safe = esc(sanitizeLinkUrl(url));
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    return out;
  };

  const lines = withPlaceholders.split(/\r?\n/);
  const html = [];
  let inUl = false;
  let inOl = false;

  const closeLists = () => {
    if (inUl) { html.push("</ul>"); inUl = false; }
    if (inOl) { html.push("</ol>"); inOl = false; }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    const cbMatch = trimmed.match(/^\u0000CODEBLOCK_(\d+)\u0000$/);
    if (cbMatch) {
      closeLists();
      const cb = codeBlocks[Number(cbMatch[1])];
      const codeId = `cb-${Math.random().toString(36).slice(2, 9)}`;
      html.push(
        `<div class="code-block-wrap">` +
          `<div class="code-block-head"><span>${esc(cb.lang)}</span>` +
          `<button type="button" class="btn btn-xs btn-ghost" data-copy-target="${codeId}">Копировать</button></div>` +
          `<pre id="${codeId}">${esc(cb.code)}</pre></div>`
      );
      continue;
    }

    if (!trimmed) {
      closeLists();
      continue;
    }

    const hMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      closeLists();
      const lvl = hMatch[1].length;
      html.push(`<h${lvl}>${renderInline(hMatch[2])}</h${lvl}>`);
      continue;
    }

    if (trimmed.startsWith("> ")) {
      closeLists();
      html.push(`<blockquote>${renderInline(trimmed.slice(2))}</blockquote>`);
      continue;
    }

    if (/^[-*•]\s+/.test(trimmed)) {
      if (inOl) { html.push("</ol>"); inOl = false; }
      if (!inUl) { html.push("<ul>"); inUl = true; }
      html.push(`<li>${renderInline(trimmed.replace(/^[-*•]\s+/, ""))}</li>`);
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      if (inUl) { html.push("</ul>"); inUl = false; }
      if (!inOl) { html.push("<ol>"); inOl = true; }
      html.push(`<li>${renderInline(trimmed.replace(/^\d+\.\s+/, ""))}</li>`);
      continue;
    }

    closeLists();
    html.push(`<p>${renderInline(rawLine)}</p>`);
  }
  closeLists();

  return `<div class="md-body">${html.join("")}</div>`;
}

document.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-copy-target]");
  if (!btn) return;
  const id = btn.getAttribute("data-copy-target");
  const pre = id ? document.getElementById(id) : null;
  if (!pre) return;
  navigator.clipboard?.writeText(pre.textContent || "").then(() => {
    const old = btn.textContent;
    btn.textContent = "Скопировано";
    setTimeout(() => { btn.textContent = old; }, 1400);
  }).catch(() => {});
});

export async function readBrowserFileToAttachment(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const b64 = btoa(binary);
  return apiJson("/api/app/extract-file", {
    method: "POST",
    body: JSON.stringify({
      name: file.name || "file.txt",
      mime: file.type || "",
      dataBase64: b64,
    }),
  });
}

export async function readClipboardImages(clipboardData) {
  const files = [];
  if (clipboardData && clipboardData.items) {
    for (const item of clipboardData.items) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
  } else if (clipboardData && clipboardData.files) {
    for (const f of clipboardData.files) files.push(f);
  }
  return files;
}

export async function consumeSseStream(res, onEvent) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  const processBlock = (block) => {
    const lines = block.split(/\r?\n/);
    let eventName = "message";
    const dataParts = [];
    for (const l of lines) {
      if (l.startsWith(":")) {
        onEvent("__keepalive__", null);
        return;
      }
      if (l.startsWith("event:")) {
        eventName = l.slice(6).trim();
      } else if (l.startsWith("data:")) {
        dataParts.push(l.slice(5).trimStart());
      }
    }
    if (dataParts.length === 0) return;
    const raw = dataParts.join("\n").trim();
    if (!raw || raw === "[DONE]") return;
    try {
      const parsed = JSON.parse(raw);
      onEvent(eventName, parsed);
    } catch {
      onEvent(eventName, { raw });
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    while (true) {
      const match = /\r?\n\r?\n/.exec(buf);
      if (!match) break;
      const frame = buf.slice(0, match.index);
      buf = buf.slice(match.index + match[0].length);
      if (frame.trim()) processBlock(frame);
    }
  }
  if (buf.trim()) processBlock(buf.trim());
}

const appState = {
  boot: null,
  activeTab: "chat",
  eventsSource: null,
  listeners: new Set(),
  tabsApi: {},
};

export function subscribeAppEvents(fn) {
  appState.listeners.add(fn);
  return () => appState.listeners.delete(fn);
}

function applyTheme(theme) {
  const dark = theme !== "light";
  document.documentElement.classList.toggle("dark", dark);
}

function renderLogin(state) {
  applyTheme(state.theme);
  const root = document.getElementById("app-root");
  root.innerHTML = `
    <div class="login-wrap">
      <div class="card glow-accent login-card">
        <div class="row mb-2">
          <div class="logo-box">✦</div>
          <div>
            <h1 class="header-title">Nova CRM · ИИ Harness</h1>
            <p class="header-subtitle">Подключитесь к базе данных через учётку сайта CRM</p>
          </div>
        </div>

        <form id="login-form" class="col mt-3">
          <div>
            <label class="field-label">1. Адрес сервера CRM</label>
            <div class="row">
              <input id="login-url" class="input" style="flex:1" value="${esc(state.crmUrl || "http://localhost:3000")}" placeholder="https://crm.example.com или http://localhost:3000" required />
              <button type="button" id="btn-check-crm" class="btn btn-sm">Проверить</button>
            </div>
            <div id="crm-check-msg" class="mt-1" style="font-size:11px;"></div>
          </div>

          <div>
            <label class="field-label">2. Email</label>
            <input id="login-email" type="email" class="input" value="${esc(state.crmEmail || "")}" placeholder="user@company.com" required />
          </div>

          <div>
            <label class="field-label">Пароль</label>
            <input id="login-password" type="password" class="input" placeholder="••••••••" required />
          </div>

          <div id="totp-wrap" style="display:none;">
            <label class="field-label">Код двухфакторной аутентификации (2FA)</label>
            <input id="login-totp" class="input mono" placeholder="6-значный код" maxlength="10" />
          </div>

          <label class="row mt-1" style="cursor:pointer; font-size:11.5px;">
            <input id="login-remember" type="checkbox" ${state.rememberKey ? "checked" : ""} />
            <span>Запомнить сессию и ключи на этом компьютере</span>
          </label>

          <div id="login-error" class="alert-box alert-error" style="${authBannerNotice ? "display:block;" : "display:none;"}">${authBannerNotice ? esc(authBannerNotice) : ""}</div>

          <button type="submit" id="btn-login-submit" class="btn btn-primary mt-2" style="width:100%; padding:10px;">
            Войти в Nova CRM Harness
          </button>
        </form>

        <div class="row-between mt-3" style="font-size:11px; color:var(--muted);">
          <span>Версия ${esc(state.appVersion || "")}</span>
          <button type="button" id="btn-toggle-theme-login" class="btn btn-xs btn-ghost">
            ${state.theme === "light" ? "🌙 Тёмная тема" : "☀️ Светлая тема"}
          </button>
        </div>
      </div>
    </div>
  `;

  const urlEl = document.getElementById("login-url");
  const checkMsgEl = document.getElementById("crm-check-msg");
  const errEl = document.getElementById("login-error");
  const totpWrap = document.getElementById("totp-wrap");

  document.getElementById("btn-toggle-theme-login").onclick = async () => {
    const next = state.theme === "light" ? "dark" : "light";
    state.theme = next;
    applyTheme(next);
    await apiJson("/api/app/theme", { method: "POST", body: JSON.stringify({ theme: next }) }).catch(() => {});
    renderLogin(state);
  };

  document.getElementById("btn-check-crm").onclick = async () => {
    checkMsgEl.innerHTML = `<span class="muted">Проверяю доступность сервера…</span>`;
    try {
      const res = await apiJson("/api/app/crm/check", {
        method: "POST",
        body: JSON.stringify({ serverUrl: urlEl.value }),
      });
      checkMsgEl.innerHTML = `<span class="text-emerald">✓ ${esc(res.message)}</span>`;
      if (res.serverUrl) urlEl.value = res.serverUrl;
    } catch (err) {
      checkMsgEl.innerHTML = `<span class="text-red">✕ ${esc(err.message)}</span>`;
    }
  };

  document.getElementById("login-form").onsubmit = async (ev) => {
    ev.preventDefault();
    authBannerNotice = "";
    errEl.style.display = "none";
    const btn = document.getElementById("btn-login-submit");
    btn.disabled = true;
    btn.textContent = "Подключение к CRM…";
    try {
      await apiJson("/api/app/crm/login", {
        method: "POST",
        body: JSON.stringify({
          serverUrl: urlEl.value,
          email: document.getElementById("login-email").value,
          password: document.getElementById("login-password").value,
          totpCode: document.getElementById("login-totp").value,
          remember: document.getElementById("login-remember").checked,
        }),
      });
      await boot();
    } catch (err) {
      if (err.data && err.data.requiresTotp) {
        totpWrap.style.display = "block";
        document.getElementById("login-totp").focus();
      }
      errEl.textContent = err.message;
      errEl.style.display = "block";
      btn.disabled = false;
      btn.textContent = "Войти в Nova CRM Harness";
    }
  };
}

function startEventsStream() {
  if (appState.eventsSource) {
    try { appState.eventsSource.close(); } catch {}
    appState.eventsSource = null;
  }
  const src = new EventSource(withHtQuery("/api/events"));
  src.addEventListener("update", (ev) => {
    try {
      const payload = JSON.parse(ev.data || "{}");
      for (const fn of appState.listeners) fn(payload);
    } catch {
      /* ignore */
    }
  });
  appState.eventsSource = src;
}

function renderMain(state) {
  applyTheme(state.theme);
  const profile = state.profile || {};
  const user = profile.user || {};
  const agentAllowed = Boolean(user.canUseAgent);
  const operatorAllowed = Boolean(user.canUseOperator);

  const tabs = [
    { id: "chat", label: "💬 Чат с моделью", hint: "Диалог с моделью, файлы, картинки, RAG, режимы раздумий" },
  ];
  if (agentAllowed) {
    tabs.push({ id: "agent", label: "🤖 Агент", hint: "Агент с инструментами, песочница, субагенты и Надсмотрщик" });
  }
  if (operatorAllowed) {
    tabs.push({ id: "operator", label: "🖥️ Оператор", hint: "Бот управления рабочим столом, планировщик и очередь задач" });
  }
  tabs.push({ id: "limits", label: "📊 Лимиты и расход", hint: "Квоты по ролям, расход токенов и диагностика .exe" });

  if (!tabs.some((t) => t.id === appState.activeTab)) {
    appState.activeTab = "chat";
  }

  const root = document.getElementById("app-root");
  root.innerHTML = `
    <div class="app-shell">
      <header class="app-header">
        <div class="header-title-wrap">
          <div class="logo-box">✦</div>
          <div>
            <h1 class="header-title">Чат с ИИ · Desktop Harness</h1>
            <p class="header-subtitle">
              Независимое приложение · БД сайта: <span class="mono">${esc(state.crmUrl)}</span> ·
              <b>${esc(user.name || "")}</b> (${esc(user.roleLabel || user.role || "")})
            </p>
          </div>
        </div>
        <div class="header-actions">
          <span class="badge badge-amber">🧪 Тестовый harness</span>
          ${agentAllowed ? `<span id="hdr-agent-badge" class="badge"><span class="dot ${state.agentHealth?.available ? "dot-green" : "dot-gray"}"></span> Агент</span>` : ""}
          ${operatorAllowed ? `<span id="hdr-op-badge" class="badge"><span class="dot ${state.operatorRunning ? "dot-green" : "dot-gray"}"></span> Оператор</span>` : ""}
          <button type="button" id="btn-refresh-profile" class="btn btn-sm" title="Обновить профиль и лимиты с сервера CRM">↻ Синхронизировать</button>
          <button type="button" id="btn-toggle-theme" class="btn btn-sm" title="Переключить тему">${state.theme === "light" ? "🌙" : "☀️"}</button>
          <button type="button" id="btn-logout" class="btn btn-sm btn-danger">Выйти</button>
        </div>
      </header>

      <nav class="tabs-bar" role="tablist">
        ${tabs.map((t) => `
          <button type="button" role="tab" class="tab-btn ${t.id === appState.activeTab ? "active" : ""}" data-main-tab="${t.id}" title="${esc(t.hint)}">
            ${esc(t.label)}
          </button>
        `).join("")}
      </nav>

      <main id="tabs-panels">
        ${tabs.map((t) => `<section class="tab-panel" id="panel-${t.id}" ${t.id === appState.activeTab ? "" : "hidden"}></section>`).join("")}
      </main>
    </div>
  `;

  const switchTab = (tabId) => {
    appState.activeTab = tabId;
    document.querySelectorAll("[data-main-tab]").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-main-tab") === tabId);
    });
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.hidden = panel.id !== `panel-${tabId}`;
    });
    apiJson("/api/app/prefs", {
      method: "POST",
      body: JSON.stringify({ harnessState: { activeTab: tabId } }),
    }).catch(() => {});
    if (tabId === "limits" && appState.tabsApi.limits?.refresh) {
      appState.tabsApi.limits.refresh();
    }
  };

  document.querySelectorAll("[data-main-tab]").forEach((btn) => {
    btn.onclick = () => switchTab(btn.getAttribute("data-main-tab"));
  });

  document.getElementById("btn-toggle-theme").onclick = async () => {
    const next = state.theme === "light" ? "dark" : "light";
    state.theme = next;
    applyTheme(next);
    document.getElementById("btn-toggle-theme").textContent = next === "light" ? "🌙" : "☀️";
    await apiJson("/api/app/theme", { method: "POST", body: JSON.stringify({ theme: next }) }).catch(() => {});
  };

  document.getElementById("btn-refresh-profile").onclick = async () => {
    try {
      const res = await apiJson("/api/app/crm/refresh", { method: "POST", body: JSON.stringify({}) });
      state.profile = res.profile;
      showToast("Профиль и права обновлены", "ok");
      renderMain(state);
    } catch (err) {
      showToast(err.message, "error");
      if (err.status === 401) await boot();
    }
  };

  document.getElementById("btn-logout").onclick = async () => {
    if (appState.eventsSource) {
      try { appState.eventsSource.close(); } catch {}
      appState.eventsSource = null;
    }
    await apiJson("/api/app/crm/logout", { method: "POST", body: "{}" }).catch(() => {});
    await boot();
  };

  const ctx = {
    getState: () => appState.boot,
    refreshProfile: async () => {
      const res = await apiJson("/api/app/crm/refresh", { method: "POST", body: JSON.stringify({}) });
      appState.boot.profile = res.profile;
      return res.profile;
    },
    updateHeaderStatuses: ({ agentRunning, operatorRunning }) => {
      const ab = document.getElementById("hdr-agent-badge");
      if (ab && agentRunning !== undefined) {
        ab.innerHTML = `<span class="dot ${agentRunning ? "dot-green" : "dot-gray"}"></span> Агент`;
      }
      const ob = document.getElementById("hdr-op-badge");
      if (ob && operatorRunning !== undefined) {
        ob.innerHTML = `<span class="dot ${operatorRunning ? "dot-green" : "dot-gray"}"></span> Оператор`;
      }
    },
    switchToOperatorTab: () => {
      if (operatorAllowed) switchTab("operator");
    },
  };

  appState.tabsApi = {};
  appState.tabsApi.chat = mountChatTab(document.getElementById("panel-chat"), ctx);
  if (agentAllowed) {
    appState.tabsApi.agent = mountAgentTab(document.getElementById("panel-agent"), ctx);
  }
  if (operatorAllowed) {
    appState.tabsApi.operator = mountOperatorTab(document.getElementById("panel-operator"), ctx);
  }
  appState.tabsApi.limits = mountLimitsTab(document.getElementById("panel-limits"), ctx);

  startEventsStream();
}

async function boot(opts = {}) {
  const state = await apiJson("/api/app/state");
  appState.boot = state;
  if (state.harnessState?.activeTab) {
    appState.activeTab = state.harnessState.activeTab;
  }
  if (state.authenticated && !opts.skipRefresh) {
    try {
      const refRes = await apiFetch("/api/app/crm/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (refRes.status === 401) {
        state.authenticated = false;
        state.profile = null;
        authBannerNotice = "Сессия CRM истекла или была сброшена — войдите снова.";
      } else if (refRes.ok) {
        const refData = await refRes.json().catch(() => null);
        if (refData?.profile) state.profile = refData.profile;
      }
    } catch {
      /* сервер временно недоступен — используем сохранённый профиль */
    }
  }
  if (!state.authenticated) {
    renderLogin(state);
    return;
  }
  authBannerNotice = "";
  renderMain(state);
}

boot().catch((err) => {
  const root = document.getElementById("app-root");
  if (root) {
    root.innerHTML = `<div class="login-wrap"><div class="card login-card"><div class="alert-box alert-error">Ошибка запуска: ${esc(err.message)}</div></div></div>`;
  }
});
