"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { findUserAuthByEmail } from "@/db/repo";
import {
  createSession,
  destroySession,
  ensureSuperAdmin,
  verifyPassword,
} from "@/lib/auth";
import {
  checkLoginRateLimit,
  clearLoginFailures,
  extractClientIp,
  recordLoginFailure,
} from "@/lib/rateLimit";
import { loginInputSchema, parseJsonBody } from "@/lib/validation";

export type LoginState = { error?: string } | undefined;

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = parseJsonBody(
    {
      email: String(formData.get("email") ?? "").trim().toLowerCase(),
      password: String(formData.get("password") ?? ""),
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

  await ensureSuperAdmin();
  const user = await findUserAuthByEmail(parsed.data.email);
  if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
    recordLoginFailure(ip, parsed.data.email);
    return { error: "Неверный email или пароль" };
  }

  clearLoginFailures(ip, parsed.data.email);
  await createSession(user.id, {
    label: "Веб-браузер",
    userAgent,
    ip,
  });
  redirect("/dashboard");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}
