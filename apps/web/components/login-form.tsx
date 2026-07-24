"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { getBrowserClient } from "@/lib/supabase/client";

type Mode = "signin" | "signup";

export function LoginForm({ initialError }: { initialError: string | null }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"password" | "magic" | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);

  const emailRedirectTo = () => `${window.location.origin}/auth/callback`;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy("password");
    setError(null);
    setNotice(null);
    const supabase = getBrowserClient();
    try {
      if (mode === "signin") {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) {
          setError(err.message);
          return;
        }
        router.push("/");
        router.refresh();
      } else {
        const { data, error: err } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: emailRedirectTo() },
        });
        if (err) {
          setError(err.message);
          return;
        }
        if (data.session) {
          router.push("/");
          router.refresh();
        } else {
          setNotice("Check your email to confirm your account, then come back and sign in.");
        }
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleMagicLink() {
    if (!email) {
      setError("Enter your email first, then request a magic link.");
      return;
    }
    setBusy("magic");
    setError(null);
    setNotice(null);
    const supabase = getBrowserClient();
    try {
      const { error: err } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: emailRedirectTo() },
      });
      if (err) setError(err.message);
      else setNotice("Magic link sent — check your email and open the link on this device.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="w-full max-w-sm rounded-2xl border border-night-600 bg-night-850 p-6 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)] sm:p-8">
      <div className="mb-6 grid grid-cols-2 rounded-lg bg-night-800 p-1 text-sm font-medium">
        {(
          [
            ["signin", "Sign in"],
            ["signup", "Create account"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              setMode(value);
              setError(null);
              setNotice(null);
            }}
            className={`rounded-md px-3 py-1.5 transition-colors ${
              mode === value
                ? "bg-night-600 text-fog-100"
                : "text-fog-400 hover:text-fog-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="email" className="mb-1.5 block text-xs font-medium text-fog-300">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-night-500 bg-night-900 px-3 py-2 text-sm text-fog-100 placeholder:text-fog-500 outline-none transition-colors focus:border-ember-500"
            placeholder="you@example.com"
          />
        </div>
        <div>
          <label htmlFor="password" className="mb-1.5 block text-xs font-medium text-fog-300">
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            minLength={8}
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-night-500 bg-night-900 px-3 py-2 text-sm text-fog-100 placeholder:text-fog-500 outline-none transition-colors focus:border-ember-500"
            placeholder="••••••••"
          />
        </div>

        {error && (
          <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="rounded-lg border border-ember-500/30 bg-ember-500/10 px-3 py-2 text-xs text-ember-300">
            {notice}
          </p>
        )}

        <button
          type="submit"
          disabled={busy !== null}
          className="w-full rounded-lg bg-ember-500 px-4 py-2.5 text-sm font-semibold text-night-950 transition-colors hover:bg-ember-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy === "password"
            ? "Working…"
            : mode === "signin"
              ? "Sign in"
              : "Create account"}
        </button>
      </form>

      <div className="my-5 flex items-center gap-3 text-[11px] uppercase tracking-wider text-fog-500">
        <span className="h-px flex-1 bg-night-600" />
        or
        <span className="h-px flex-1 bg-night-600" />
      </div>

      <button
        type="button"
        onClick={handleMagicLink}
        disabled={busy !== null}
        className="w-full rounded-lg border border-night-500 bg-night-800 px-4 py-2.5 text-sm font-medium text-fog-200 transition-colors hover:border-ember-500/50 hover:text-fog-100 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy === "magic" ? "Sending…" : "Email me a magic link"}
      </button>
    </div>
  );
}
