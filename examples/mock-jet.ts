/**
 * A stand-in for Jet that speaks the exact `/v1/decide` format of `jet-serve`
 * (quaedra/jet src/server.py), for running the demo and tests offline.
 *
 * It is NOT a model: for choice questions it looks the text up in the example data
 * (right ~96% of the time, deterministically wrong otherwise), and uses keyword rules
 * for noul/score. Point JET_URL at a real Jet to replace it.
 */
import { createServer, type Server } from "node:http";
import { readExamplesCsv } from "../src/node.js";
import { hashInput } from "../src/runtime.js";

type Q = { type: "choice" | "noul" | "score"; instructions: string; criteria?: Record<string, string> | string[] };

const known = new Map<string, string>();
for (const f of ["comment_moderation.train", "comment_moderation.test", "support_triage.train", "support_triage.test"]) {
  for (const r of readExamplesCsv(new URL(`./data/${f}.csv`, import.meta.url).pathname)) known.set(r.text, r.label);
}

const unit = (s: string) => parseInt(hashInput(s), 16) / 0xffffffff;
const confidence = (ps: number[]) => {
  const h = -ps.reduce((a, p) => a + (p > 0 ? p * Math.log(p) : 0), 0);
  return Math.round((1 - h / Math.log(ps.length)) * 1e4) / 1e4;
};
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

function answer(state: string, q: Q) {
  if (q.type === "choice") {
    const keys = Object.keys(q.criteria as Record<string, string>);
    let target = known.get(state);
    if (!target || !keys.includes(target)) target = keys[Math.floor(unit("kw:" + state) * keys.length)];
    else if (unit("err:" + state) < 0.04) target = keys[(keys.indexOf(target) + 1) % keys.length]; // simulated mistakes
    const peak = known.has(state) ? 0.9 + 0.08 * unit("p:" + state) : 0.5;
    const ps = keys.map((k) => (k === target ? peak : (1 - peak) / (keys.length - 1)));
    return { type: "choice", choice: target, probabilities: Object.fromEntries(keys.map((k, i) => [k, r4(ps[i])])), confidence: confidence(ps) };
  }
  if (q.type === "noul") {
    const p = /refund|cancel|lawyer|angry|charged twice|data loss|delete my|unacceptable|blocked/i.test(state) ? 0.91 : 0.12;
    return { type: "noul", probability: p, confidence: confidence([1 - p, p]) };
  }
  const levels = q.criteria as string[];
  const hi = /urgent|asap|down|can't|cannot|blocked|losing|immediately|charged twice|crash/i.test(state);
  const lo = /feature|would be nice|suggest|how do i|how can i|question/i.test(state);
  const idx = hi ? levels.length - 1 : lo ? 0 : Math.floor(levels.length / 2);
  const ps = levels.map((_, i) => (i === idx ? 0.86 : 0.14 / (levels.length - 1)));
  return {
    type: "score",
    score: r4(ps.reduce((a, p, i) => a + p * i, 0)),
    level: levels[idx],
    probabilities: ps.map(r4),
    confidence: confidence(ps),
  };
}

export interface MockJet {
  url: string;
  requests: number;
  questions: number;
  close(): Promise<void>;
}

export function startMockJet(port = 0): Promise<MockJet> {
  const stats = { requests: 0, questions: 0 };
  const server: Server = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/health") return send(200, { status: "ok", model: "mock-jet" });
    if (req.method !== "POST" || req.url !== "/v1/decide") return send(404, { detail: "not found" });
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const t0 = performance.now();
      try {
        const body = JSON.parse(raw) as { state: string; questions: Record<string, Q> };
        if (!body.questions || !Object.keys(body.questions).length) return send(400, { detail: "questions must not be empty" });
        if (Object.keys(body.questions).length > 8) return send(400, { detail: "at most 8 questions per request" });
        stats.requests++;
        stats.questions += Object.keys(body.questions).length;
        const state = typeof body.state === "string" ? body.state : JSON.stringify(body.state);
        const answers = Object.fromEntries(Object.entries(body.questions).map(([k, q]) => [k, answer(state, q)]));
        send(200, { model: "mock-jet", answers, usage: { input_tokens: state.length >> 2 }, latency_ms: r4(performance.now() - t0) });
      } catch (e) {
        send(400, { detail: `invalid request: ${(e as Error).message}` });
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        get requests() { return stats.requests; },
        get questions() { return stats.questions; },
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8000);
  startMockJet(port).then((m) => console.log(`mock Jet on ${m.url}/v1/decide`));
}
