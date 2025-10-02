export const config = { runtime: "edge" };
export default async function handler() {
  return new Response(JSON.stringify({ pong: true }), {
    headers: { "content-type": "application/json" }
  });
}
