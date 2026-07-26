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

  // Clip links live on nightjar.ca / drive.google.com — a different origin
  // than the app, so an existing app window cannot navigate() there. Open a
  // new window for those instead of silently focusing the wrong page.
  let sameOrigin = true;
  try {
    sameOrigin = new URL(url, self.location.origin).origin === self.location.origin;
  } catch {
    // Unparseable URL — treat as a same-origin path and let openWindow decide.
  }

  event.waitUntil(
    (async () => {
      if (!sameOrigin) {
        await self.clients.openWindow(url);
        return;
      }
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
