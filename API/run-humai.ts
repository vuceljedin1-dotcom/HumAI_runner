// 1) pozovi Hyperstack
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
  return new Response(JSON.stringify({ ok:false, error:`Hyperstack ${hsRes.status}: ${err}` }),
    { status:502, headers:{ "content-type":"application/json" }});
}
const planJson = await hsRes.json();
const plan_date = planJson?.plan_date ?? new Date().toISOString().slice(0,10);

// 2) upiši u Supabase (Service Role!)
const headers = {
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
  "Content-Type": "application/json",
};
const insRes = await fetch(`${process.env.SUPABASE_URL!}/rest/v1/plans`, {
  method: "POST",
  headers,
  body: JSON.stringify([{ user_id, plan_date, plan: planJson, source:"hyperstack" }]),
});
if (!insRes.ok) {
  const err = await insRes.text();
  return new Response(JSON.stringify({ ok:false, error:`Insert plans ${insRes.status}: ${err}` }),
    { status:500, headers:{ "content-type":"application/json" }});
}

// 3) gotovi
return new Response(JSON.stringify({ ok:true }), { headers:{ "content-type":"application/json" }});
