# How the generator works

## The problem in one line

A tool cannot run without its required inputs. `GITHUB_CREATE_AN_ISSUE_COMMENT`
requires `issue_number`, and you cannot invent one — so either the user supplies
it, or another tool has to run first and hand it over.

So the generator answers two questions for every tool in the catalog — *what do
you need?* and *what do you give?* — and wires the needs to the gives.

## The wrinkle that makes it non-trivial

The names don't match. The consumer asks for **`issue_number`**. The producer
returns a field called **`number`**. String equality finds nothing.

What makes the match real is *where* that field lives: `number` sits inside an
object titled `Issue`, and the required param is `issue` + `number`. So matching
is on an **(entity, role)** pair, never on the raw name:

| | entity | role |
|---|---|---|
| required `issue_number` | `issue` | `number` |
| produced `Issue.number` | `issue` | `number` |
| produced `Label.id` | `label` | `id` |

The first two match. The third is the trap — same shape, wrong entity — and
keeping them apart is most of the work.

Nothing in this is keyed to GitHub: the entity comes from JSON Schema titles and
`$defs`, the role from the param name's own suffix.

## Pipeline

1. **`needs(tool)`** — reads `inputParameters.required` (mandatory only; optional
   params are not dependencies) and splits each name into entity + role.
   `pull_number` → (`pull`, `number`); `username` → (`user`, `name`); a bare noun
   like `branch` → (`branch`, *any identifying field*).

2. **`gives(tool)`** — walks `outputParameters`, resolving `$ref` into `$defs`,
   and records every leaf field **tagged with the entity enclosing it**. So
   `data.issues[].number` is recorded as (`issue`, `number`).

3. **Match** — `score = role fit × entity fit × type fit`. All three must hold.
   Type fit is what stops a string `node_id` being passed where an integer id is
   required.

4. **Rank and cap** — many tools can hand over the same id, so keep the best 3
   per requirement.

5. **Leftovers** — a required param no tool can produce is recorded on the node
   as `requires_from_user`. That is the other half of the README's ask: *what
   info to get from the user* versus *what action to take first*.

## Judgement calls, and why

**Envelopes are not entities.** Composio wraps every result as
`{data, error, successful}` under a title like
`ListRepositoryIssuesResponseWrapper`. Tokenising that would make every field
inherit a fake `list`/`repository`/`issue` entity and match almost anything, so
titles ending in `Response`/`Wrapper` contribute no entity at all. A trailing
`Request` is deliberately *not* treated as an envelope — `PullRequest` is a real
entity, and that naive rule would have destroyed one of the two examples the
brief gives.

**Fallback to the tool's own subject.** `GITHUB_CREATE_AN_ISSUE_COMMENT` returns
the new comment's fields directly on its response envelope, so `data.id` has no
`IssueComment` title to inherit. When a field has no enclosing entity, it is
attributed to the subject in the tool's own slug (`issue`, `comment`).

**Scope beats cheapness when ranking producers.** Both
`LIST_REPOSITORY_ISSUES` and `LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER`
yield an issue number, and the second needs no inputs at all — so a
"fewest prerequisites" ranking picks it, which is wrong. If you are commenting on
an issue in a specific repo you must list *that repo's* issues. The signal used
instead is **scope affinity**: a producer whose own requirements are already
satisfied by the consumer's (`owner`, `repo`) operates in the same scope.

**Ambient context is not a dependency.** `owner` and `repo` are required by 442
of 893 tools. Almost any listing echoes a repo name back, so linking them
produced ~1,300 edges out of a handful of hub tools — technically true, but it
buries every real dependency. They are reported as `requires_from_user` instead.
`LINK_AMBIENT_PARAMS` flips this back on.

But *frequency alone is the wrong test*, and the generalisation run below caught
it: on a narrow catalog (only the issues tools) `issue_number` also crosses the
threshold, and calling it ambient silently deleted the toolkit's main
dependency. So ambient means **pervasive *and* shapeless** — a param carrying an
explicit role (`*_number`, `*_id`, `*_slug`) is a handle however common it is;
only bare nouns can be ambient.

**Enums and payloads are never dependencies.** `state`, `visibility` and
`package_type` are fixed choices the caller picks. `files` on `CREATE_A_GIST` is
an object of file content the caller composes. Neither is a handle to fetch, so
params with an `enum`, and params of type `object`, are excluded.

## Does it work?

Both worked examples from the brief are present:

```
GITHUB_LIST_REPOSITORY_ISSUES --issue_number--> GITHUB_CREATE_AN_ISSUE_COMMENT
GITHUB_LIST_PULL_REQUESTS     --pull_number --> GITHUB_MERGE_A_PULL_REQUEST
```

On `github_catalog.json`: **893 nodes, 1,863 edges**, every node id a real
catalog slug, every edge labelled, max fan-in 10 (no hairball hubs).

**Generalisation.** The requirement is that the graph comes from the catalog, not
from hardcoded knowledge. Tested by building a fake toolkit — the issues/PR tools
with slugs renamed `GITHUB_*` → `ACME_*`, `Issue` → `Ticket`,
`PullRequest` → `Changeset` — and re-running. It discovers 75 `ticket_number` and
72 `changeset_number` edges, with no `GITHUB_` slug leaking through. This is what
caught the ambient-frequency bug above.

## Known limits

- Entity matching is token-level, so sibling entities that share a word can cross
  over: a `comment_id` from an issue comment may be offered to a commit-comment
  tool. Same entity family, wrong member.
- `tokenize` splits on camelCase, so `GitHubApp` becomes `git`/`hub`/`app`.
  Harmless here because matching tolerates partial overlap, but it is imprecise.
- No LLM is used. The rules above are deterministic and reproducible, and every
  edge can be traced to a schema path. An LLM pass would most plausibly help by
  adjudicating the low-confidence band (< 0.7) rather than by proposing edges.

## Running it

```bash
npm install --legacy-peer-deps
node --import tsx src/generate.ts github_catalog.json   # writes dependency_graph.json
npm run selfcheck                                       # shape + provenance report
npm run visualize                                       # writes graph.html
```

`DEBUG_TOOL=<SLUG> node --import tsx src/generate.ts github_catalog.json` dumps
what a single tool needs and gives — the fastest way to see why an edge exists.

## The visualization

`graph.html` is committed and self-contained — open it directly, no server. The
graph data is inlined rather than fetched, because `dependency_graph.json` is
gitignored (a viewer that fetched it would render empty for anyone cloning the
repo) and `file://` pages cannot fetch a sibling JSON anyway.

Nodes are coloured by their role in the chain (entry point / intermediate /
terminal), which is a 3-value encoding that stays colourblind-safe; **service** is
a filter rather than a colour, because ~40 services cannot be encoded in hues
that are reliably distinguishable. Filter by service or by dependency, set a
confidence floor, search, and click any tool to see what must run before it, what
to ask the user for, and what it unlocks. A table view gives the same edges as
text.
