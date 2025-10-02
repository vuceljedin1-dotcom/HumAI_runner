export const config = { runtime: 'edge' };

type InPayload = {
  table: string;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  row: Record<string, unknown>;
};

type HumAIPlan = {
  plan_date: string; // "YYYY-MM-DD"
  daily_plan: unknown;
  training_recs: unknown;
  nutrition_plan: unknown;
  effort_status: unknown;
};

function j(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, content-type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    }
  });
}

function bad(msg: string, status = 400) {
  return j(status, { ok: false, error: msg });
}

// pokušaj robustnog parse-a (Hyperstack vraća JSON, ali nekad ga je sigurnije “izvući”)
function safeParseJson(text: string): any {
  try { return JSON.parse(text); } catch {}
  // fallback: probaj izdvojiti prvi { ... } blok
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  throw new Error('Hyperstack returned non-JSON');
}

export default async function handler(req: Request): Promise<Response> {
  // CORS preflight
  if (req.method === 'OPTIONS') return j(204, { ok: true });

  try {
    // 1) Auth
    const auth = req.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const shared = process.env.EDGE_SHARED_SECRET || '';
    if (!shared) return bad('Missing env: EDGE_SHARED_SECRET', 500);
    if (token !== shared) return bad('Unauthorized', 401);

    if (req.method === 'GET') {
      return j(200, { ok: true, service: 'humai-runner' });
    }
    if (req.method !== 'POST') {
      return bad('Method Not Allowed', 405);
    }

    // 2) Body
    let incoming: InPayload;
    try {
      incoming = (await req.json()) as InPayload;
    } catch {
      return bad('Invalid JSON body');
    }

    const userId =
      (incoming?.row?.['user_id'] as string | undefined) ??
      (incoming?.row?.['uid'] as string | undefined);
    if (!userId) return bad('row.user_id is required');

    // 3) Hyperstack call
    const hsKey = process.env.HYPERSTACK_API_KEY || '';
    const hsModel = process.env.HYPERSTACK_MODEL || 'BPM_HumAI_Absolute_wF';
    if (!hsKey) return bad('Missing env: HYPERSTACK_API_KEY', 500);

    const hsResp = await fetch(
      'https://console.hyperstack.cloud/ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${hsKey}`
        },
        body: JSON.stringify({
          model: hsModel,
          messages: [
            {
              role: 'system',
              content:
                'You are HumAI. Return STRICT JSON according to the BPM contract – one single JSON object only.'
            },
            {
              role: 'user',
              content: JSON.stringify({
                intake: incoming?.row ?? {},
                last_log: {},
                sensors: []
              })
            }
          ],
          stream: false
        })
      }
    );

    const hsText = await hsResp.text();
    if (!hsResp.ok) {
      return bad(
        `Hyperstack ${hsResp.status}: ${hsText?.slice(0, 300) || 'error'}`,
        502
      );
    }

    let plan: HumAIPlan;
    try {
      plan = safeParseJson(hsText) as HumAIPlan;
    } catch (e: any) {
      return bad(`Parse HS JSON failed: ${e?.message || e}`, 502);
    }

    // 4) Upis u Supabase (REST)
    const sbUrl = process.env.SUPABASE_URL || '';
    const sbService = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!sbUrl) return bad('Missing env: SUPABASE_URL', 500);
    if (!sbService) return bad('Missing env: SUPABASE_SERVICE_ROLE_KEY', 500);

    // pretpostavka: public.plans(user_id, plan_date, payload jsonb)
    const insertBody = [
      { user_id: userId, plan_date: plan.plan_date, payload: plan }
    ];

    const sbResp = await fetch(`${sbUrl}/rest/v1/plans`, {
      method: 'POST',
      headers: {
        apikey: sbService,
        Authorization: `Bearer ${sbService}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify(insertBody)
    });

    const sbText = await sbResp.text();
    if (!sbResp.ok) {
      return bad(
        `Supabase insert ${sbResp.status}: ${sbText?.slice(0, 300) || 'error'}`,
        502
      );
    }

    // 5) Response
    return j(200, {
      ok: true,
      source: 'hyperstack',
      plan,           // šta smo dobili od HS
      db_result: safeParseJson(sbText) // vraća inserted row iz PostgREST-a
    });
  } catch (e: any) {
    return j(500, { ok: false, error: e?.message || 'Internal Error' });
  }
}