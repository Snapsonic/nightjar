"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { NodeClaimResponse } from "@nightjar/shared";
import { EdgeFunctionError, callEdgeFunction } from "@/lib/edge";

/** Unambiguous claim-code alphabet (no 0/O/1/I/L). */
const CLAIM_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 6;

function sanitizeCode(raw: string): string {
  return raw
    .toUpperCase()
    .split("")
    .filter((ch) => CLAIM_ALPHABET.includes(ch))
    .join("")
    .slice(0, CODE_LENGTH);
}

export function PairForm() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimedNodeId, setClaimedNodeId] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (code.length !== CODE_LENGTH || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await callEdgeFunction("node-claim", { claimCode: code }, NodeClaimResponse);
      setClaimedNodeId(result.nodeId);
    } catch (err) {
      setError(
        err instanceof EdgeFunctionError
          ? err.status === 404
            ? "That code was not found or has expired. Check the node's local UI for a fresh one."
            : err.message
          : "Could not claim the node. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (claimedNodeId) {
    return (
      <div className="rounded-2xl border border-online/25 bg-night-850 p-8 text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-online/10 text-2xl text-online">
          ✓
        </span>
        <h2 className="mt-4 text-lg font-semibold text-fog-100">Node paired</h2>
        <p className="mt-2 text-sm leading-relaxed text-fog-400">
          The node now belongs to your account. It will appear on your dashboard as soon as it
          checks in — its cameras usually follow within a minute.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-lg bg-ember-500 px-4 py-2 text-sm font-semibold text-night-950 transition-colors hover:bg-ember-400"
        >
          Go to dashboard
        </Link>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-night-600 bg-night-850 p-6 sm:p-8"
    >
      <label htmlFor="claim-code" className="block text-xs font-medium text-fog-300">
        Claim code
      </label>
      <input
        id="claim-code"
        value={code}
        onChange={(e) => {
          setCode(sanitizeCode(e.target.value));
          setError(null);
        }}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        inputMode="text"
        placeholder="e.g. 7KM4QZ"
        className="mt-2 w-full rounded-xl border border-night-500 bg-night-900 px-4 py-3 text-center font-mono text-2xl font-semibold tracking-[0.5em] text-ember-300 placeholder:text-night-500 placeholder:tracking-[0.3em] focus:border-ember-500 focus:outline-none"
        aria-describedby="claim-code-hint"
      />
      <p id="claim-code-hint" className="mt-2 text-xs text-fog-500">
        6 characters — letters and digits only, never 0, O, 1, I or L.
      </p>

      {error && (
        <p role="alert" className="mt-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={code.length !== CODE_LENGTH || busy}
        className="mt-5 w-full rounded-lg bg-ember-500 px-4 py-2.5 text-sm font-semibold text-night-950 transition-colors hover:bg-ember-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Claiming…" : "Claim node"}
      </button>
    </form>
  );
}
