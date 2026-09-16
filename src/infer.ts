/**
 * Dependency graph inference for a Composio toolkit catalog.
 *
 * THE IDEA
 * --------
 * A tool cannot run without its required inputs. GITHUB_CREATE_AN_ISSUE_COMMENT
 * requires `issue_number`; you cannot invent one. So either the user supplies it,
 * or some *other* tool hands it to you: GITHUB_LIST_REPOSITORY_ISSUES returns
 * issues, and each issue has a `number`. That is a dependency:
 *
 *   GITHUB_LIST_REPOSITORY_ISSUES --issue_number--> GITHUB_CREATE_AN_ISSUE_COMMENT
 *
 * So the program is: for every tool work out what it NEEDS, for every tool work
 * out what it GIVES, and wire needs to gives.
 *
 * THE WRINKLE
 * -----------
 * The names do not match. The consumer asks for `issue_number`. The producer
 * returns a field called `number` -- but that field lives inside an object
 * titled `Issue`. So matching is on (entity, role), not string equality:
 *
 *   required `issue_number`  ->  entity "issue" + role "number"
 *   produced `Issue.number`  ->  entity "issue" + role "number"   MATCH
 *   produced `Label.id`      ->  entity "label" + role "id"       no match
 *
 * That rule is derived from schema structure, so it carries to any toolkit --
 * nothing here is keyed to GitHub.
 *
 * This module is pure: no I/O, no process exit. `src/generate.ts` is the CLI
 * around it, and `src/*.test.ts` exercise the parts individually.
 */

export type Tool = Record<string, any>;

export interface Node {
  id: string;
  service?: string;
  /** Required params no tool can supply -- the agent must ask the user for these. */
  requires_from_user?: string[];
}
export interface Edge {
  from: string;
  to: string;
  label?: string;
  confidence?: number;
}
export interface Graph {
  nodes: Node[];
  edges: Edge[];
}

export function slugOf(tool: Tool): string | undefined {
  return tool.slug ?? tool.name ?? tool.function?.name;
}

/* ================================================================== *
 * WORDS
 * Everything downstream is token comparison, so normalise once here.
 * ================================================================== */

/** Field-name suffixes meaning "this value is a handle to something". */
export const ROLE_WORDS = [
  "id", "number", "name", "slug", "sha", "login",
  "ref", "key", "path", "url", "token", "title", "email",
];

/** Roles that are interchangeable in practice (a username IS a User login). */
export const ROLE_GROUPS: string[][] = [
  ["id", "node_id"],
  ["name", "login", "slug", "title"],
  ["sha", "ref"],
];

/** Title tokens that qualify a shape without naming a different entity. */
export const TITLE_NOISE = new Set([
  "simple", "minimal", "full", "nullable", "public", "private", "base",
  "detail", "object", "item", "schema", "model", "info", "data",
]);

/** Marks a requirement as "any identifying field of this entity will do". */
export const ANY_ROLE = "*";

/** "pull_number" | "pullNumber" -> ["pull","number"] */
export function tokenize(s: string): string[] {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** Crude singulariser so "issues" and "issue" compare equal. */
export function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("ses")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** One word that is really two: "username" -> ["user","name"]. */
export function splitCompound(tokens: string[]): string[] {
  if (tokens.length !== 1) return tokens;
  const w = tokens[0];
  for (const role of ROLE_WORDS) {
    if (w.length > role.length + 2 && w.endsWith(role)) {
      return [w.slice(0, -role.length), role];
    }
  }
  return tokens;
}

/**
 * Composio wraps every result as {data, error, successful}, and the response
 * schema is titled e.g. "ListRepositoryIssuesResponseWrapper". Those titles name
 * an envelope, not a domain entity, so they contribute no entity at all.
 * Note we deliberately do NOT treat a trailing "Request" as an envelope --
 * "PullRequest" is a real entity.
 */
export function isEnvelopeTitle(title: string): boolean {
  return /(response|wrapper)$/i.test(title);
}

/** "SimpleUser" -> ["user"],  "PullRequest" -> ["pull","request"] */
export function titleEntity(title: string): string[] {
  if (isEnvelopeTitle(title)) return [];
  return tokenize(title).map(stem).filter((w) => !TITLE_NOISE.has(w));
}

/* ================================================================== *
 * WHAT A TOOL NEEDS
 * ================================================================== */

export interface Requirement {
  /** The raw param name -- this becomes the edge label. */
  param: string;
  /** Entity the value identifies, stemmed: `issue_number` -> ["issue"]. */
  entity: string[];
  /** Which field of that entity: `issue_number` -> "number". */
  role: string;
  /** JSON Schema type, used to reject integer/string mismatches. */
  type?: string;
  /** Schema declares an enum: a fixed choice, never a handle to fetch. */
  fixedChoice?: boolean;
}

/** Mandatory inputs only -- optional params are not dependencies. */
export function requiredParams(tool: Tool): Array<{ name: string; schema: any }> {
  const ip = tool?.inputParameters;
  if (!ip || typeof ip !== "object") return [];
  const required: unknown[] = Array.isArray(ip.required) ? ip.required : [];
  const props = ip.properties && typeof ip.properties === "object" ? ip.properties : {};
  return required
    .filter((n): n is string => typeof n === "string" && n.length > 0)
    .map((n) => ({ name: n, schema: props[n] ?? {} }));
}

/** Split a param name into the (entity, role) pair we match on. */
export function parseRequirement(name: string, schema: any): Requirement {
  const type = typeof schema?.type === "string" ? schema.type : undefined;
  // `state`, `visibility`, `package_type`: you pick one of a fixed set, so no
  // tool "produces" it. Treat as something the caller decides, not a dependency.
  const fixedChoice = Array.isArray(schema?.enum) && schema.enum.length > 0;
  const toks = splitCompound(tokenize(name));

  if (toks.length === 0) return { param: name, entity: [], role: ANY_ROLE, type, fixedChoice };

  const last = toks[toks.length - 1];
  if (ROLE_WORDS.includes(last)) {
    // "issue_number" -> entity ["issue"], role "number"
    // bare "sha"     -> no entity, role "sha" (weak: matched on field name alone)
    return { param: name, entity: toks.slice(0, -1).map(stem), role: last, type, fixedChoice };
  }
  // "branch" -> any identifying field of a Branch will do
  return { param: name, entity: toks.map(stem), role: ANY_ROLE, type, fixedChoice };
}

export function needs(tool: Tool): Requirement[] {
  return requiredParams(tool).map(({ name, schema }) => parseRequirement(name, schema));
}

/* ================================================================== *
 * WHAT A TOOL GIVES
 * Walk the output schema, resolving $ref into $defs, and record every leaf
 * field together with the entity that encloses it.
 * ================================================================== */

export interface Produced {
  /** Entity tokens of the nearest enclosing titled object. */
  entity: string[];
  /** Leaf field name, lowercased. */
  field: string;
  type?: string;
  /** Dotted path, for debugging and for showing provenance in the viz. */
  path: string;
}

export const MAX_DEPTH = 7;

export function gives(tool: Tool): Produced[] {
  const root = tool?.outputParameters;
  if (!root || typeof root !== "object") return [];
  const defs = (root.$defs && typeof root.$defs === "object" ? root.$defs : {}) as Record<string, any>;
  const out: Produced[] = [];

  /** Follow $ref chains into $defs, remembering the def name as a title. */
  function deref(node: any): any {
    let hops = 0;
    while (node && typeof node === "object" && typeof node.$ref === "string" && hops++ < 8) {
      const name = node.$ref.split("/").pop() as string;
      const target = defs[name];
      if (!target) return null;
      node = { ...target, title: target.title ?? name };
    }
    return node && typeof node === "object" ? node : null;
  }

  function walk(raw: any, entity: string[], path: string, depth: number, seen: Set<string>) {
    if (depth > MAX_DEPTH) return;
    const node = deref(raw);
    if (!node) return;

    // A title either renames the entity we are inside, or (for envelopes) clears it.
    let ent = entity;
    if (typeof node.title === "string" && node.title) {
      if (seen.has(node.title)) return; // recursive schema, e.g. Team.parent
      seen = new Set(seen).add(node.title);
      if (isEnvelopeTitle(node.title)) {
        ent = [];
      } else {
        const t = titleEntity(node.title);
        if (t.length) ent = t;
      }
    }

    if (node.items) {
      walk(node.items, ent, path + "[]", depth + 1, seen);
      return;
    }
    if (!node.properties || typeof node.properties !== "object") return;

    for (const [field, sub] of Object.entries<any>(node.properties)) {
      const child = deref(sub);
      // A $ref we could not resolve tells us nothing about the field, so do not
      // invent a scalar leaf for it -- that recorded a phantom `data` field
      // whenever a catalog shipped a broken $defs pointer.
      if (!child && sub && typeof sub === "object" && typeof sub.$ref === "string") continue;
      const childPath = path ? path + "." + field : field;
      const isLeaf = !child || (!child.properties && !child.items);
      if (isLeaf) {
        out.push({
          entity: ent,
          field: field.toLowerCase(),
          type: typeof child?.type === "string" ? child.type : undefined,
          path: childPath,
        });
      } else {
        walk(sub, ent, childPath, depth + 1, seen);
      }
    }
  }

  walk(root, [], "", 0, new Set());
  return out;
}

/* ================================================================== *
 * SERVICE LABEL
 * ================================================================== */

/** Behavioural/meta tags that say nothing about which API surface a tool is on. */
export const TAG_NOISE = /^(.*hint|mcpignore|important|deprecated)$/i;

export function serviceOf(tool: Tool): string | undefined {
  const tags: string[] = Array.isArray(tool.tags)
    ? tool.tags.filter((t: any) => typeof t === "string")
    : [];
  const real = tags.filter((t) => !TAG_NOISE.test(t));
  if (real.length) return real[0].toLowerCase();
  return typeof tool.toolkit?.slug === "string" ? tool.toolkit.slug.toLowerCase() : undefined;
}

/* ================================================================== *
 * WHAT A TOOL IS ABOUT
 * Some tools put an entity's fields straight on their response envelope
 * (CREATE_AN_ISSUE_COMMENT returns the new comment as bare `data.id`, with no
 * `IssueComment` title to inherit). For those, fall back to the subject named in
 * the tool's own slug.
 * ================================================================== */

/** Slug words that describe the action, not the thing acted on. */
export const SLUG_VERBS = new Set([
  "list", "get", "create", "update", "delete", "add", "remove", "set", "merge",
  "close", "reopen", "find", "search", "fetch", "retrieve", "check", "enable",
  "disable", "upload", "download", "start", "stop", "cancel", "abort", "transfer",
  "move", "lock", "unlock", "fork", "dispatch", "rerun", "approve", "assign",
  "a", "an", "the", "for", "of", "in", "to", "by", "with", "and", "or", "all", "from", "its",
]);

export function subjectOf(tool: Tool): string[] {
  const toolkit = typeof tool.toolkit?.slug === "string" ? tool.toolkit.slug.toLowerCase() : "";
  return tokenize(String(slugOf(tool) ?? ""))
    .filter((w, i) => !(i === 0 && w === toolkit))
    .filter((w) => !SLUG_VERBS.has(w))
    .map(stem);
}

/* ================================================================== *
 * MATCHING
 * score = role fit x entity fit x type fit. All three must hold for an edge.
 * ================================================================== */

/** Fields that can identify an entity when the requirement names no role. */
export const HANDLE_FIELDS = ["id", "number", "name", "login", "slug", "sha", "node_id"];

export function roleScore(reqRole: string, field: string): number {
  if (reqRole === ANY_ROLE) {
    if (field === "id" || field === "number") return 0.9;
    if (field === "name" || field === "login" || field === "slug") return 0.85;
    if (field === "sha" || field === "node_id") return 0.6;
    return 0;
  }
  if (field === reqRole) return 1;
  const group = ROLE_GROUPS.find((g) => g.includes(reqRole));
  if (group && group.includes(field)) return 0.75;
  return 0;
}

/**
 * Do two entity tokens denote the same thing?
 * Exact after stemming, or a clear abbreviation (repo/repository, org/organization),
 * or one contains the other (hook/webhook). The abbreviation rule demands a big
 * length gap on purpose: without it "run" would match "runner", and a workflow
 * run id is not a self-hosted runner id.
 */
export function tokenHit(a: string, b: string): boolean {
  if (a === b) return true;
  // Containment only across a SMALL length gap. A wide gap is how false friends
  // get in: "code" is a prefix of "codespace" but a manifest conversion code has
  // nothing to do with a codespace, and "run" sits inside "runner" though a
  // workflow run id is not a self-hosted runner id.
  // Gap of 3 rather than 2: tightening it to 2 scored better on the labelled
  // sample (it removed one bad `list`~`listing` match) but silently deleted all
  // 57 hook_id edges, because "hook" sits inside "webhook" with a gap of 3.
  // Kept at 3 deliberately -- the sample is too small to tune against.
  const near = (x: string, y: string) =>
    x.length >= 4 && y.includes(x) && y.length - x.length <= 3;
  return near(a, b) || near(b, a);
}

export function entityScore(req: string[], prod: string[]): number {
  if (req.length === 0) return 0.35; // matched on field name alone -- weak
  if (prod.length === 0) return 0.25;
  const matched = req.filter((r) => prod.some((p) => tokenHit(r, p)));
  if (matched.length === req.length) return 1;
  // No partial credit. A requirement naming two things means both: crediting a
  // half-match offered a runner LABEL id for `runner_group_id`, and a custom
  // organization ROLE name for `custom_property_name`. Either every token of the
  // requirement is accounted for, or this is a different entity.
  return 0;
}

export function typeScore(reqType: string | undefined, prodType: string | undefined): number {
  if (!reqType || !prodType) return 0.9; // schema silent -- mild discount
  const numeric = (t: string) => t === "integer" || t === "number";
  if (reqType === prodType) return 1;
  if (numeric(reqType) && numeric(prodType)) return 1;
  if (reqType === "string" && numeric(prodType)) return 0.7; // ids get stringified
  if (numeric(reqType) && prodType === "string") return 0.15; // a hash is not an int id
  if (reqType === "array" || prodType === "array") return 0.3;
  return 0.4;
}

export const MIN_CONFIDENCE = 0.55;

/* ================================================================== *
 * PRODUCER QUALITY
 * Many tools can hand over the same id. Prefer the one an agent should
 * actually call: read-only, retrieval-shaped, cheap, not deprecated.
 * ================================================================== */

export function producerQuality(tool: Tool): number {
  const tags = (Array.isArray(tool.tags) ? tool.tags : []).map((t: any) => String(t).toLowerCase());
  const slug = String(slugOf(tool) ?? "");
  let q = 0;
  if (tags.includes("readonlyhint")) q += 3;
  if (/(^|_)(LIST|GET|FIND|SEARCH)_/.test(slug)) q += 3;
  if (tags.includes("destructivehint")) q -= 4;
  if (tags.includes("createhint")) q -= 1;
  if (tags.includes("updatehint")) q -= 1;
  if (tool.isDeprecated || tags.includes("deprecated")) q -= 8;
  q -= requiredParams(tool).length * 0.5; // fewer prerequisites of its own
  return q;
}

/**
 * Does the producer operate in the same scope as the consumer?
 *
 * Both LIST_REPOSITORY_ISSUES and LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER
 * yield an issue number, and the second is cheaper (it needs no inputs at all).
 * But if you are commenting on an issue in a particular repo, the right move is
 * to list *that repo's* issues. The signal: the producer's own requirements are
 * already satisfied by the consumer's (owner/repo), so it runs in the same scope.
 * Requirements the consumer does not share are a cost -- you would have to source
 * those separately.
 */
export function scopeAffinity(producer: Tool, consumerParams: Set<string>): number {
  const required = requiredParams(producer).map((p) => p.name);
  let shared = 0;
  let extra = 0;
  for (const name of required) {
    if (consumerParams.has(name)) shared++;
    else extra++;
  }
  return shared - extra;
}

/** Keep at most this many producers per (consumer, required param). */
export const MAX_PRODUCERS_PER_REQUIREMENT = 3;
/** A param required by more than this share of the toolkit is ambient context. */
export const AMBIENT_SHARE = 0.15;
/**
 * Ambient params (`owner`, `repo`, `org` -- required by half the toolkit) are
 * what the README calls "info to get from the user". Technically almost any
 * listing echoes a repo name back, so linking them produced ~1,300 edges from a
 * handful of hub tools: true, but it buries the real dependencies. We record
 * them on the node as `requires_from_user` instead. Flip this to emit them.
 */
export const LINK_AMBIENT_PARAMS = false;

export async function buildGraph(tools: Tool[]): Promise<Graph> {
  const catalog = tools.filter((t) => slugOf(t));

  const nodes: Node[] = catalog.map((t) => ({
    id: String(slugOf(t)),
    service: serviceOf(t),
  }));

  // ---- how ambient is each required param across this toolkit? --------------
  const paramFrequency = new Map<string, number>();
  for (const t of catalog) {
    for (const { name } of requiredParams(t)) {
      paramFrequency.set(name, (paramFrequency.get(name) ?? 0) + 1);
    }
  }
  /**
   * Ambient = pervasive AND shapeless. Frequency alone is not enough: on a
   * narrow catalog (say only the issues tools) `issue_number` also crosses the
   * threshold, and calling it ambient silently deletes the toolkit's main
   * dependency. A param carrying an explicit role (`*_number`, `*_id`, `*_slug`)
   * is a handle however common it is; only bare nouns can be ambient context.
   */
  const isAmbient = (req: Requirement) =>
    req.role === ANY_ROLE &&
    (paramFrequency.get(req.param) ?? 0) / catalog.length > AMBIENT_SHARE;

  // Tools callable with no inputs at all: the only legitimate way to bootstrap
  // ambient context like `owner`/`repo` without inventing it.
  const isEntryPoint = catalog.map((t) => requiredParams(t).length === 0);

  /** Read-only or retrieval-shaped: safe to call just to learn something. */
  const isRetrieval = catalog.map((t) => {
    const tags = (Array.isArray(t.tags) ? t.tags : []).map((g: any) => String(g).toLowerCase());
    return tags.includes("readonlyhint") || /(^|_)(LIST|GET|FIND|SEARCH)_/.test(String(slugOf(t)));
  });

  // ---- index every produced field by its leaf name --------------------------
  interface Candidate {
    tool: number;
    entity: string[];
    type?: string;
    path: string;
    /** Entity came from the tool's slug, not from a schema title -- weaker. */
    fromSubject: boolean;
  }
  const byField = new Map<string, Candidate[]>();

  catalog.forEach((tool, index) => {
    const subject = subjectOf(tool);
    const seen = new Set<string>();
    for (const p of gives(tool)) {
      const fromSubject = p.entity.length === 0;
      const entity = fromSubject ? subject : p.entity;
      const key = p.field + "|" + entity.join(",");
      if (seen.has(key)) continue; // same (entity, field) reached by many paths
      seen.add(key);
      if (!byField.has(p.field)) byField.set(p.field, []);
      byField.get(p.field)!.push({ tool: index, entity, type: p.type, path: p.path, fromSubject });
    }
  });

  const quality = catalog.map(producerQuality);

  // ---- match each requirement against the index ----------------------------
  const edges: Edge[] = [];
  const userInputs = new Map<string, string[]>();

  const subjects = catalog.map(subjectOf);

  catalog.forEach((consumer, consumerIndex) => {
    const consumerSlug = String(slugOf(consumer));
    const consumerService = serviceOf(consumer);
    const consumerParams = new Set(requiredParams(consumer).map((p) => p.name));
    const unmet: string[] = [];

    for (const req of needs(consumer)) {
      const ambient = isAmbient(req);
      // A handle is a scalar. `files` on CREATE_A_GIST is an object of file
      // contents -- payload the caller composes, not an id to go fetch.
      // `users`, `teams`, `labels`: a list the caller assembles, not one handle
      // to go and fetch. Same reasoning as an object payload.
      //
      // A plural bare noun counts too, whatever its declared type: `files` on
      // CREATE_A_GIST is typed `string` because Composio flattens the object to
      // JSON, so the type check alone missed it and the gist's file map was being
      // "fetched" from pull-request file shas. A singular noun like `branch`,
      // `tree` or `ref` is a real handle and is unaffected.
      const paramTokens = tokenize(req.param);
      const lastToken = paramTokens[paramTokens.length - 1] ?? "";
      const pluralNoun = req.role === ANY_ROLE && stem(lastToken) !== lastToken;
      const isPayload = req.type === "object" || req.type === "array" || pluralNoun;
      if (req.fixedChoice || isPayload || (ambient && !LINK_AMBIENT_PARAMS)) {
        unmet.push(req.param);
        continue;
      }

      // Which leaf field names could satisfy this role?
      const fields =
        req.role === ANY_ROLE
          ? HANDLE_FIELDS
          : [req.role, ...(ROLE_GROUPS.find((g) => g.includes(req.role)) ?? [])];

      const scored: Array<{ index: number; confidence: number }> = [];
      const bestPerTool = new Map<number, number>();

      for (const field of new Set(fields)) {
        for (const cand of byField.get(field) ?? []) {
          if (cand.tool === consumerIndex) continue; // no self-edges

          // A bare-noun requirement ("give me something identifying a branch")
          // is the loosest kind we have, so demand that the producing tool is
          // actually *about* that noun. Without this, `content` on CREATE_A_BLOB
          // -- the file body you compose yourself -- matched a coincidental
          // `Content` entity inside project items.
          if (req.role === ANY_ROLE && !ambient) {
            if (!req.entity.some((e) => subjects[cand.tool].some((s) => tokenHit(e, s)))) continue;
            // A bare noun is our weakest requirement, so also insist the producer
            // is a retrieval tool. `assignee` was being sourced from
            // ADD_ASSIGNEES_TO_AN_ISSUE -- a mutation you would have to already
            // know the answer to call.
            if (!isRetrieval[cand.tool]) continue;
          }

          if (ambient) {
            // Only reachable with LINK_AMBIENT_PARAMS on: restrict to an
            // entry-point tool actually *about* that entity -- "list my
            // repositories" may tell you a repo name; "list my codespaces"
            // happening to echo one back does not count.
            if (!isEntryPoint[cand.tool]) continue;
            if (!req.entity.some((e) => subjects[cand.tool].some((s) => tokenHit(e, s)))) continue;
          }

          // A tool that itself requires this param cannot be where you get it.
          const producer = catalog[cand.tool];
          if (requiredParams(producer).some((p) => p.name === req.param)) continue;

          // A slug-derived entity is only trustworthy when the tool is *primarily*
          // about the thing required. GET_A_PACKAGE_VERSION_FOR_THE_AUTHENTICATED_USER
          // has subject [package, version, authenticated, user], so a `username`
          // requirement matched on one stray token and took data.name -- which is
          // the package version's name, not a login.
          if (cand.fromSubject && subjects[cand.tool].length > req.entity.length + 1) continue;

          const entityFit = entityScore(req.entity, cand.entity);
          // "any identifying field of X" is only meaningful if it really is an X.
          // Without this, `package_type` matched anything with "package" in it.
          if (req.role === ANY_ROLE && entityFit < 1) continue;

          const confidence = roleScore(req.role, field) * entityFit * typeScore(req.type, cand.type);
          if (confidence < MIN_CONFIDENCE) continue;

          const prior = bestPerTool.get(cand.tool);
          if (prior === undefined || confidence > prior) bestPerTool.set(cand.tool, confidence);
        }
      }

      for (const [index, confidence] of bestPerTool) scored.push({ index, confidence });
      if (scored.length === 0) {
        unmet.push(req.param);
        continue;
      }

      // Rank: confidence first, then scope fit, then how good a producer it is.
      const rank = (i: number) =>
        scopeAffinity(catalog[i], consumerParams) * 2 +
        quality[i] +
        (serviceOf(catalog[i]) === consumerService ? 1 : 0);

      scored.sort((a, b) => {
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        const diff = rank(b.index) - rank(a.index);
        if (diff !== 0) return diff;
        return String(slugOf(catalog[a.index])).localeCompare(String(slugOf(catalog[b.index])));
      });

      for (const { index, confidence } of scored.slice(0, MAX_PRODUCERS_PER_REQUIREMENT)) {
        edges.push({
          from: String(slugOf(catalog[index])),
          to: consumerSlug,
          label: req.param,
          confidence: Math.round(confidence * 100) / 100,
        });
      }
    }

    if (unmet.length) userInputs.set(consumerSlug, unmet);
  });

  for (const node of nodes) {
    const unmet = userInputs.get(node.id);
    if (unmet?.length) node.requires_from_user = unmet;
  }

  edges.sort(
    (a, b) =>
      a.to.localeCompare(b.to) ||
      String(a.label).localeCompare(String(b.label)) ||
      (b.confidence ?? 0) - (a.confidence ?? 0) ||
      a.from.localeCompare(b.from),
  );

  return { nodes, edges };
}
