/**
 * nodd(): a Nodd model (small calibrated encoder, ONNX q8, 10–35 MB) as a tier.
 * Uses @nodd/node by default; pass `load` to use @nodd/browser or a preloaded model.
 * Nodd's own calibrated threshold (chosen for a target precision) is the tier threshold.
 */
import type { Backend } from "../backend.js";
import { type Decision, VerdictError } from "../decision.js";

/** The part of @nodd/core's Decider that Verdict needs. */
export interface NoddDecider {
  info: { model: string; labels: string[]; threshold: number };
  decide(text: string): Promise<{ label: string; probabilities: Record<string, number>; confidence: number }>;
}

export interface NoddOptions {
  /** Default: `(await import("@nodd/node")).nodd.load(dir)`. */
  load?: (dir: string) => Promise<NoddDecider>;
  /** Override Nodd's calibrated threshold. */
  threshold?: number;
}

async function defaultLoad(dir: string): Promise<NoddDecider> {
  const spec = "@nodd/node"; // optional peer dependency
  try {
    const mod = (await import(spec)) as { nodd: { load(dir: string): Promise<NoddDecider> } };
    return await mod.nodd.load(dir);
  } catch (e) {
    throw new Error(`nodd(): could not load ${dir} with @nodd/node (npm i @nodd/node): ${(e as Error).message}`);
  }
}

export function nodd(dir: string, o: NoddOptions = {}): Backend {
  let model: Promise<NoddDecider> | null = null;
  let loaded: NoddDecider | null = null;
  const checked = new Set<string>();
  const get = (d: Decision): Promise<NoddDecider> => {
    model ??= (o.load ?? defaultLoad)(dir).then((m) => (loaded = m));
    return model.then((m) => {
      if (!checked.has(d.name)) {
        const want = [...d.labels].sort().join(",");
        const have = [...m.info.labels].sort().join(",");
        if (want !== have) throw new VerdictError(d.name, `Nodd model ${m.info.model} has labels [${have}], decision has [${want}]`);
        checked.add(d.name);
      }
      return m;
    });
  };
  return {
    name: `nodd:${dir.split(/[\\/]/).filter(Boolean).slice(-2).join("/")}`,
    types: ["choice", "noul"],
    threshold: () => o.threshold ?? loaded?.info.threshold,
    decide: async (d, input) => {
      const m = await get(d);
      const r = await m.decide(input);
      return { probabilities: r.probabilities, confidence: r.confidence, model: `nodd:${m.info.model}` };
    },
  };
}
