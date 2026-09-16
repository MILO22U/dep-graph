/**
 * Unit tests for the inference primitives.
 *
 * Most of these are regression tests for a specific bug or near-miss found while
 * building the generator, and each one says which. They are the cases where the
 * obvious implementation is wrong.
 *
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ANY_ROLE,
  entityScore,
  gives,
  isEnvelopeTitle,
  needs,
  parseRequirement,
  producerQuality,
  requiredParams,
  roleScore,
  scopeAffinity,
  serviceOf,
  slugOf,
  splitCompound,
  stem,
  subjectOf,
  titleEntity,
  tokenHit,
  tokenize,
  typeScore,
  type Tool,
} from "./infer.ts";

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */

function tool(partial: Partial<Tool> & { slug: string }): Tool {
  return {
    toolkit: { slug: "acme", name: "acme" },
    tags: [],
    inputParameters: { type: "object", properties: {}, required: [] },
    outputParameters: { type: "object", properties: {} },
    ...partial,
  };
}

/** A tool requiring the given params, all integers unless a schema is given. */
function consumer(slug: string, required: Record<string, any>, tags: string[] = []): Tool {
  return tool({
    slug,
    tags,
    inputParameters: {
      type: "object",
      properties: required,
      required: Object.keys(required),
    },
  });
}

/** A tool returning a list of `entity` objects with the given fields. */
function producer(slug: string, entity: string, fields: Record<string, any>, tags: string[] = []): Tool {
  return tool({
    slug,
    tags,
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
  });
}

/* ------------------------------------------------------------------ *
 * words
 * ------------------------------------------------------------------ */

describe("tokenize", () => {
  it("splits snake_case", () => {
    assert.deepEqual(tokenize("pull_number"), ["pull", "number"]);
  });

  it("splits camelCase and PascalCase", () => {
    assert.deepEqual(tokenize("pullNumber"), ["pull", "number"]);
    assert.deepEqual(tokenize("PullRequest"), ["pull", "request"]);
  });

  it("tolerates empty and punctuation-only input", () => {
    assert.deepEqual(tokenize(""), []);
    assert.deepEqual(tokenize("__"), []);
  });

  it("over-splits acronym-style names -- a known, tolerated imprecision", () => {
    // "GitHubApp" is one word to a human. A required `app_id` still matches,
    // because entity comparison asks whether every token of the REQUIREMENT is
    // accounted for -- ["app"] is covered by ["git","hub","app"], extra producer
    // tokens being allowed. Imprecise, but harmless. Documented in APPROACH.md.
    assert.deepEqual(tokenize("GitHubApp"), ["git", "hub", "app"]);
  });
});

describe("stem", () => {
  it("singularises the plurals that appear as schema titles", () => {
    assert.equal(stem("issues"), "issue");
    assert.equal(stem("repositories"), "repository");
    assert.equal(stem("pulls"), "pull");
  });

  it("leaves short words and double-s words alone", () => {
    assert.equal(stem("gist"), "gist");
    assert.equal(stem("class"), "class");
  });
});

describe("splitCompound", () => {
  it("splits a single word that ends in a role", () => {
    assert.deepEqual(splitCompound(["username"]), ["user", "name"]);
    assert.deepEqual(splitCompound(["filename"]), ["file", "name"]);
  });

  it("leaves already-split tokens untouched", () => {
    assert.deepEqual(splitCompound(["issue", "number"]), ["issue", "number"]);
  });

  it("does not split a word that is only just longer than the role", () => {
    // guard against "ref" -> ["", "ref"] style nonsense
    assert.deepEqual(splitCompound(["ref"]), ["ref"]);
    assert.deepEqual(splitCompound(["id"]), ["id"]);
  });
});

describe("isEnvelopeTitle", () => {
  it("recognises the Composio response wrapper", () => {
    assert.equal(isEnvelopeTitle("ListRepositoryIssuesResponseWrapper"), true);
    assert.equal(isEnvelopeTitle("CreateAnIssueCommentResponse"), true);
  });

  it("does NOT treat a trailing Request as an envelope", () => {
    // REGRESSION: the naive rule (strip response|request|wrapper) deletes the
    // PullRequest entity, which kills the pull_number dependency -- one of the
    // two worked examples in the brief.
    assert.equal(isEnvelopeTitle("PullRequest"), false);
    assert.equal(isEnvelopeTitle("PullRequestReviewComment"), false);
  });
});

describe("titleEntity", () => {
  it("drops qualifiers that do not name a different entity", () => {
    assert.deepEqual(titleEntity("SimpleUser"), ["user"]);
    assert.deepEqual(titleEntity("MinimalRepository"), ["repository"]);
  });

  it("yields no entity for an envelope", () => {
    assert.deepEqual(titleEntity("ListRepositoryIssuesResponseWrapper"), []);
  });

  it("keeps multi-word entities whole", () => {
    assert.deepEqual(titleEntity("PullRequest"), ["pull", "request"]);
    assert.deepEqual(titleEntity("WorkflowRun"), ["workflow", "run"]);
  });
});

/* ------------------------------------------------------------------ *
 * what a tool needs
 * ------------------------------------------------------------------ */

describe("requiredParams", () => {
  it("returns mandatory params only", () => {
    const t = tool({
      slug: "X",
      inputParameters: {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" } },
        required: ["a"],
      },
    });
    assert.deepEqual(requiredParams(t).map((p) => p.name), ["a"]);
  });

  it("survives a catalog entry with no inputParameters at all", () => {
    assert.deepEqual(requiredParams({ slug: "X" }), []);
    assert.deepEqual(requiredParams({ slug: "X", inputParameters: null }), []);
  });

  it("survives required naming a param with no matching property", () => {
    const t = tool({
      slug: "X",
      inputParameters: { type: "object", properties: {}, required: ["ghost"] },
    });
    const got = requiredParams(t);
    assert.equal(got.length, 1);
    assert.deepEqual(got[0].schema, {});
  });

  it("ignores non-string entries in required", () => {
    const t = tool({
      slug: "X",
      inputParameters: { type: "object", properties: {}, required: [null, 7, "", "ok"] as any },
    });
    assert.deepEqual(requiredParams(t).map((p) => p.name), ["ok"]);
  });
});

describe("parseRequirement", () => {
  it("splits entity from role", () => {
    const r = parseRequirement("issue_number", { type: "integer" });
    assert.deepEqual(r.entity, ["issue"]);
    assert.equal(r.role, "number");
    assert.equal(r.type, "integer");
  });

  it("treats a bare noun as any identifying field of that entity", () => {
    const r = parseRequirement("branch", { type: "string" });
    assert.deepEqual(r.entity, ["branch"]);
    assert.equal(r.role, ANY_ROLE);
  });

  it("gives a bare role word no entity", () => {
    // `sha` alone can only be matched on field name, which is deliberately weak
    assert.deepEqual(parseRequirement("sha", { type: "string" }).entity, []);
    assert.equal(parseRequirement("sha", { type: "string" }).role, "sha");
  });

  it("flags an enum as a fixed choice, not a dependency", () => {
    const r = parseRequirement("state", { type: "string", enum: ["open", "closed"] });
    assert.equal(r.fixedChoice, true);
    assert.equal(parseRequirement("state", { type: "string" }).fixedChoice, false);
  });

  it("stems the entity so plural titles still match", () => {
    assert.deepEqual(parseRequirement("issues_number", {}).entity, ["issue"]);
  });
});

/* ------------------------------------------------------------------ *
 * what a tool gives
 * ------------------------------------------------------------------ */

describe("gives", () => {
  it("resolves $ref into $defs and tags the field with its entity", () => {
    const p = producer("LIST_TICKETS", "Ticket", { number: { type: "integer" } });
    const found = gives(p).find((f) => f.field === "number");
    assert.ok(found, "expected to find the number field");
    assert.deepEqual(found.entity, ["ticket"]);
    assert.equal(found.path, "data.items[].number");
  });

  it("keeps sibling entities apart", () => {
    const p = tool({
      slug: "LIST_THINGS",
      outputParameters: {
        type: "object",
        title: "ListThingsResponseWrapper",
        properties: { data: { $ref: "#/$defs/Resp" } },
        $defs: {
          Resp: {
            type: "object",
            title: "ListThingsResponse",
            properties: {
              issue: { $ref: "#/$defs/Issue" },
              label: { $ref: "#/$defs/Label" },
            },
          },
          Issue: { type: "object", title: "Issue", properties: { id: { type: "integer" } } },
          Label: { type: "object", title: "Label", properties: { id: { type: "integer" } } },
        },
      },
    });
    const ids = gives(p).filter((f) => f.field === "id");
    assert.deepEqual(
      ids.map((f) => f.entity.join(",")).sort(),
      ["issue", "label"],
    );
  });

  it("terminates on a recursive schema", () => {
    // REGRESSION: Team.parent is a Team. Without the seen-title guard this
    // recurses until the depth cap, or forever if the cap is removed.
    const p = tool({
      slug: "GET_TEAM",
      outputParameters: {
        type: "object",
        title: "GetTeamResponseWrapper",
        properties: { data: { $ref: "#/$defs/Team" } },
        $defs: {
          Team: {
            type: "object",
            title: "Team",
            properties: { slug: { type: "string" }, parent: { $ref: "#/$defs/Team" } },
          },
        },
      },
    });
    const out = gives(p);
    assert.ok(out.some((f) => f.field === "slug"));
    assert.ok(out.length < 50, `expected a small result, got ${out.length}`);
  });

  it("survives a dangling $ref", () => {
    const p = tool({
      slug: "BROKEN",
      outputParameters: {
        type: "object",
        properties: { data: { $ref: "#/$defs/Missing" } },
        $defs: {},
      },
    });
    assert.deepEqual(gives(p), []);
  });

  it("survives missing or malformed outputParameters", () => {
    assert.deepEqual(gives({ slug: "X" }), []);
    assert.deepEqual(gives({ slug: "X", outputParameters: null }), []);
    assert.deepEqual(gives({ slug: "X", outputParameters: "nope" as any }), []);
  });
});

/* ------------------------------------------------------------------ *
 * matching
 * ------------------------------------------------------------------ */

describe("tokenHit", () => {
  it("accepts containment across a small length gap", () => {
    assert.equal(tokenHit("hook", "webhook"), true); // gap 3
    assert.equal(tokenHit("branch", "branche"), true); // gap 1, from stemming
  });

  it("rejects a short token sitting inside a different word", () => {
    // REGRESSION: a plain prefix rule matches run/runner, and a workflow run id
    // is not a self-hosted runner id.
    assert.equal(tokenHit("run", "runner"), false);
  });

  it("rejects containment across a wide gap", () => {
    // REGRESSION: an abbreviation rule keyed on a wide length gap (to catch
    // repo/repository) also accepted code/codespace, and sourced a GitHub App
    // manifest `code` from a codespace export. Measured on the labelled sample,
    // dropping that rule was a net precision win.
    assert.equal(tokenHit("code", "codespace"), false);
  });

  it("no longer resolves wide abbreviations -- an accepted recall cost", () => {
    // repo/repository and org/organization are the casualties. They cost nothing
    // in practice because `repo`/`org` are ambient context reported as
    // requires_from_user rather than linked. Documented in APPROACH.md as a
    // limit that would matter for a toolkit where an abbreviation IS a handle.
    assert.equal(tokenHit("repo", "repository"), false);
  });

  it("is symmetric", () => {
    assert.equal(tokenHit("repository", "repo"), tokenHit("repo", "repository"));
    assert.equal(tokenHit("webhook", "hook"), tokenHit("hook", "webhook"));
  });
});

describe("entityScore", () => {
  it("scores a full match highest", () => {
    assert.equal(entityScore(["issue"], ["issue"]), 1);
  });

  it("matches a requirement against a more specific producer entity", () => {
    assert.equal(entityScore(["comment"], ["issue", "comment"]), 1);
    assert.equal(entityScore(["pull"], ["pull", "request"]), 1);
  });

  it("rejects an unrelated entity outright", () => {
    assert.equal(entityScore(["comment"], ["label"]), 0);
  });

  it("rejects a partial overlap outright", () => {
    // REGRESSION: partial credit (0.6) cleared the confidence floor and offered a
    // runner LABEL id for `runner_group_id`, and a custom organization ROLE name
    // for `custom_property_name`. A requirement naming two things means both.
    assert.equal(entityScore(["check", "run"], ["workflow", "run"]), 0);
    assert.equal(entityScore(["runner", "group"], ["runner", "label"]), 0);
  });

  it("still matches when the producer entity is the more specific one", () => {
    // every requirement token accounted for, even though the producer has extras
    assert.equal(entityScore(["asset"], ["release", "asset"]), 1);
  });

  it("is weak, not zero, when the requirement names no entity", () => {
    const weak = entityScore([], ["issue"]);
    assert.ok(weak > 0 && weak < 0.5, `expected a weak score, got ${weak}`);
  });
});

describe("roleScore", () => {
  it("scores an exact role match highest", () => {
    assert.equal(roleScore("number", "number"), 1);
  });

  it("treats name and login as interchangeable, at a discount", () => {
    const s = roleScore("name", "login");
    assert.ok(s > 0 && s < 1, `expected a discount, got ${s}`);
  });

  it("rejects a role from a different group", () => {
    assert.equal(roleScore("number", "login"), 0);
  });

  it("accepts any handle field for ANY_ROLE, but nothing else", () => {
    assert.ok(roleScore(ANY_ROLE, "id") > 0.8);
    assert.equal(roleScore(ANY_ROLE, "description"), 0);
  });
});

describe("typeScore", () => {
  it("all but rejects a string standing in for an integer id", () => {
    // stops a string node_id being offered where an integer id is required
    assert.ok(typeScore("integer", "string") < 0.2);
  });

  it("accepts integer/number as equivalent", () => {
    assert.equal(typeScore("integer", "number"), 1);
  });

  it("tolerates a stringified id", () => {
    assert.ok(typeScore("string", "integer") > 0.5);
  });

  it("only mildly discounts an unknown type", () => {
    assert.ok(typeScore(undefined, "integer") > 0.8);
    assert.ok(typeScore("integer", undefined) > 0.8);
  });
});

/* ------------------------------------------------------------------ *
 * producer preference
 * ------------------------------------------------------------------ */

describe("producerQuality", () => {
  it("prefers a read-only listing over a destructive tool", () => {
    const list = consumer("ACME_LIST_TICKETS", {}, ["readOnlyHint"]);
    const del = consumer("ACME_DELETE_TICKET", {}, ["destructiveHint"]);
    assert.ok(producerQuality(list) > producerQuality(del));
  });

  it("penalises a deprecated tool heavily", () => {
    const ok = consumer("ACME_LIST_TICKETS", {}, ["readOnlyHint"]);
    const old = tool({ slug: "ACME_LIST_TICKETS", tags: ["readOnlyHint"], isDeprecated: true });
    assert.ok(producerQuality(old) < producerQuality(ok) - 5);
  });
});

describe("scopeAffinity", () => {
  it("prefers a producer already satisfied by the consumer's own params", () => {
    // REGRESSION: ranking by "fewest inputs" picked
    // LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER over LIST_REPOSITORY_ISSUES
    // for a consumer scoped to one repo. Scope affinity inverts that.
    const consumerParams = new Set(["owner", "repo", "issue_number", "body"]);
    const sameScope = consumer("ACME_LIST_REPOSITORY_TICKETS", {
      owner: { type: "string" },
      repo: { type: "string" },
    });
    const globalScope = consumer("ACME_LIST_MY_TICKETS", {});
    const otherScope = consumer("ACME_SEARCH_TICKETS", { q: { type: "string" } });

    assert.ok(scopeAffinity(sameScope, consumerParams) > scopeAffinity(globalScope, consumerParams));
    assert.ok(scopeAffinity(globalScope, consumerParams) > scopeAffinity(otherScope, consumerParams));
  });
});

/* ------------------------------------------------------------------ *
 * misc
 * ------------------------------------------------------------------ */

describe("serviceOf", () => {
  it("ignores behavioural hint tags", () => {
    const t = tool({ slug: "X", tags: ["important", "openWorldHint", "Comments", "createHint"] });
    assert.equal(serviceOf(t), "comments");
  });

  it("falls back to the toolkit slug when only noise tags remain", () => {
    const t = tool({ slug: "X", tags: ["readOnlyHint", "mcpIgnore"] });
    assert.equal(serviceOf(t), "acme");
  });
});

describe("subjectOf", () => {
  it("strips the toolkit prefix and the action verb", () => {
    const t = tool({ slug: "ACME_CREATE_AN_TICKET_COMMENT" });
    assert.deepEqual(subjectOf(t), ["ticket", "comment"]);
  });
});

describe("slugOf", () => {
  it("accepts the alternative shapes a catalog may use", () => {
    assert.equal(slugOf({ slug: "A" }), "A");
    assert.equal(slugOf({ name: "B" }), "B");
    assert.equal(slugOf({ function: { name: "C" } }), "C");
    assert.equal(slugOf({}), undefined);
  });
});

describe("needs", () => {
  it("parses every required param of a tool", () => {
    const c = consumer("ACME_COMMENT", {
      ticket_number: { type: "integer" },
      body: { type: "string" },
    });
    assert.deepEqual(needs(c).map((r) => r.param).sort(), ["body", "ticket_number"]);
  });
});
