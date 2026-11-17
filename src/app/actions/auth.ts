"use server";

import { redirect } from "next/navigation";
import { findUserAuthByEmail } from "@/db/repo";
import {
  createSession,
  destroySession,
  ensureSuperAdmin,
  verifyPassword,
} from "@/lib/auth";

export type LoginState = { error?: string } | undefined;

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) {
    return { error: "Введите email и пароль" };
  }
  await ensureSuperAdmin();
  const user = await findUserAuthByEmail(email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return { error: "Неверный email или пароль" };
  }
  await createSession(user.id);
  redirect("/dashboard");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}
