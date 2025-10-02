export const config = { runtime: 'edge' };

type Payload = {
  table: string;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  row: Record<string, unknown>;
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const auth = req.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
    const shared = process.env.EDGE_SHARED_SECRET || '';

    if (!shared) return json(500, { ok: false, error: 'Missing env: EDGE_SHARED_SECRET' });
    if (token !== shared) return json(401, { ok: false, error: 'Unauthorized' });

    if (req.method === 'GET') return json(200, { ok: true, service: 'humai-runner' });
    if (req.method !== 'POST') return json(405, { ok: false, error: 'Method Not Allowed' });

    let data: Payload | null = null;
    try { data = (await req.json()) as Payload; }
    catch { return json(400, { ok: false, error: 'Invalid JSON' }); }

    const hsKey = process.env.HYPERSTACK_API_KEY || '';
    const hsModel = process.env.HYPERSTACK_MODEL || 'BPM_HumAI_Absolute_wF';
    if (!hsKey) return json(500, { ok: false, error: 'Missing env: HYPERSTACK_API_KEY' });

    const hsResp = await fetch('https://console.hyperstack.cloud/ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${hsKey}` },
      body: JSON.stringify({
        model: hsModel,
        messages: [
          { role: 'system', content: 'Return STRICT JSON per your contract.' },
          { role: 'user', content: JSON.stringify({ intake: data?.row ?? {}, last_log: {}, sensors: [] }) }
        ],
        stream: false
      })
    });

    const text = await hsResp.text();
    return json(200, { ok: true, source: 'hyperstack', result: text });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || 'Internal Error' });
  }
}