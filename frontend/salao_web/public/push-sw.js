self.addEventListener("push", (event) => {
  let dados = {};
  try {
    dados = event.data ? event.data.json() : {};
  } catch {
    dados = { body: event.data ? event.data.text() : "Você tem um novo alerta." };
  }

  const titulo = dados.title || "GlowApp";
  const opcoes = {
    body: dados.body || "Você tem um novo alerta.",
    icon: "/glowapp-icon.png",
    badge: "/favicon-32.png",
    tag: dados.tag || "glowapp-alerta",
    data: dados.data || { url: "/alertas" },
  };
  event.waitUntil(self.registration.showNotification(titulo, opcoes));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destino = event.notification.data?.url || "/alertas";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientes) => {
      const existente = clientes.find((cliente) => "focus" in cliente);
      if (existente) {
        existente.navigate(destino);
        return existente.focus();
      }
      return self.clients.openWindow(destino);
    }),
  );
});
