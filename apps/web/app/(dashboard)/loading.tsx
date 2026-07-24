export default function DashboardLoading() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center" role="status" aria-label="Loading">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-night-500 border-t-ember-400" />
    </div>
  );
}
