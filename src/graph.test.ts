/**
 * End-to-end tests of buildGraph against a small synthetic toolkit.
 *
 * The fixture is a fake "acme" toolkit, not GitHub, which is the point: if the
 * generator only worked because of GitHub-specific knowledge, none of this would
 * pass. Every expected edge below is written out by hand from the fixture.
 *
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildGraph, MAX_PRODUCERS_PER_REQUIREMENT, type Edge, type Tool } from "./infer.ts";

/* ------------------------------------------------------------------ *
 * a small, complete fake toolkit
 * ------------------------------------------------------------------ */

function consumer(slug: string, required: Record<string, any>, tags: string[] = []): Tool {
  return {
    slug,
    tags,
    toolkit: { slug: "acme", name: "acme" },
    inputParameters: { type: "object", properties: required, required: Object.keys(required) },
    outputParameters: { type: "object", properties: {} },
  };
}

/** Returns a list of `entity` objects carrying `fields`. */
function producer(
  slug: string,
  entity: string,
  fields: Record<string, any>,
  required: Record<string, any> = {},
  tags: string[] = ["readOnlyHint"],
): Tool {
  return {
    slug,
    tags,
    toolkit: { slug: "acme", name: "acme" },
    inputParameters: { type: "object", properties: required, required: Object.keys(required) },
    outputParameters: {
      type: "object",
      title: `${slug}ResponseWrapper`,
      properties: { data: { $ref: "#/$defs/Resp" } },
      $defs: {
        Resp: {
          type: "object",
          title: `${slug}Response`,
          properties: { items: { type: "array", items: { $ref: `#/$defs/${entity}` } } },
        },
        [entity]: { type: "object", title: entity, properties: fields },
      },
    },
  };
}

const INT = { type: "integer" };
const STR = { type: "string" };

function fixture(): Tool[] {
  return [
    // producers
    producer("ACME_LIST_TICKETS", "Ticket", { id: INT, number: INT, title: STR }, {}, [
      "readOnlyHint",
      "tickets",
    ]),
    producer("ACME_LIST_COMMENTS", "Comment", { id: INT, body: STR }, { ticket_number: INT }),
    producer("ACME_LIST_LABELS", "Label", { id: INT, name: STR }),
    producer("ACME_LIST_BRANCHES", "Branch", { name: STR, sha: STR }),

    // a tool that both needs and gives a ticket number
    {
      ...producer("ACME_GET_TICKET", "Ticket", { id: INT, number: INT }, { ticket_number: INT }),
    },

    // consumers
    consumer("ACME_COMMENT_ON_TICKET", { ticket_number: INT, body: STR }, ["tickets", "createHint"]),
    consumer("ACME_DELETE_COMMENT", { comment_id: INT }, ["destructiveHint"]),
    consumer("ACME_PROTECT_BRANCH", { branch: STR }),
    consumer("ACME_SET_VISIBILITY", { visibility: { type: "string", enum: ["public", "private"] } }),
    consumer("ACME_CREATE_BLOB", { content: { type: "object" } }),
  ];
}

const find = (edges: Edge[], from: string, to: string, label: string) =>
  edges.find((e) => e.from === from && e.to === to && e.label === label);

/* ------------------------------------------------------------------ *
 * the dependencies it should find
 * ------------------------------------------------------------------ */

describe("buildGraph on a synthetic toolkit", () => {
  it("wires a produced entity field to the requirement naming it", async () => {
    const { edges } = await buildGraph(fixture());
    const e = find(edges, "ACME_LIST_TICKETS", "ACME_COMMENT_ON_TICKET", "ticket_number");
    assert.ok(e, "expected LIST_TICKETS -> COMMENT_ON_TICKET via ticket_number");
    assert.equal(e.confidence, 1);
  });

  it("points the edge producer -> consumer, not the reverse", async () => {
    const { edges } = await buildGraph(fixture());
    assert.ok(!find(edges, "ACME_COMMENT_ON_TICKET", "ACME_LIST_TICKETS", "ticket_number"));
  });

  it("matches an id through a differently named entity", async () => {
    const { edges } = await buildGraph(fixture());
    assert.ok(find(edges, "ACME_LIST_COMMENTS", "ACME_DELETE_COMMENT", "comment_id"));
  });

  it("does not offer a sibling entity's id", async () => {
    // Label.id has the same shape as comment_id and sits right next to it.
    const { edges } = await buildGraph(fixture());
    assert.ok(
      !find(edges, "ACME_LIST_LABELS", "ACME_DELETE_COMMENT", "comment_id"),
      "Label.id must not satisfy comment_id",
    );
  });

  it("satisfies a bare-noun requirement from a tool about that noun", async () => {
    const { edges } = await buildGraph(fixture());
    assert.ok(find(edges, "ACME_LIST_BRANCHES", "ACME_PROTECT_BRANCH", "branch"));
  });

  it("will not use a producer that itself requires the same param", async () => {
    // GET_TICKET returns Ticket.number but needs ticket_number to be called,
    // so it is no help in obtaining one.
    const { edges } = await buildGraph(fixture());
    assert.ok(
      !find(edges, "ACME_GET_TICKET", "ACME_COMMENT_ON_TICKET", "ticket_number"),
      "a tool requiring X cannot be the source of X",
    );
  });

  it("never emits a self-edge", async () => {
    const { edges } = await buildGraph(fixture());
    assert.equal(edges.filter((e) => e.from === e.to).length, 0);
  });
});

/* ------------------------------------------------------------------ *
 * what it should refuse to treat as a dependency
 * ------------------------------------------------------------------ */

describe("non-dependencies", () => {
  it("treats an enum param as a choice, not something to fetch", async () => {
    const { nodes, edges } = await buildGraph(fixture());
    assert.equal(edges.filter((e) => e.label === "visibility").length, 0);
    const n = nodes.find((n) => n.id === "ACME_SET_VISIBILITY");
    assert.deepEqual(n?.requires_from_user, ["visibility"]);
  });

  it("treats an object payload as caller-composed", async () => {
    const { nodes, edges } = await buildGraph(fixture());
    assert.equal(edges.filter((e) => e.label === "content").length, 0);
    assert.deepEqual(
      nodes.find((n) => n.id === "ACME_CREATE_BLOB")?.requires_from_user,
      ["content"],
    );
  });

  it("reports a free-text requirement as something to ask the user", async () => {
    const { nodes } = await buildGraph(fixture());
    const n = nodes.find((n) => n.id === "ACME_COMMENT_ON_TICKET");
    assert.ok(n?.requires_from_user?.includes("body"));
    assert.ok(!n?.requires_from_user?.includes("ticket_number"), "that one is satisfiable by a tool");
  });
});

/* ------------------------------------------------------------------ *
 * graph shape and invariants
 * ------------------------------------------------------------------ */

describe("graph invariants", () => {
  it("emits one node per catalog tool, id taken from the slug", async () => {
    const tools = fixture();
    const { nodes } = await buildGraph(tools);
    assert.equal(nodes.length, tools.length);
    assert.deepEqual(
      nodes.map((n) => n.id).sort(),
      tools.map((t) => t.slug).sort(),
    );
  });

  it("labels every edge and keeps both endpoints in nodes", async () => {
    const { nodes, edges } = await buildGraph(fixture());
    const ids = new Set(nodes.map((n) => n.id));
    for (const e of edges) {
      assert.ok(e.label, `unlabelled edge ${e.from} -> ${e.to}`);
      assert.ok(ids.has(e.from), `unknown producer ${e.from}`);
      assert.ok(ids.has(e.to), `unknown consumer ${e.to}`);
    }
  });

  it("derives service from a tag", async () => {
    const { nodes } = await buildGraph(fixture());
    assert.equal(nodes.find((n) => n.id === "ACME_LIST_TICKETS")?.service, "tickets");
  });

  it("caps how many producers one requirement can have", async () => {
    // five interchangeable producers, only the best few should survive
    const many: Tool[] = [];
    for (let i = 0; i < 5; i++) {
      many.push(producer(`ACME_LIST_TICKETS_${i}`, "Ticket", { number: INT }));
    }
    many.push(consumer("ACME_COMMENT_ON_TICKET", { ticket_number: INT }));
    const { edges } = await buildGraph(many);
    assert.equal(edges.length, MAX_PRODUCERS_PER_REQUIREMENT);
  });

  it("is deterministic", async () => {
    const a = await buildGraph(fixture());
    const b = await buildGraph(fixture());
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  it("handles an empty catalog", async () => {
    assert.deepEqual(await buildGraph([]), { nodes: [], edges: [] });
  });

  it("skips catalog entries with no usable slug", async () => {
    const { nodes } = await buildGraph([{ description: "nameless" }, ...fixture()]);
    assert.equal(nodes.length, fixture().length);
  });
});

/* ------------------------------------------------------------------ *
 * generalisation
 * ------------------------------------------------------------------ */

describe("generalisation", () => {
  /** Rename every slug, entity and param in the fixture. */
  function renamed(): Tool[] {
    const json = JSON.stringify(fixture())
      .replace(/ACME_/g, "WIDGET_")
      .replace(/TICKET/g, "SPROCKET") // slugs are upper case
      .replace(/Ticket/g, "Sprocket") // schema titles are PascalCase
      .replace(/ticket/g, "sprocket") // param names are lower case
      .replace(/acme/g, "widget");
    return JSON.parse(json);
  }

  it("finds the same dependency under different names", async () => {
    const { edges } = await buildGraph(renamed());
    const e = find(edges, "WIDGET_LIST_SPROCKETS", "WIDGET_COMMENT_ON_SPROCKET", "sprocket_number");
    assert.ok(e, "the renamed toolkit should yield the renamed dependency");
  });

  it("leaks no name from the original toolkit", async () => {
    const graph = await buildGraph(renamed());
    const text = JSON.stringify(graph);
    assert.ok(!/ACME_/.test(text), "found an ACME_ slug in a WIDGET_ catalog");
    assert.ok(!/ticket/i.test(text), "found a ticket label in a sprocket catalog");
  });

  it("produces the same number of edges as the original", async () => {
    // renaming is structure-preserving, so the graph must be isomorphic
    const before = await buildGraph(fixture());
    const after = await buildGraph(renamed());
    assert.equal(after.edges.length, before.edges.length);
    assert.equal(after.nodes.length, before.nodes.length);
  });

  it("changes its output when the input changes", async () => {
    const full = await buildGraph(fixture());
    const trimmed = await buildGraph(fixture().filter((t) => t.slug !== "ACME_LIST_TICKETS"));
    assert.notEqual(full.edges.length, trimmed.edges.length);
  });
});
