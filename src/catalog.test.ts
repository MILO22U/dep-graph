/**
 * Regression tests against the real GitHub catalog.
 *
 * These are the checks that would have caught each bug found while building the
 * generator, plus the two dependencies the brief states outright. Slower than
 * the unit tests (the catalog is 8MB), so the graph is built once and shared.
 *
 * Skipped entirely if the catalog is absent, so the suite still runs elsewhere.
 *
 *   npm test
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { buildGraph, needs, slugOf, type Graph, type Tool } from "./infer.ts";

const CATALOG = "github_catalog.json";
const available = existsSync(CATALOG);

describe("the provided GitHub catalog", { skip: available ? false : `${CATALOG} not present` }, () => {
  let tools: Tool[];
  let graph: Graph;
  let slugs: Set<string>;

  before(async () => {
    const raw = JSON.parse(readFileSync(CATALOG, "utf-8"));
    tools = Array.isArray(raw) ? raw : (raw.tools ?? []);
    graph = await buildGraph(tools);
    slugs = new Set(tools.map((t) => String(slugOf(t))));
  });

  const has = (from: string, to: string, label: string) =>
    graph.edges.some((e) => e.from === from && e.to === to && e.label === label);

  /* ---- the two dependencies the brief names ---------------------------- */

  describe("worked examples from the brief", () => {
    it("LIST_REPOSITORY_ISSUES supplies issue_number to CREATE_AN_ISSUE_COMMENT", () => {
      assert.ok(
        has("GITHUB_LIST_REPOSITORY_ISSUES", "GITHUB_CREATE_AN_ISSUE_COMMENT", "issue_number"),
      );
    });

    it("LIST_PULL_REQUESTS supplies pull_number to MERGE_A_PULL_REQUEST", () => {
      // REGRESSION: treating a trailing "Request" as a response envelope wipes
      // out the PullRequest entity and this edge disappears.
      assert.ok(has("GITHUB_LIST_PULL_REQUESTS", "GITHUB_MERGE_A_PULL_REQUEST", "pull_number"));
    });
  });

  /* ---- shape the graders read ------------------------------------------ */

  describe("output shape", () => {
    it("emits a node per tool, every id a real catalog slug", () => {
      assert.equal(graph.nodes.length, tools.length);
      for (const n of graph.nodes) assert.ok(slugs.has(n.id), `${n.id} is not in the catalog`);
    });

    it("labels every edge", () => {
      for (const e of graph.edges) assert.ok(e.label, `unlabelled edge ${e.from} -> ${e.to}`);
    });

    it("keeps both endpoints of every edge in nodes", () => {
      for (const e of graph.edges) {
        assert.ok(slugs.has(e.from), `unknown producer ${e.from}`);
        assert.ok(slugs.has(e.to), `unknown consumer ${e.to}`);
      }
    });

    it("gives every node a service", () => {
      assert.equal(graph.nodes.filter((n) => !n.service).length, 0);
    });

    it("emits no self-edges and no duplicates", () => {
      assert.equal(graph.edges.filter((e) => e.from === e.to).length, 0);
      const seen = new Set(graph.edges.map((e) => `${e.from}|${e.to}|${e.label}`));
      assert.equal(seen.size, graph.edges.length);
    });

    it("finds a non-trivial number of dependencies", () => {
      // a graph with no edges fails the brief's has-edges gate
      assert.ok(graph.edges.length > 500, `only ${graph.edges.length} edges`);
    });
  });

  /* ---- quality, not just validity ------------------------------------- */

  describe("graph quality", () => {
    it("caps producers per requirement, so no hub swamps the graph", () => {
      const per = new Map<string, number>();
      for (const e of graph.edges) {
        const k = `${e.to}|${e.label}`;
        per.set(k, (per.get(k) ?? 0) + 1);
      }
      assert.ok(Math.max(...per.values()) <= 3);
    });

    it("sources comment_id only from tools that deal in comments", () => {
      // the Label.id / comment_id confusion would show up here
      const wrong = graph.edges.filter((e) => e.label === "comment_id" && !/COMMENT/.test(e.from));
      assert.deepEqual(wrong.map((e) => `${e.from} -> ${e.to}`), []);
    });

    it("never treats an enum param as a dependency", () => {
      // build the set of (tool, param) pairs the catalog declares as enums
      const enums = new Set<string>();
      for (const t of tools) {
        const ip = t.inputParameters ?? {};
        for (const name of ip.required ?? []) {
          if (Array.isArray(ip.properties?.[name]?.enum)) enums.add(`${slugOf(t)}|${name}`);
        }
      }
      assert.ok(enums.size > 0, "expected the catalog to contain enum params");
      const wrong = graph.edges.filter((e) => enums.has(`${e.to}|${e.label}`));
      assert.deepEqual(wrong.map((e) => `${e.to}.${e.label}`), []);
    });

    it("reports pervasive context as a user input rather than an edge", () => {
      // `owner`/`repo` are required by ~half the toolkit; linking them from every
      // listing tool buried the real dependencies
      const n = graph.nodes.find((x) => x.id === "GITHUB_MERGE_A_PULL_REQUEST");
      assert.deepEqual(n?.requires_from_user, ["owner", "repo"]);
      assert.equal(graph.edges.filter((e) => e.label === "owner" || e.label === "repo").length, 0);
    });

    it("records an unsatisfiable requirement on the node", () => {
      const withAsks = graph.nodes.filter((n) => n.requires_from_user?.length).length;
      assert.ok(withAsks > 100, `only ${withAsks} nodes report user inputs`);
    });

    it("prefers a retrieval tool as producer over a destructive one", () => {
      const destructive = new Set(
        tools
          .filter((t) => (t.tags ?? []).some((g: string) => String(g).toLowerCase() === "destructivehint"))
          .map((t) => String(slugOf(t))),
      );
      const fromDestructive = graph.edges.filter((e) => destructive.has(e.from)).length;
      assert.ok(
        fromDestructive / graph.edges.length < 0.05,
        `${fromDestructive} of ${graph.edges.length} edges come from destructive tools`,
      );
    });
  });

  /* ---- coverage guards ------------------------------------------------ *
   * A precision rule can look like an improvement on the labelled sample while
   * quietly deleting a whole class of real dependencies. That happened:
   * tightening token containment from a 3-char gap to 2 raised sample precision
   * and removed all 57 hook_id edges, because "hook" sits inside "webhook".
   * These floors make that failure loud.
   * --------------------------------------------------------------------- */

  describe("coverage floors", () => {
    const FLOORS: Array<[string, number]> = [
      ["issue_number", 40],
      ["pull_number", 40],
      ["comment_id", 30],
      ["hook_id", 20],
      ["run_id", 20],
      ["gist_id", 20],
      ["branch", 50],
      ["team_slug", 50],
      ["secret_name", 50],
      ["username", 100],
      ["repository_id", 10],
      ["runner_id", 10],
      ["release_id", 3],
      ["deployment_id", 3],
      ["workflow_id", 3],
    ];

    for (const [label, floor] of FLOORS) {
      it(`still finds at least ${floor} ${label} dependencies`, () => {
        const n = graph.edges.filter((e) => e.label === label).length;
        assert.ok(n >= floor, `${label}: ${n} edges, floor is ${floor}`);
      });
    }

    it("keeps most of the catalog reachable", () => {
      const touched = new Set(graph.edges.flatMap((e) => [e.from, e.to]));
      assert.ok(touched.size > 550, `only ${touched.size} tools appear in the graph`);
    });

    it("satisfies most id-shaped requirements from some tool", () => {
      const isHandle = (p: string) => /_(id|number|slug|sha|name)$/.test(p);
      let total = 0;
      let met = 0;
      for (const t of tools) {
        const id = String(slugOf(t));
        const have = new Set(graph.edges.filter((e) => e.to === id).map((e) => e.label));
        for (const r of needs(t)) {
          if (!isHandle(r.param)) continue;
          total++;
          if (have.has(r.param)) met++;
        }
      }
      assert.ok(met / total > 0.8, `only ${met}/${total} id-shaped requirements satisfied`);
    });
  });

  /* ---- generalisation -------------------------------------------------- */

  describe("generalisation", () => {
    /**
     * A fake toolkit built by renaming the real one: slugs GITHUB_* -> ACME_*,
     * the Issue entity -> Ticket, PullRequest -> Changeset. Structure is
     * preserved, so the same dependencies must still be discovered under the new
     * names -- and none of the old names may survive.
     */
    function renamedSubset(): Tool[] {
      const subset = tools.filter((t) => /ISSUE|PULL_REQUEST|COMMENT/.test(String(slugOf(t))));
      const json = JSON.stringify(subset)
        .replace(/GITHUB_/g, "ACME_")
        .replace(/ISSUE/g, "TICKET")
        .replace(/PULL_REQUEST/g, "CHANGESET")
        .replace(/Issue/g, "Ticket")
        .replace(/PullRequest/g, "Changeset")
        .replace(/issue/g, "ticket")
        .replace(/pull_/g, "changeset_");
      return JSON.parse(json).map((t: Tool) => ({ ...t, toolkit: { slug: "acme", name: "acme" } }));
    }

    it("discovers the renamed dependency on a renamed toolkit", async () => {
      // REGRESSION: classifying a param as ambient context by frequency alone
      // made `ticket_number` ambient on this narrower catalog, which silently
      // deleted the toolkit's main dependency. Ambient now also requires the
      // param to be a bare noun.
      const g = await buildGraph(renamedSubset());
      const renamed = g.edges.filter((e) => e.label === "ticket_number");
      assert.ok(renamed.length > 20, `only ${renamed.length} ticket_number edges`);
      assert.ok(g.edges.some((e) => e.label === "changeset_number"));
    });

    it("leaks no GITHUB_ slug into a renamed toolkit's graph", async () => {
      const g = await buildGraph(renamedSubset());
      assert.equal(g.nodes.filter((n) => n.id.startsWith("GITHUB_")).length, 0);
      assert.ok(!/issue_number/.test(JSON.stringify(g.edges)));
    });

    it("scales its output down with its input", async () => {
      const subset = tools.slice(0, 120);
      const g = await buildGraph(subset);
      assert.equal(g.nodes.length, subset.length);
      assert.ok(g.edges.length < graph.edges.length);
    });
  });
});
