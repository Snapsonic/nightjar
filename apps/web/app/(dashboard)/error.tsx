"use client";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto mt-24 max-w-md rounded-xl border border-night-600 bg-night-800 p-8 text-center">
      <h2 className="text-lg font-semibold text-fog-100">Something went wrong</h2>
      <p className="mt-2 text-sm text-fog-400">{error.message || "An unexpected error occurred."}</p>
      <button
        type="button"
        onClick={reset}
        className="mt-6 rounded-lg bg-ember-500 px-4 py-2 text-sm font-semibold text-night-950 transition-colors hover:bg-ember-400"
      >
        Try again
      </button>
    </div>
  );
}
