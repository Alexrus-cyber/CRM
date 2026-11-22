"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AI_DEFAULT_BASE_URL, AI_STORAGE_SETTINGS, type AiSettings } from "./ai";

export type AiServerSettingsMeta = {
  hasApiKey: boolean;
  apiKeyHint: string | null;
};

type PublicSettings = {
  baseUrl: string;
  model: string;
};

const DEFAULT_PUBLIC: PublicSettings = {
  baseUrl: AI_DEFAULT_BASE_URL,
  model: "",
};

function readPublicSettings(): PublicSettings {
  if (typeof window === "undefined") return DEFAULT_PUBLIC;
  try {
    const raw = window.localStorage.getItem(AI_STORAGE_SETTINGS);
    if (!raw) return DEFAULT_PUBLIC;
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    return {
      baseUrl: String(parsed.baseUrl ?? "").trim() || DEFAULT_PUBLIC.baseUrl,
      model: String(parsed.model ?? ""),
    };
  } catch {
    return DEFAULT_PUBLIC;
  }
}

function writePublicSettings(value: PublicSettings) {
  if (typeof window === "undefined") return;
  try {
    // Никогда не сохраняем apiKey в localStorage — только не-секретные baseUrl и model.
    window.localStorage.setItem(
      AI_STORAGE_SETTINGS,
      JSON.stringify({ baseUrl: value.baseUrl, model: value.model }),
    );
  } catch {
    /* приватный режим */
  }
}

/**
 * Управление настройками провайдера ИИ без хранения apiKey в localStorage.
 * baseUrl и model кешируются в localStorage для мгновенного отображения, а apiKey
 * держится в памяти только на время ввода и шифруется на сервере через `/api/ai/settings`.
 */
export function useAiSettings() {
  const [settings, setSettingsState] = useState<AiSettings>({
    baseUrl: DEFAULT_PUBLIC.baseUrl,
    apiKey: "",
    model: DEFAULT_PUBLIC.model,
  });
  const [serverMeta, setServerMeta] = useState<AiServerSettingsMeta>({
    hasApiKey: false,
    apiKeyHint: null,
  });
  const [saving, setSaving] = useState(false);

  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const syncTimerRef = useRef<number | null>(null);

  const pushToServer = useCallback(
    async (payload: { baseUrl?: string; model?: string; apiKey?: string; clearApiKey?: boolean }) => {
      setSaving(true);
      try {
        const res = await fetch("/api/ai/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res || !res.ok) return;
        const data = (await res.json().catch(() => null)) as {
          settings?: { baseUrl?: string; model?: string; hasApiKey?: boolean; apiKeyHint?: string | null };
        } | null;
        if (data?.settings) {
          setServerMeta({
            hasApiKey: Boolean(data.settings.hasApiKey),
            apiKeyHint: data.settings.apiKeyHint ?? null,
          });
        }
      } catch {
        /* сервер недоступен или работает офлайн */
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  // Инициализация: подгружаем localStorage (вычищая устаревший открытый apiKey!) и серверные настройки.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      const local = readPublicSettings();
      let legacyApiKey = "";
      try {
        const raw = window.localStorage.getItem(AI_STORAGE_SETTINGS);
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<AiSettings>;
          if (typeof parsed.apiKey === "string") {
            legacyApiKey = parsed.apiKey.trim();
            writePublicSettings(local);
          }
        }
      } catch {
        /* ignore */
      }

      setSettingsState((prev) => ({
        ...prev,
        baseUrl: local.baseUrl,
        model: local.model,
        apiKey: legacyApiKey || prev.apiKey,
      }));

      if (legacyApiKey) {
        await pushToServer({ baseUrl: local.baseUrl, model: local.model, apiKey: legacyApiKey });
      }
      try {
        const res = await fetch("/api/ai/settings", { cache: "no-store" });
        if (!res || !res.ok || cancelled) return;
        const data = (await res.json().catch(() => null)) as {
          settings?: { baseUrl?: string; model?: string; hasApiKey?: boolean; apiKeyHint?: string | null };
        } | null;
        const s = data?.settings;
        if (!s || cancelled) return;

        setServerMeta({
          hasApiKey: Boolean(s.hasApiKey),
          apiKeyHint: s.apiKeyHint ?? null,
        });
        const merged: PublicSettings = {
          baseUrl: s.baseUrl?.trim() || local.baseUrl,
          model: s.model?.trim() || local.model,
        };
        writePublicSettings(merged);
        setSettingsState((prev) => ({
          ...prev,
          baseUrl: merged.baseUrl,
          model: merged.model,
        }));
      } catch {
        /* ignore in tests/offline */
      }
    })();

    return () => {
      cancelled = true;
      if (syncTimerRef.current !== null) window.clearTimeout(syncTimerRef.current);
    };
  }, [pushToServer]);

  const scheduleSync = useCallback(
    (next: AiSettings) => {
      if (syncTimerRef.current !== null) window.clearTimeout(syncTimerRef.current);
      syncTimerRef.current = window.setTimeout(() => {
        syncTimerRef.current = null;
        const payload: { baseUrl: string; model: string; apiKey?: string } = {
          baseUrl: next.baseUrl.trim() || AI_DEFAULT_BASE_URL,
          model: next.model.trim(),
        };
        if (next.apiKey.trim()) payload.apiKey = next.apiKey.trim();
        void pushToServer(payload);
      }, 600);
    },
    [pushToServer],
  );

  const setSettings = useCallback(
    (next: AiSettings | ((prev: AiSettings) => AiSettings)) => {
      setSettingsState((prev) => {
        const resolved = typeof next === "function" ? next(prev) : next;
        writePublicSettings({
          baseUrl: resolved.baseUrl.trim() || AI_DEFAULT_BASE_URL,
          model: resolved.model,
        });
        scheduleSync(resolved);
        return resolved;
      });
    },
    [scheduleSync],
  );

  const updateSettings = useCallback(
    (patch: Partial<AiSettings>) => {
      setSettings((prev) => ({ ...prev, ...patch }));
    },
    [setSettings],
  );

  const persistSettings = useCallback(
    async (override?: Partial<AiSettings> & { clearApiKey?: boolean }) => {
      if (syncTimerRef.current !== null) {
        window.clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
      const cur = settingsRef.current;
      const merged: AiSettings = {
        baseUrl: override?.baseUrl ?? cur.baseUrl,
        model: override?.model ?? cur.model,
        apiKey: override?.apiKey ?? cur.apiKey,
      };
      const payload: { baseUrl: string; model: string; apiKey?: string; clearApiKey?: boolean } = {
        baseUrl: merged.baseUrl.trim() || AI_DEFAULT_BASE_URL,
        model: merged.model.trim(),
      };
      if (override?.clearApiKey) {
        payload.clearApiKey = true;
      } else if (merged.apiKey.trim()) {
        payload.apiKey = merged.apiKey.trim();
      }
      await pushToServer(payload);
    },
    [pushToServer],
  );

  const clearSavedKey = useCallback(async () => {
    setSettingsState((prev) => ({ ...prev, apiKey: "" }));
    setServerMeta({ hasApiKey: false, apiKeyHint: null });
    await persistSettings({ apiKey: "", clearApiKey: true });
  }, [persistSettings]);

  const resetSettings = useCallback(async () => {
    const clean: AiSettings = { baseUrl: AI_DEFAULT_BASE_URL, apiKey: "", model: "" };
    writePublicSettings({ baseUrl: clean.baseUrl, model: clean.model });
    setSettingsState(clean);
    setServerMeta({ hasApiKey: false, apiKeyHint: null });
    await persistSettings({ baseUrl: clean.baseUrl, model: "", apiKey: "", clearApiKey: true });
  }, [persistSettings]);

  return {
    settings,
    serverMeta,
    saving,
    setSettings,
    updateSettings,
    persistSettings,
    clearSavedKey,
    resetSettings,
  };
}
