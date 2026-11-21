import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

export async function startMaterialFixture() {
  const nonce = randomBytes(24).toString("hex");
  const prefix = `/material-${randomBytes(12).toString("hex")}/`;
  let page = 1, sequence = 0, next = 0, previous = 0, rejectedEvents = 0;
  let ready = false;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Local material smoke</title>
<style>body{margin:24px;font:18px sans-serif}button{min-width:140px;min-height:44px;margin:12px}article{min-height:180px}</style></head>
<body><h1>Synthetic material pages</h1><p>Page <strong id="page-number">1</strong></p>
<article id="items">Synthetic material on page 1</article><button data-next>Next page</button><button data-prev>Previous page</button>
<script>
const nonce = ${JSON.stringify(nonce)};
let page = 1, sequence = 0, pending = false;
async function flip(direction) {
  if (pending) return;
  const from = page, to = direction === 'next' ? from + 1 : from - 1;
  if (to < 1) return;
  pending = true;
  try {
    // Update real visible content before submitting external transition evidence.
    page = to;
    document.getElementById('page-number').textContent = String(page);
    document.getElementById('items').textContent = 'Synthetic material on page ' + page;
    const response = await fetch('event', {method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({nonce,direction,from,to,sequence:++sequence})});
    if (!response.ok) document.body.dataset.eventFailure = 'true';
  } finally { pending = false; }
}
document.querySelector('[data-next]').addEventListener('click',()=>flip('next'));
document.querySelector('[data-prev]').addEventListener('click',()=>flip('prev'));
addEventListener('load',()=>fetch('ready',{method:'POST',body:JSON.stringify({nonce,complete:document.readyState==='complete',visibility:document.visibilityState,width:innerWidth,height:innerHeight})}));
</script></body></html>`;
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-security-policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'");
    if (request.url === prefix && request.method === "GET") {
      response.setHeader("content-type", "text/html; charset=utf-8"); response.end(html); return;
    }
    if (request.url === `${prefix}stats` && request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ observedPageFlips: sequence, next, previous, page, rejectedEvents, ready })); return;
    }
    if (request.url === `${prefix}ready` && request.method === "POST") {
      try {
        let body = "";
        for await (const chunk of request) { body += chunk; if (body.length > 2_048) throw new Error("oversized readiness"); }
        const event = JSON.parse(body);
        if (event.nonce !== nonce || event.complete !== true || event.visibility !== "visible"
          || !Number.isFinite(event.width) || !Number.isFinite(event.height) || event.width < 640 || event.height < 400) throw new Error("page not ready");
        ready = true; response.writeHead(204).end();
      } catch { response.writeHead(400).end(); }
      return;
    }
    if (request.url === `${prefix}event` && request.method === "POST") {
      try {
        let body = "";
        for await (const chunk of request) { body += chunk; if (body.length > 2_048) throw new Error("oversized event"); }
        const event = JSON.parse(body);
        const direction = event.direction;
        const to = direction === "next" ? page + 1 : page - 1;
        if (event.nonce !== nonce || !["next", "prev"].includes(direction)
          || event.from !== page || event.to !== to || to < 1 || event.sequence !== sequence + 1) throw new Error("invalid transition");
        page = to; sequence++;
        if (direction === "next") next++; else previous++;
        response.writeHead(204).end();
      } catch { rejectedEvents++; response.writeHead(400).end(); }
      return;
    }
    response.writeHead(404).end();
  });
  server.requestTimeout = 2_000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${server.address().port}${prefix}`;
  let closed;
  return { url, statsUrl: `${url}stats`, close() {
    closed ??= new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    return closed;
  } };
}
