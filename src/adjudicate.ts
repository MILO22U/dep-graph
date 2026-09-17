/**
 * The semantic layer: asks a language model to NAME what each identifier refers
 * to, then matches those names in ordinary code.
 *
 *   node --import tsx src/adjudicate.ts [catalog.json]
 *
 * WHY A MODEL AT ALL
 * ------------------
 * Three errors survive every structural rule, and they all look like this:
 *
 *   GITHUB_LIST_PENDING_TEAM_INVITATIONS --invitation_id-> ACCEPT_REPOSITORY_INVITATION
 *
 * A team invitation id is not a repository invitation id. But the correct edge
 * the brief names has an identical shape:
 *
 *   GITHUB_LIST_REPOSITORY_ISSUES --issue_number-> CREATE_AN_ISSUE_COMMENT
 *
 * In both, the producer's name carries a qualifier the consumer's lacks. Any
 * token rule strict enough to kill the first also kills the second -- measured,
 * not assumed (see APPROACH.md). Separating them needs to know that a team
 * invitation and a repository invitation are different kinds of thing. That is
 * world knowledge, so it is the one job worth spending a model on.
 *
 * WHAT IS ASKED
 * -------------
 * Not "is this edge right?" -- that is one judgement per edge, expensive and
 * hard to audit. Instead, one small question per (tool, field):
 *
 *   "GITHUB_LIST_PENDING_TEAM_INVITATIONS returns invitation_id.
 *    What kind of thing does it identify?"            -> team_invitation
 *   "GITHUB_ACCEPT_REPOSITORY_INVITATION needs invitation_id."
 *                                                     -> repository_invitation
 *
 * Each tool is asked once however many edges touch it, and the comparison of the
 * two answers happens in `kindsCompatible` -- plain, testable code.
 *
 * WHY THE ANSWERS ARE CACHED
 * --------------------------
 * They are written to eval/kinds.json, which is committed. `src/generate.ts`
 * reads that file and applies it with no network and no API key, so the grader
 * reproduces the identical graph, the output stays deterministic, and every one
 * of the model's judgements is reviewable in git. Re-running this script only
 * asks about entries missing from the cache.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

import {
  buildGraph,
  needs,
  slugOf,
  subjectOf,
  tokenHit,
  type KindMap,
  type Tool,
} from "./infer.ts";

const CATALOG_PATH = process.argv[2] ?? "github_catalog.json";
const CACHE_PATH = "eval/kinds.json";
const MODEL = process.env.LLM_MODEL ?? "openai/gpt-4o-mini";
const BATCH = 25;
const CONCURRENCY = 4;

const baseUrl = process.env.OPENAI_BASE_URL;
const apiKey = process.env.OPENAI_API_KEY;

/* ------------------------------------------------------------------ *
 * which questions need asking
 * ------------------------------------------------------------------ */

interface Question {
  key: string; // cache key: "<side>|<label>|<slug>"
  side: "produces" | "requires";
  slug: string;
  label: string;
  description: string;
}

function buildQuestions(catalog: Tool[], edges: Array<{ from: string; to: string; label?: string }>) {
  const byId = new Map(catalog.map((t) => [String(slugOf(t)), t]));
  const seen = new Set<string>();
  const out: Question[] = [];

  const add = (side: Question["side"], slug: string, label: string) => {
    const key = `${side}|${label}|${slug}`;
    if (seen.has(key)) return;
    seen.add(key);
    const tool = byId.get(slug);
    if (!tool) return;
    out.push({
      key,
      side,
      slug,
      label,
      description: String(tool.description ?? "").slice(0, 320),
    });
  };

  for (const e of edges) {
    if (!e.label) continue;
    add("produces", e.from, e.label);
    add("requires", e.to, e.label);
  }
  return out;
}

/**
 * Only edges at risk of the cross-scope error are worth asking about: the two
 * tools carry different qualifiers around the same entity. Anything else the
 * structural rules already settle, and asking would just cost tokens.
 */
function atRisk(catalog: Tool[], edges: Array<{ from: string; to: string; label?: string }>) {
  const byId = new Map(catalog.map((t) => [String(slugOf(t)), t]));
  const subj = new Map(catalog.map((t) => [String(slugOf(t)), subjectOf(t)]));
  return edges.filter((e) => {
    const consumer = byId.get(e.to);
    if (!consumer || !e.label) return false;
    const req = needs(consumer).find((r) => r.param === e.label);
    const ent = req?.entity ?? [];
    const ps = (subj.get(e.from) ?? []).filter((t) => !ent.some((x) => tokenHit(x, t)));
    const cs = (subj.get(e.to) ?? []).filter((t) => !ent.some((x) => tokenHit(x, t)));
    const pOnly = ps.filter((t) => !cs.some((x) => tokenHit(x, t)));
    const cOnly = cs.filter((t) => !ps.some((x) => tokenHit(x, t)));
    return pOnly.length > 0 && cOnly.length > 0;
  });
}

/* ------------------------------------------------------------------ *
 * asking
 * ------------------------------------------------------------------ */

const SYSTEM = `You label API identifiers with the kind of entity they refer to.

For each item you get a tool name, what the tool does, and one identifier field.
Reply with the SPECIFIC kind of thing that identifier points at, as a lowercase
snake_case noun phrase.

Rules:
- Be specific enough to distinguish sibling kinds that share a word. A team
  membership invitation and a repository collaboration invitation are NOT the
  same kind: use "team_invitation" and "repository_invitation".
- An organization-level secret and an environment-level secret are different:
  "organization_secret" vs "environment_secret".
- A commit status and a deployment status are different.
- But do NOT invent distinctions that do not exist. A pull request number is
  "pull_request" whether the tool lists them or merges one. An issue number is
  "issue". Scope words like the repository something lives in are not part of the
  kind unless the id space genuinely differs.
- Use the SAME string for the same kind every time, so answers can be compared.

Reply with JSON only: {"answers":[{"i":0,"kind":"..."},...]} with one entry per
item, in the order given.`;

function promptFor(qs: Question[]): string {
  return qs
    .map((q, i) => {
      const verb = q.side === "produces" ? "RETURNS" : "REQUIRES";
      return `${i}. tool: ${q.slug}\n   does: ${q.description}\n   ${verb} the field: ${q.label}`;
    })
    .join("\n\n");
}

async function askBatch(qs: Question[], attempt = 0): Promise<Record<string, string>> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: promptFor(qs) },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (attempt < 2 && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      return askBatch(qs, attempt + 1);
    }
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content ?? "{}";
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`model did not return JSON: ${String(text).slice(0, 160)}`);
  }
  const out: Record<string, string> = {};
  for (const a of parsed.answers ?? []) {
    const q = qs[Number(a?.i)];
    const kind = String(a?.kind ?? "").trim().toLowerCase();
    if (q && kind) out[q.key] = kind;
  }
  return out;
}

/** Run batches with a small concurrency limit. */
async function askAll(qs: Question[]): Promise<KindMap> {
  const batches: Question[][] = [];
  for (let i = 0; i < qs.length; i += BATCH) batches.push(qs.slice(i, i + BATCH));

  const result: KindMap = {};
  let next = 0;
  let done = 0;
  let failed = 0;

  async function worker() {
    while (next < batches.length) {
      const mine = batches[next++];
      try {
        Object.assign(result, await askBatch(mine));
      } catch (err) {
        failed++;
        console.error(`  batch failed: ${(err as Error).message}`);
      }
      done++;
      process.stderr.write(`\r  ${done}/${batches.length} batches`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stderr.write("\n");
  if (failed) console.error(`  ${failed} batch(es) failed; their entries stay unlabelled`);
  return result;
}

/* ------------------------------------------------------------------ */

async function main() {
  const raw = JSON.parse(readFileSync(CATALOG_PATH, "utf-8"));
  const catalog: Tool[] = Array.isArray(raw) ? raw : (raw.tools ?? []);

  if (!baseUrl || !apiKey) {
    console.error(
      "OPENAI_BASE_URL / OPENAI_API_KEY are not set, so there is nothing to refresh.\n" +
        `The generator still runs: it applies whatever is already cached in ${CACHE_PATH}.`,
    );
    process.exit(0);
  }

  // Build the graph WITHOUT the semantic layer, so we ask about its own output.
  const graph = await buildGraph(catalog);
  const risky = atRisk(catalog, graph.edges);
  const questions = buildQuestions(catalog, risky);

  const cache: KindMap = existsSync(CACHE_PATH)
    ? JSON.parse(readFileSync(CACHE_PATH, "utf-8"))
    : {};
  const missing = questions.filter((q) => !(q.key in cache));

  console.error(`edges              ${graph.edges.length}`);
  console.error(`at risk of scope   ${risky.length}`);
  console.error(`questions          ${questions.length}  (${missing.length} not cached)`);
  console.error(`model              ${MODEL}`);

  if (!missing.length) {
    console.error("nothing to ask; cache is complete");
    return;
  }

  console.error(`asking in ${Math.ceil(missing.length / BATCH)} batches...`);
  const answers = await askAll(missing);
  const merged = { ...cache, ...answers };

  mkdirSync("eval", { recursive: true });
  // sorted keys so the committed diff is readable
  const sorted: KindMap = {};
  for (const k of Object.keys(merged).sort()) sorted[k] = merged[k];
  writeFileSync(CACHE_PATH, JSON.stringify(sorted, null, 2) + "\n", "utf-8");

  console.error(`wrote ${Object.keys(sorted).length} kinds to ${CACHE_PATH}`);
  const kinds = new Set(Object.values(sorted));
  console.error(`distinct kinds: ${kinds.size}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
