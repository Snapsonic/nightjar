import type { Metadata } from "next";
import { PairForm } from "@/components/pair-form";

export const metadata: Metadata = {
  title: "Pair a node — Nightjar",
};

export default function PairPage() {
  return (
    <div className="mx-auto max-w-lg">
      <h1 className="text-xl font-semibold tracking-tight text-fog-100">Pair a node</h1>
      <p className="mt-2 text-sm leading-relaxed text-fog-400">
        Install a Nightjar node on your own hardware, open its local UI and enter the 6-character
        claim code it shows you. New here? Follow the{" "}
        <a
          href="https://github.com/Snapsonic/nightjar"
          target="_blank"
          rel="noreferrer"
          className="text-ember-400 underline-offset-2 hover:underline"
        >
          GitHub quickstart
        </a>
        .
      </p>
      <div className="mt-6">
        <PairForm />
      </div>
    </div>
  );
}
