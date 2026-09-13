// =====================================================================
// Riad Timija — Proxy sécurisé vers l'API Lodgify
// La clé API reste côté serveur : elle n'apparaît jamais dans le site.
// Variable d'environnement requise sur Netlify : LODGIFY_API_KEY
// Optionnelle : LODGIFY_GATE (mot de passe partagé de l'app)
//
// Appels :
//   /.netlify/functions/lodgify?from=2026-06-01&to=2026-06-30
//   /.netlify/functions/lodgify?debug=1          -> diagnostic brut
//   /.netlify/functions/lodgify?debug=1&raw=1    -> 1re réservation complète
// =====================================================================

export default async (request) => {
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body, null, 2), {
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

  const gate = process.env.LODGIFY_GATE;
  const url = new URL(request.url);
  if (gate && url.searchParams.get("gate") !== gate) {
    return json({ error: "Accès refusé." }, 401);
  }

  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const debug = url.searchParams.get("debug") === "1";
  const raw = url.searchParams.get("raw") === "1";

  // -------------------------------------------------------------------
  // Lecture complète. stayFilter n'accepte QUE Upcoming | Current |
  // Historic | All. Toute autre valeur (ex. Custom) renvoie 400.
  // On lit donc tout, on filtre les dates nous-mêmes plus bas.
  // -------------------------------------------------------------------
  const all = [];
  const size = 50;
  const maxPages = 40;
  let page = 1;
  let apiCount = null;
  let lastUrl = "";

  try {
    while (page <= maxPages) {
      const q = new URLSearchParams({
        stayFilter: "All",
        page: String(page),
        size: String(size),
        includeCount: "true",
        includeTransactions: "false",
      });

      lastUrl = `https://api.lodgify.com/v2/reservations/bookings?${q}`;
      const res = await fetch(lastUrl, {
        headers: { "X-ApiKey": key, accept: "application/json" },
      });

      if (!res.ok) {
        const text = await res.text();
        return json(
          {
            error: `Lodgify a répondu ${res.status}`,
            detail: text.slice(0, 800),
            requested: lastUrl,
            page,
          },
          res.status === 401 ? 401 : 502
        );
      }

      const data = await res.json();
      const items = Array.isArray(data) ? data : data.items || data.data || [];
      if (apiCount === null && !Array.isArray(data)) {
        apiCount = data.count ?? data.total_count ?? data.totalCount ?? null;
      }
      all.push(...items);

      if (items.length < size) break;
      page++;
    }
  } catch (e) {
    return json({ error: "Appel Lodgify impossible", detail: String(e).slice(0, 400) }, 502);
  }

  // -------------------------------------------------------------------
  // Extraction du montant : les noms de champs varient selon le plan et
  // la version de l'API. On cherche dans l'ordre, puis en dernier
  // recours on scanne récursivement les clés qui ressemblent à un total.
  // -------------------------------------------------------------------
  const num = (v) => {
    const n = typeof v === "string" ? Number(v.replace(",", ".")) : Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  const deepAmount = (obj, depth = 0) => {
    if (!obj || typeof obj !== "object" || depth > 3) return 0;
    const keys = Object.keys(obj);
    // priorité aux clés qui contiennent total
    const ranked = keys.sort((a, b) => {
      const score = (k) => (/total/i.test(k) ? 0 : /amount|price|gross|revenue/i.test(k) ? 1 : 2);
      return score(a) - score(b);
    });
    for (const k of ranked) {
      const v = obj[k];
      if (typeof v === "number" || typeof v === "string") {
        if (
          /(total|amount|price|gross|revenue)/i.test(k) &&
          !/id|count|nights|guests|people|tax_rate|paid|due|refund|balance/i.test(k)
        ) {
          const n = num(v);
          if (n) return n;
        }
      } else if (v && typeof v === "object" && !Array.isArray(v)) {
        const n = deepAmount(v, depth + 1);
        if (n) return n;
      }
    }
    return 0;
  };

  const pickAmount = (b) => {
    const cands = [
      b.total_amount,
      b.totalAmount,
      b.amount,
      b.total,
      b.amount_gross,
      b.price,
      b.subtotals && b.subtotals.stay,
      b.quote && b.quote.total_amount,
      b.currency && b.currency.total_amount,
    ];
    for (const c of cands) {
      const n = num(typeof c === "object" && c ? c.amount ?? c.total ?? c.value : c);
      if (n) return n;
    }
    return deepAmount(b);
  };

  const pickCurrency = (b) =>
    String(
      b.currency_code ||
        (typeof b.currency === "string" ? b.currency : b.currency && b.currency.code) ||
        (b.subtotals && b.subtotals.currency_code) ||
        "MAD"
    ).toUpperCase();

  // Table room_type_id -> nom, construite depuis les proprietes. L'endpoint
  // peut ne pas repondre selon le plan : dans ce cas on laisse la chambre vide.
  const roomNames = {};
  try {
    const propIds = [...new Set(all.map((b) => b.property_id).filter(Boolean))];
    for (const pid of propIds.slice(0, 5)) {
      const r = await fetch(`https://api.lodgify.com/v2/properties/${pid}/rooms`, {
        headers: { "X-ApiKey": key, accept: "application/json" },
      });
      if (!r.ok) continue;
      const rooms = await r.json();
      (Array.isArray(rooms) ? rooms : rooms.items || []).forEach((rt) => {
        const id = rt.id ?? rt.room_type_id;
        const nm = rt.name || rt.room_type_name || rt.title;
        if (id && nm) roomNames[String(id)] = nm;
      });
    }
  } catch (e) {
    /* silencieux : le nom de chambre est un confort, pas une donnee critique */
  }

  const normalize = (b) => {
    const room = (b.rooms && b.rooms[0]) || {};
    const guest = b.guest || {};
    const gb = room.guest_breakdown || {};
    const people =
      b.people ?? room.people ?? b.guests ?? ((gb.adults || 0) + (gb.children || 0) || null);
    return {
      ext_id: String(b.id ?? b.booking_id ?? ""),
      guest: guest.name || b.guest_name || "Client Lodgify",
      arrival: String(b.arrival || b.date_arrival || "").slice(0, 10),
      departure: String(b.departure || b.date_departure || "").slice(0, 10),
      people,
      amount: pickAmount(b),
      currency: pickCurrency(b),
      source: b.source || b.source_text || "Lodgify",
      status: b.status || "Booked",
      room:
        room.name ||
        room.room_type_name ||
        roomNames[String(room.room_type_id)] ||
        "",
      notes: b.notes || "",
    };
  };

  let bookings = all
    .filter((b) => !b.is_deleted)
    .map(normalize)
    .filter((b) => b.ext_id && b.arrival);

  // Filtre local sur la date d'arrivée (format ISO, comparaison de chaînes)
  const total = bookings.length;
  if (from) bookings = bookings.filter((b) => b.arrival >= from);
  if (to) bookings = bookings.filter((b) => b.arrival <= to);

  if (debug) {
    const sample = all[0] || null;
    return json({
      ok: true,
      requested: lastUrl,
      pages_lues: page,
      count_api: apiCount,
      recus_bruts: all.length,
      apres_normalisation: total,
      apres_filtre_dates: bookings.length,
      filtre: { from, to },
      champs_disponibles: sample ? Object.keys(sample) : [],
      montant_detecte: sample ? pickAmount(sample) : null,
      chambres_resolues: roomNames,
      devise_detectee: sample ? pickCurrency(sample) : null,
      exemple_normalise: bookings[0] || null,
      exemple_brut: raw ? sample : "ajoute &raw=1 pour voir la réservation brute complète",
    });
  }

  return json({ count: bookings.length, total_lodgify: total, bookings });
};
