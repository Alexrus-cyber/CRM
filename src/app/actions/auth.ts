"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { findUserAuthByEmail } from "@/db/repo";
import {
  createSession,
  destroySession,
  verifyPasswordAsync,
  verifyUserTotp,
} from "@/lib/auth";
import {
  checkLoginRateLimit,
  clearLoginFailures,
  extractClientIp,
  recordLoginFailure,
} from "@/lib/rateLimit";
import { loginInputSchema, parseJsonBody } from "@/lib/validation";

export type LoginState =
  | { error?: string; requiresTotp?: boolean; email?: string }
  | undefined;

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const rawEmail = String(formData.get("email") ?? "").trim().toLowerCase();
  const rawPassword = String(formData.get("password") ?? "");
  const rawTotp = String(formData.get("totpCode") ?? "").trim();

  const parsed = parseJsonBody(
    {
      email: rawEmail,
      password: rawPassword,
      totpCode: rawTotp || undefined,
    },
    loginInputSchema,
    "Введите email и пароль",
  );
  if (!parsed.ok) {
    return { error: parsed.error };
  }

  const hdrs = await headers();
  const ip = extractClientIp(hdrs);
  const userAgent = (hdrs.get("user-agent") ?? "").slice(0, 300);

  const limit = checkLoginRateLimit(ip, parsed.data.email);
  if (!limit.allowed) {
    return {
      error: `Слишком много попыток входа. Повторите через ${limit.retryAfterSec} сек.`,
    };
  }

  const user = await findUserAuthByEmail(parsed.data.email);
  if (!user || !(await verifyPasswordAsync(parsed.data.password, user.passwordHash))) {
    recordLoginFailure(ip, parsed.data.email);
    return { error: "Неверный email или пароль" };
  }

  if (user.totpEnabled) {
    const code = parsed.data.totpCode ?? "";
    if (!code) {
      return {
        requiresTotp: true,
        email: parsed.data.email,
        error: "Введите 6-значный код из приложения-аутентификатора (2FA)",
      };
    }
    const validTotp = await verifyUserTotp(user.id, code);
    if (!validTotp) {
      recordLoginFailure(ip, parsed.data.email);
      return {
        requiresTotp: true,
        email: parsed.data.email,
        error: "Неверный код 2FA",
      };
    }
  }

  clearLoginFailures(ip, parsed.data.email);
  await createSession(user.id, {
    label: "Веб-браузер",
    userAgent,
    ip,
  });

  if (user.mustChangePassword) {
    redirect("/profile?forcePasswordChange=1");
  }
  redirect("/dashboard");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}
