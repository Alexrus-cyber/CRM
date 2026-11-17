"use client";

import { useActionState } from "react";
import { LogIn } from "lucide-react";
import { loginAction, type LoginState } from "@/app/actions/auth";
import { Button, Field, Input } from "@/components/ui";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, undefined);
  return (
    <form action={action} className="space-y-4">
      <Field label="Email">
        <Input name="email" type="email" placeholder="you@company.ru" autoComplete="email" required />
      </Field>
      <Field label="Пароль">
        <Input name="password" type="password" placeholder="••••••••" autoComplete="current-password" required />
      </Field>
      {state?.error && (
        <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">{state.error}</p>
      )}
      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        <LogIn size={16} />
        {pending ? "Входим..." : "Войти"}
      </Button>
    </form>
  );
}
