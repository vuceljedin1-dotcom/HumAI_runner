export const config = { runtime: "edge" };

type Row = { user_id?: string | null };

export default async function handler(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok");
  try {
    // 1) Auth (mora se poklapati sa edge_secret u app_settings)
    const auth = req.headers.get("authorization");
    if (!auth || auth !== `Bearer ${process.env.EDGE_SHARED_SECRET}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    // 2) Event iz Supabase trigera
    const { table, op, row } = (await req.json()) as {
      table: string;
      op: string;
      row: Row;
    };

    // Obradjujemo intake_forms / daily_logs / sensor_events
    if (!["intake_forms", "daily_logs", "sensor_events"].includes(table)) {
      return new Response(JSON.stringify({ ok: true, skip: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    const user_id = row?.user_id;
    if (!user_id) {
      return new Response(
        JSON.stringify({ ok: true, note: "no user_id" }),
        { headers: { "content-type": "application/json" } }
      );
    }

    // 3) Priprema Supabase Admin REST
    const SUPABASE_URL = process.env.SUPABASE_URL!;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const headers = {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
    };

    const q = encodeURIComponent;

    // 4) Učitaj kontekst iz Supabase (intake, last_log, senzori 24h)
    const intakeRes = await fetch(
      `${SUPABASE_URL}/rest/v1/intake_forms?user_id=eq.${q(user_id)}&select=*&order=created_at.desc&limit=1`,
      { headers }
    );
    const [intake] = await intakeRes.json();

    const logRes = await fetch(
      `${SUPABASE_URL}/rest/v1/daily_logs?user_id=eq.${q(user_id)}&select=*&order=date.desc&limit=1`,
      { headers }
    );
    const [lastLog] = await logRes.json();

    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const sensorsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/sensor_events?user_id=eq.${q(user_id)}&occurred_at=gte.${q(
        since
      )}&select=*&order=occurred_at.desc`,
      { headers }
    );
    const sensors = await sensorsRes.json();

    // 5) Pozovi Hyperstack (tvoj model)
    const hsPayload = {
      user_id,
      intake: intake?.payload ?? {},
      last_log: lastLog ?? {},
      sensors: sensors ?? [],
      need: "generate_next_plan",
    };

    const hsRes = await fetch(process.env.HYPERSTACK_API_URL!, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.HYPERSTACK_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(hsPayload),
    });

    if (!hsRes.ok) {
      const err = await hsRes.text();
      return new Response(
        JSON.stringify({ ok: false, error: `Hyperstack ${hsRes.status}: ${err}` }),
        { status: 502, headers: { "content-type": "application/json" } }
      );
    }

    const hsJson = await hsRes.json(); // tvoj STRICT JSON
    const plan_date = hsJson.plan_date ?? new Date().toISOString().slice(0, 10);

    // 6) Upisi plan u Supabase (plans)
    const insRes = await fetch(`${SUPABASE_URL}/rest/v1/plans`, {
      method: "POST",
      headers,
      body: JSON.stringify([
        { user_id, plan_date, plan: hsJson, source: "hyperstack" },
      ]),
    });

    if (!insRes.ok) {
      const err = await insRes.text();
      return new Response(
        JSON.stringify({ ok: false, error: `Insert plans ${insRes.status}: ${err}` }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }

    // 7) (opcionalno) credentials ako model dodijeli award
    if (hsJson?.effort_status?.award) {
      await fetch(`${SUPABASE_URL}/rest/v1/credentials`, {
        method: "POST",
        headers,
        body: JSON.stringify([
          {
            user_id,
            name: hsJson.effort_status.award,
            meta: hsJson.effort_status,
          },
        ]),
      });
    }

    // 8) Gotovo
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  } catch (e: any) {
    return new Response(
      JSON.stringify({ ok: false, error: String(e?.message || e) }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
}
