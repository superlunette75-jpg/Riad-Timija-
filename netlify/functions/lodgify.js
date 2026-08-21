// =====================================================================
// Riad Timija — Proxy sécurisé vers l'API Lodgify
// La clé API reste côté serveur : elle n'apparaît jamais dans le site.
// Variable d'environnement requise sur Netlify : LODGIFY_API_KEY
// Optionnelle : LODGIFY_GATE (mot de passe partagé de l'app)
// Appel : /.netlify/functions/lodgify?from=2026-06-01&to=2026-06-30
// =====================================================================

export default async (request) => {
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const key = process.env.LODGIFY_API_KEY;
  if (!key) {
    return json(
      { error: "LODGIFY_API_KEY absente. Ajoute-la dans Netlify > Site configuration > Environment variables." },
      500
    );
  }

  // Garde optionnelle : si LODGIFY_GATE est définie, l'appel doit la fournir.
  const gate = process.env.LODGIFY_GATE;
  const url = new URL(request.url);
  if (gate && url.searchParams.get("gate") !== gate) {
    return json({ error: "Accès refusé." }, 401);
  }

  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  // Pagination : Lodgify renvoie les réservations par pages.
  const all = [];
  let page = 1;
  const size = 50;

  try {
    while (page <= 20) {
      const q = new URLSearchParams({
        page: String(page),
        size: String(size),
        includeCount: "true",
        includeTransactions: "false",
      });
      // Filtre sur la période d'arrivée quand elle est fournie.
      if (from) q.set("stayFilter", "Custom"), q.set("stayFilterStart", from);
      if (to) q.set("stayFilterEnd", to);

      const res = await fetch(
        `https://api.lodgify.com/v2/reservations/bookings?${q.toString()}`,
        { headers: { "X-ApiKey": key, accept: "application/json" } }
      );

      if (!res.ok) {
        const text = await res.text();
        return json(
          { error: `Lodgify a répondu ${res.status}`, detail: text.slice(0, 400) },
          res.status === 401 ? 401 : 502
        );
      }

      const data = await res.json();
      const items = Array.isArray(data) ? data : data.items || data.data || [];
      all.push(...items);

      if (items.length < size) break;
      page++;
    }
  } catch (e) {
    return json({ error: "Appel Lodgify impossible", detail: String(e).slice(0, 300) }, 502);
  }

  // Normalisation : on ne renvoie au site que ce qui l'intéresse.
  const bookings = all.map((b) => {
    const room = (b.rooms && b.rooms[0]) || {};
    const guest = b.guest || {};
    const amount =
      b.total_amount ?? b.total ?? b.amount ?? (b.subtotals && b.subtotals.stay) ?? 0;
    return {
      ext_id: String(b.id ?? b.booking_id ?? ""),
      guest: guest.name || b.guest_name || "Client Lodgify",
      arrival: (b.arrival || b.date_arrival || "").slice(0, 10),
      departure: (b.departure || b.date_departure || "").slice(0, 10),
      people: b.people ?? room.people ?? b.guests ?? null,
      amount: Number(amount) || 0,
      currency: (b.currency_code || b.currency || "MAD").toUpperCase(),
      source: b.source_text || b.source || "Lodgify",
      status: b.status || "Booked",
      room: room.name || room.room_type_name || b.property_name || "",
      notes: b.notes || "",
    };
  });

  return json({ count: bookings.length, bookings });
};
