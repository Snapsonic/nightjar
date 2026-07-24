import type { Metadata } from "next";
import { LoginForm } from "@/components/login-form";
import { Wordmark } from "@/components/wordmark";

export const metadata: Metadata = {
  title: "Sign in — Nightjar",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const initialError =
    params.error === "auth" ? "That sign-in link is invalid or has expired. Try again." : null;

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <div className="mb-8">
        <Wordmark />
      </div>
      <LoginForm initialError={initialError} />
      <p className="mt-8 max-w-sm text-center text-xs leading-relaxed text-fog-500">
        Nightjar is an open-source NVR — your cameras record at home, and this cloud keeps you
        connected to them.{" "}
        <a
          href="https://github.com/Snapsonic/nightjar"
          target="_blank"
          rel="noreferrer"
          className="text-fog-400 underline-offset-2 hover:text-ember-300 hover:underline"
        >
          Read the quickstart
        </a>
        .
      </p>
    </div>
  );
}
