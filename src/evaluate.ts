/**
 * Measures the graph instead of eyeballing it.
 *
 *   node --import tsx src/evaluate.ts [graph.json] [catalog.json]
 *
 * Three things, in order of how much they are worth:
 *
 * 1. LABELLED SET -- a hand-judged sample of edges (eval/labels.json). Every
 *    verdict was made by reading the two tools' schemas. This is the only real
 *    precision number here; everything else is a proxy.
 *
 * 2. STRUCTURAL CHECKS -- properties that must hold for the graph to be usable
 *    by an agent at all: an id-shaped requirement should have a producer, a
 *    produced id should reach the tools that need it, and so on.
 *
 * 3. COVERAGE -- how much of the catalog is reachable, and where the gaps are.
 *
 * Exit code is non-zero if labelled precision drops below THRESHOLD, so this can
 * gate a change.
 */
import { existsSync, readFileSync } from "node:fs";

import { needs, gives, slugOf, subjectOf, type Edge, type Graph, type Tool } from "./infer.ts";

const GRAPH_PATH = process.argv[2] ?? "dependency_graph.json";
const CATALOG_PATH = process.argv[3] ?? "github_catalog.json";
const LABEL_SETS: Array<{ path: string; name: string; note: string }> = [
  { path: "eval/labels.json", name: "TUNED SET", note: "rules were adjusted against these -- treat with suspicion" },
  { path: "eval/holdout.json", name: "HELD-OUT SET", note: "never tuned against -- this is the number that counts" },
];
/**
 * A regression floor, not a target, and applied to the HELD-OUT set so it cannot
 * be gamed by tuning. Raise it only after the number has genuinely moved.
 */
const THRESHOLD = 0.5;

interface Label {
  from: string;
  to: string;
  label: string;
  /** true = this dependency is real, false = spurious. */
  correct: boolean;
  why: string;
}

const graph: Graph = JSON.parse(readFileSync(GRAPH_PATH, "utf-8"));
const catalog: Tool[] = (() => {
  const raw = JSON.parse(readFileSync(CATALOG_PATH, "utf-8"));
  return Array.isArray(raw) ? raw : (raw.tools ?? []);
})();

const byId = new Map(catalog.map((t) => [String(slugOf(t)), t]));
const key = (e: { from: string; to: string; label: string }) => `${e.from}|${e.to}|${e.label}`;
const edgeKeys = new Set(graph.edges.map((e) => key(e as any)));
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

const lines: string[] = [];
const say = (s = "") => lines.push(s);

/* ================================================================== *
 * 1. the hand-labelled set
 * ================================================================== */

let precision = 1;
let labelledPass = true;

/** Score the graph against one labelled file. */
function scoreSet(path: string, name: string, note: string): number | null {
  if (!existsSync(path)) {
    say(`${name}  -- none at ${path}, skipped`);
    return null;
  }
  const labels: Label[] = JSON.parse(readFileSync(path, "utf-8"));
  const positives = labels.filter((l) => l.correct);
  const negatives = labels.filter((l) => !l.correct);

  const truePos = positives.filter((l) => edgeKeys.has(key(l)));
  const missed = positives.filter((l) => !edgeKeys.has(key(l)));
  const falsePos = negatives.filter((l) => edgeKeys.has(key(l)));
  const correctlyAbsent = negatives.filter((l) => !edgeKeys.has(key(l)));

  const emitted = truePos.length + falsePos.length;
  const p = emitted ? truePos.length / emitted : 1;
  const r = positives.length ? truePos.length / positives.length : 1;

  say(`${name}   (${labels.length} edges: ${positives.length} good, ${negatives.length} bad)`);
  say(`  ${note}`);
  say(`  precision          ${pct(p)}  (${truePos.length}/${emitted} emitted edges are real)`);
  say(`  recall             ${pct(r)}  (${truePos.length}/${positives.length} real edges found)`);
  say(`  rejected correctly ${correctlyAbsent.length}/${negatives.length}`);
  if (missed.length) {
    say("  MISSED (real, but dropped) -- recall cost:");
    for (const l of missed) say(`    ${l.from} --${l.label}--> ${l.to}`);
  }
  if (falsePos.length) {
    say("  FALSE POSITIVES still emitted:");
    for (const l of falsePos) say(`    ${l.from} --${l.label}--> ${l.to}`);
    for (const l of falsePos) say(`      why wrong: ${l.why}`);
  }
  say();
  return p;
}

{
  const scores: Array<[string, number]> = [];
  for (const set of LABEL_SETS) {
    const p = scoreSet(set.path, set.name, set.note);
    if (p !== null) scores.push([set.name, p]);
  }
  // The held-out score is the one that gates, when it exists.
  const heldOut = scores.find(([n]) => n === "HELD-OUT SET");
  precision = heldOut ? heldOut[1] : (scores[0]?.[1] ?? 1);
  labelledPass = precision >= THRESHOLD;
}

/* ================================================================== *
 * 2. structural checks
 * ================================================================== */

say();
say("STRUCTURAL CHECKS");

const checks: Array<[string, boolean, string]> = [];

// every node id is a catalog slug
const bogusNodes = graph.nodes.filter((n) => !byId.has(n.id));
checks.push(["node ids are catalog slugs", bogusNodes.length === 0, `${bogusNodes.length} unknown`]);

// no edge invents a tool
const bogusEdges = graph.edges.filter((e) => !byId.has(e.from) || !byId.has(e.to));
checks.push(["edge endpoints exist", bogusEdges.length === 0, `${bogusEdges.length} dangling`]);

// every edge is labelled and acyclic in the trivial sense
checks.push(["all edges labelled", graph.edges.every((e) => !!e.label), ""]);
checks.push(["no self-edges", graph.edges.every((e) => e.from !== e.to), ""]);

// the label is genuinely a required param of the consumer
const mislabelled = graph.edges.filter((e) => {
  const tool = byId.get(e.to);
  if (!tool) return false;
  return !needs(tool).some((r) => r.param === e.label);
});
checks.push([
  "edge label is a required input of the consumer",
  mislabelled.length === 0,
  `${mislabelled.length} not required`,
]);

// the producer genuinely exposes something matching the label
const unsupported = graph.edges.filter((e) => {
  const tool = byId.get(e.from);
  if (!tool) return false;
  const produced = gives(tool);
  const wanted = String(e.label).split(/[^a-z0-9]+/i).filter(Boolean).map((w) => w.toLowerCase());
  const role = wanted[wanted.length - 1];
  // Must include every field a handle can arrive as, not just id/number/name --
  // leaving out `sha` flagged GET_A_TREE -> CREATE_A_COMMIT, which is correct:
  // a commit's `tree` param takes exactly the tree sha that tool returns.
  const handles = ["id", "number", "name", "slug", "login", "sha", "node_id"];
  return !produced.some((p) => p.field === role || handles.includes(p.field));
});
checks.push([
  "producer exposes a field for the label",
  unsupported.length === 0,
  `${unsupported.length} unsupported`,
]);

// a producer that also requires the label it supplies is useless
const circular = graph.edges.filter((e) => {
  const tool = byId.get(e.from);
  return tool ? needs(tool).some((r) => r.param === e.label) : false;
});
checks.push([
  "producer does not itself require the label",
  circular.length === 0,
  `${circular.length} circular`,
]);

// fan-in stays bounded per requirement
const perRequirement = new Map<string, number>();
for (const e of graph.edges) {
  const k = `${e.to}|${e.label}`;
  perRequirement.set(k, (perRequirement.get(k) ?? 0) + 1);
}
const maxFan = perRequirement.size ? Math.max(...perRequirement.values()) : 0;
checks.push(["producers per requirement <= 3", maxFan <= 3, `max ${maxFan}`]);

let structuralPass = true;
for (const [name, ok, detail] of checks) {
  if (!ok) structuralPass = false;
  say(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  -- ${detail}` : ""}`);
}

/* ================================================================== *
 * 3. coverage
 * ================================================================== */

say();
say("COVERAGE");

const inDeg = new Map<string, number>();
const outDeg = new Map<string, number>();
for (const e of graph.edges) {
  outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1);
  inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
}

/** A requirement that looks like a handle: has an explicit id-ish role. */
const isHandle = (param: string) => /_(id|number|slug|sha|name)$|^(sha|ref)$/.test(param);

let handleReqs = 0;
let handleReqsMet = 0;
const unmetHandles = new Map<string, number>();

for (const tool of catalog) {
  const id = String(slugOf(tool));
  const met = new Set(graph.edges.filter((e) => e.to === id).map((e) => e.label));
  for (const r of needs(tool)) {
    if (!isHandle(r.param)) continue;
    handleReqs++;
    if (met.has(r.param)) handleReqsMet++;
    else unmetHandles.set(r.param, (unmetHandles.get(r.param) ?? 0) + 1);
  }
}

const reachable = graph.nodes.filter((n) => inDeg.has(n.id) || outDeg.has(n.id)).length;
const asksUser = graph.nodes.filter((n) => n.requires_from_user?.length).length;

say(`  tools                     ${graph.nodes.length}`);
say(`  dependencies              ${graph.edges.length}`);
say(`  tools in the graph        ${reachable} (${pct(reachable / graph.nodes.length)})`);
say(`  tools needing user input  ${asksUser} (${pct(asksUser / graph.nodes.length)})`);
say(
  `  id-shaped requirements    ${handleReqsMet}/${handleReqs} satisfied by a tool ` +
    `(${pct(handleReqs ? handleReqsMet / handleReqs : 1)})`,
);

if (unmetHandles.size) {
  const worst = [...unmetHandles.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  say("  biggest gaps (id-shaped requirement, no producer found):");
  for (const [param, n] of worst) say(`    ${String(n).padStart(3)}  ${param}`);
}

const confident = graph.edges.filter((e) => (e.confidence ?? 1) >= 0.9).length;
const uncertain = graph.edges.filter((e) => (e.confidence ?? 1) < 0.7).length;
say();
say("CONFIDENCE");
say(`  >= 0.90   ${confident} (${pct(confident / graph.edges.length)})`);
say(`  <  0.70   ${uncertain} (${pct(uncertain / graph.edges.length)})  <- where an LLM pass would help`);

/* ================================================================== */

say();
const ok = labelledPass && structuralPass;
say(ok ? "RESULT: pass" : "RESULT: fail");
if (!labelledPass) say(`  held-out precision ${pct(precision)} is below the ${pct(THRESHOLD)} floor`);

console.log(lines.join("\n"));
process.exit(ok ? 0 : 1);
