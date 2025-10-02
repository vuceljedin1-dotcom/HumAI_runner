// api/run-humai.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

/** ---- Env guard ---- */
const {
  NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  EDGE_SHARED_SECRET,
  HYPERSTACK_API_KEY,
  HYPERSTACK_MODEL,
} = process.env;

function missing(...keys: string[]) {
  const miss = keys.filter((k) => !(process.env as any)[k]);
  return miss.length ? miss : null;
}

const miss = missing(
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'EDGE_SHARED_SECRET',
  'HYPERSTACK_API_KEY',
  'HYPERSTACK_MODEL'
);
if (miss) {
  // Log u build/runtime; korisniku vraćamo 500 kasnije.
  console.error('Missing env:', miss.join(', '));
}

/** ---- Supabase (service role) ---- */
const supabase = createClient(NEXT_PUBLIC_SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

/** ---- Helpers ---- */
function json(res: VercelResponse, code: number, payload: any) {
  return res.status(code).json(payload);
}

function unauthorized(res: VercelResponse, msg = 'Unauthorized') {
  return json(res, 401, { ok: false, error: msg });
}

/** ---- Hyperstack call ---- */
async function callHyperstack(intake: any, last_log: any, sensors: any[]) {
  // Minimalan, striktan system prompt (model već istreniran na širi kontrakt)
  const system = `You are HumAI. Return STRICT JSON only according to the contract already trained.`;
  const user = JSON.stringify({ intake, last_log, sensors });

  const resp = await fetch('https://console.hyperstack.cloud/ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HYPERSTACK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: HYPERSTACK_MODEL,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });

  const raw = await resp.text();
  try {
    const parsed = JSON.parse(raw);
    // Ako Hyperstack vrati direktno JSON plana (kako si testirao u Playgroundu)
    // parsed je već naš plan objekt. U nekim slučajevima API vraća {choices:[{message:{content:"<json>"}}]}
    if (parsed?.choices?.[0]?.message?.content) {
      return JSON.parse(parsed.choices[0].message.content);
    }
    return parsed;
  } catch (e) {
    throw new Error(`Hyperstack parse error: ${raw.slice(0, 400)}`);
  }
}

/** ---- Main handler ---- */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Health-check / GET
  if (req.method === 'GET') {
    return json(res, 200, { ok: true, service: 'humai-runner', time: new Date().toISOString() });
  }

  if (req.method !== 'POST') {
    return json(res, 405, { ok: false, error: 'Method Not Allowed' });
  }

  if (miss) {
    return json(res, 500, { ok: false, error: `Missing env: ${miss.join(', ')}` });
  }

  // Bearer auth (EDGE_SHARED_SECRET)
  const auth = req.headers['authorization'] || req.headers['Authorization'];
  if (!auth || typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
    return unauthorized(res, 'Missing Bearer token');
  }
  const token = auth.slice('Bearer '.length).trim();
  if (token !== EDGE_SHARED_SECRET) {
    return unauthorized(res, 'Invalid secret');
  }

  // Parse body (Postman / Supabase webhook šalju JSON)
  let body: any;
  try {
    body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
  } catch {
    return json(res, 400, { ok: false, error: 'Bad JSON body' });
  }

  const { table, op, row } = body || {};
  if (!table || !op || !row) {
    return json(res, 400, { ok: false, error: 'Expected {table, op, row}' });
  }

  try {
    // 1) Intake event -> generiši plan preko Hyperstack-a
    if (table === 'intake_forms' && String(op).toUpperCase() === 'INSERT') {
      const user_id = row.user_id;
      const intake = row.payload || {};
      const last_log = {}; // možeš dopuniti čitanjem iz Supabase ako želiš
      const sensors: any[] = []; // isto

      const plan = await callHyperstack(intake, last_log, sensors);

      // Očekuje se JSON sa ključevima: plan_date, daily_plan, training_recs, nutrition_plan, effort_status
      // Upis u public.plans (payload = cijeli plan)
      const { error } = await supabase
        .from('plans')
        .insert({
          user_id,
          plan_date: plan.plan_date, // YYYY-MM-DD
          payload: plan,             // full JSON
        });

      if (error) {
        return json(res, 500, { ok: false, error: `plans insert: ${error.message}` });
      }
      return json(res, 200, { ok: true, source: 'hyperstack', plan });
    }

    // 2) Ostali eventi – za sada samo potvrdi prijem
    if (table === 'daily_logs' || table === 'sensor_events') {
      return json(res, 200, { ok: true, received: { table, op } });
    }

    return json(res, 200, { ok: true, note: `No-op for table ${table}` });
  } catch (e: any) {
    console.error('run-humai error:', e);
    return json(res, 500, { ok: false, error: String(e?.message || e) });
  }
}