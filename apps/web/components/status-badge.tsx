export function NodeStatusBadge({ online }: { online: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        online
          ? "border-online/30 bg-online/10 text-online"
          : "border-night-500 bg-night-800 text-fog-400"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${online ? "bg-online" : "bg-fog-500"}`}
        aria-hidden="true"
      />
      {online ? "Online" : "Offline"}
    </span>
  );
}
