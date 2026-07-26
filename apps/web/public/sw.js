// Nightjar service worker — Web Push only (no fetch caching).
// Payload sent by the notify edge function:
//   { title, body, timestamp?, tag, url }

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Non-JSON payload — fall through to defaults.
  }

  let body = typeof data.body === "string" ? data.body : "";
  if (typeof data.timestamp === "number") {
    // The server only knows UTC; reformat the event time for this device.
    const at = new Date(data.timestamp);
    const hh = String(at.getHours()).padStart(2, "0");
    const mm = String(at.getMinutes()).padStart(2, "0");
    body = `at ${hh}:${mm}`;
  }

  event.waitUntil(
    self.registration.showNotification(
      typeof data.title === "string" ? data.title : "Nightjar",
      {
        body,
        tag: typeof data.tag === "string" ? data.tag : "nightjar",
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        data: { url: typeof data.url === "string" ? data.url : "/events" },
      },
    ),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/events";

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) {
            try {
              await client.navigate(url);
            } catch {
              // Cross-origin or detached client — leave it focused.
            }
          }
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
