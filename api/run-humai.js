// api/run-humai.js
export const config = { runtime: "edge" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function authOk(req) {
  const expected = `Bearer ${requireEnv("EDGE_SHARED_SECRET")}`;
  const got = req.headers.get("authorization") || "";
  return got === expected;
}

function enc(v) {
  return encodeURIComponent(v);
}

export default async function handler(req) {
  try {
    if (req.method === "OPTIONS") return new Response("ok");

    // 1) Auth
    if (!authOk(req)) return json({ ok: false, error: "Unauthorized" }, 401);

    // 2) Body (Supabase trigger ili ručni cURL)
    const { table, op, row } = await req.json();

    // podržavamo ova 3 stola; ostalo preskačemo
    if (!["intake_forms", "daily_logs", "sensor_events"].includes(table)) {
      return json({ ok: true, skip: true, table, op });
    }

    const user_id = row && row.user_id;
    if (!user_id) return json({ ok: true, note: "no user_id" });

    // 3) Supabase admin REST (Service Role!)
    const SUPABASE_URL = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
    const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const sHeaders = {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
    };

    // 4) Učitaj kontekst: intake (zadnji), last_log (zadnji), senzori (24h)
    const [intakeRes, lastLogRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/intake_forms?user_id=eq.${enc(
          user_id
        )}&select=*&order=created_at.desc&limit=1`,
        { headers: sHeaders }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/daily_logs?user_id=eq.${enc(
          user_id
        )}&select=*&order=date.desc&limit=1`,
        { headers: sHeaders }
      ),
    ]);

    if (!intakeRes.ok) {
      return json(
        { ok: false, error: `intake_forms ${intakeRes.status}: ${await intakeRes.text()}` },
        500
      );
    }
    if (!lastLogRes.ok) {
      return json(
        { ok: false, error: `daily_logs ${lastLogRes.status}: ${await lastLogRes.text()}` },
        500
      );
    }

    const [intake] = await intakeRes.json();
    const [last_log] = await lastLogRes.json();

    const sinceISO = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const sensorsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/sensor_events?user_id=eq.${enc(
        user_id
      )}&occurred_at=gte.${enc(sinceISO)}&select=*&order=occurred_at.desc`,
      { headers: sHeaders }
    );
    if (!sensorsRes.ok) {
      return json(
        { ok: false, error: `sensor_events ${sensorsRes.status}: ${await sensorsRes.text()}` },
        500
      );
    }
    const sensors = await sensorsRes.json();

    // 5) Hyperstack poziv
    const HYPERSTACK_API_URL = requireEnv("HYPERSTACK_API_URL");
    const HYPERSTACK_API_KEY = requireEnv("HYPERSTACK_API_KEY");

    const hsPayload = {
      user_id,
      intake: (intake && intake.payload) || {},
      last_log: last_log || {},
      sensors: sensors || [],
      need: "generate_next_plan",
    };

    const hsRes = await fetch(HYPERSTACK_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HYPERSTACK_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(hsPayload),
    });

    if (!hsRes.ok) {
      const err = await hsRes.text();
      return json({ ok: false, error: `Hyperstack ${hsRes.status}: ${err}` }, 502);
    }

    const planJson = await hsRes.json();
    const plan_date =
      (planJson && planJson.plan_date) || new Date().toISOString().slice(0, 10);

    // 6) Insert u public.plans
    const insRes = await fetch(`${SUPABASE_URL}/rest/v1/plans`, {
      method: "POST",
      headers: sHeaders,
      body: JSON.stringify([{ user_id, plan_date, plan: planJson, source: "hyperstack" }]),
    });

    if (!insRes.ok) {
      const err = await insRes.text();
      return json({ ok: false, error: `Insert plans ${insRes.status}: ${err}` }, 500);
    }

    // 7) (opciono) award → credentials
    const award = planJson && planJson.effort_status && planJson.effort_status.award;
    if (award) {
      await fetch(`${SUPABASE_URL}/rest/v1/credentials`, {
        method: "POST",
        headers: sHeaders,
        body: JSON.stringify([{ user_id, name: award, meta: planJson.effort_status || null }]),
      });
    }

    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
  }
}
