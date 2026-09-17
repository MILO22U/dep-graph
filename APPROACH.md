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
a map of file content the caller composes. Neither is a handle to fetch. Excluded
are params declaring an `enum`, params of type `object` or `array`, and **plural
bare nouns** — `files` is typed `string` because Composio flattens the object to
JSON, so only the plural gives it away.

**A bare noun must come from a tool about that noun.** A requirement like
`branch` ("anything identifying a branch") is the loosest kind, so the producer
has to be *about* branches and has to be a retrieval tool. Without the first
half, `content` on `CREATE_A_BLOB` matched a coincidental `Content` entity in
project items; without the second, `assignee` was sourced from
`ADD_ASSIGNEES_TO_AN_ISSUE` — a mutation you would already need the answer to
call.

## Does it work?

Both worked examples from the brief are present:

```
GITHUB_LIST_REPOSITORY_ISSUES --issue_number--> GITHUB_CREATE_AN_ISSUE_COMMENT
GITHUB_LIST_PULL_REQUESTS     --pull_number --> GITHUB_MERGE_A_PULL_REQUEST
```

On `github_catalog.json`: **893 nodes, 1,755 labelled edges**, every node id a
real catalog slug, max 3 producers per requirement (no hairball hubs).

### Measured, not eyeballed

`npm run evaluate` reports three things. The number that matters is the first.

**A hand-labelled sample** (`eval/labels.json`) — 26 edges, 13 judged real and 13
judged spurious, each verdict made by reading both tools' schemas and each
carrying its reason. Current score:

| | |
|---|---|
| precision | **72.2%** (13 of 18 emitted edges are real) |
| recall | **100%** (all 13 real edges found) |
| correctly rejected | 8 of 13 spurious edges |

The first run of this scored **52%**. Eyeballing a sample of edges had made the
graph look fine; measuring it did not. Four rules came directly out of the
failure list, and each is documented at its definition:

1. **No partial entity credit.** A requirement naming two things means both. Half
   credit had offered a runner *label* id for `runner_group_id`, and a custom
   organization *role* name for `custom_property_name`.
2. **No wide-gap abbreviations.** The rule that resolved `repo`→`repository` also
   resolved `code`→`codespace`, sourcing a GitHub App manifest `code` from a
   codespace export.
3. **Slug-subject fallback must be tight.** `GET_A_PACKAGE_VERSION_FOR_THE_AUTHENTICATED_USER`
   has subject `[package, version, authenticated, user]`, so a `username`
   requirement matched on one stray token and took `data.name` — the package
   version's name, not a login.
4. **Plural bare nouns are payloads.** `files` on `CREATE_A_GIST` is typed
   `string` (Composio flattens the object to JSON), so the type check missed it
   and gist file contents were being "fetched" from pull-request file shas.

**Structural checks** — properties that must hold for an agent to use the graph:
every label is genuinely a required input of the consumer, every producer really
exposes a field for it, no producer requires the very thing it supplies, fan-in
bounded. All pass.

**Coverage** — 626 of 893 tools appear in the graph; 88.8% of id-shaped
requirements have at least one producer. The largest remaining gaps are `ref`
(17), `sha` (6) and `thread_id` (6), all cases where no tool returns the value
under a recognisable entity.

### The overfitting trap, which I walked into

Tightening token containment from a 3-character gap to 2 raised sample precision
to 76.5% — and silently deleted **all 57 `hook_id` edges**, because "hook" sits
inside "webhook" with a gap of exactly 3. Sample precision improved while the
graph got worse.

It is reverted, with the reason at the call site. Two things came out of it: 26
labels are far too few to tune against, and `src/catalog.test.ts` now asserts
**coverage floors** per dependency label, so deleting a whole class of real edges
fails the suite loudly instead of looking like progress.

### Generalisation

The requirement is that the graph comes from the catalog, not from hardcoded
knowledge. Two automated tests:

- `src/graph.test.ts` builds a synthetic "acme" toolkit, then renames every slug,
  entity and param (`ACME_`→`WIDGET_`, `Ticket`→`Sprocket`) and asserts the graph
  is isomorphic and leaks no original name.
- `src/catalog.test.ts` does the same to the real catalog (`GITHUB_`→`ACME_`,
  `Issue`→`Ticket`, `PullRequest`→`Changeset`) and asserts the renamed
  dependencies are still discovered.

This is what caught the ambient-param bug: on the narrower renamed catalog,
`ticket_number` crossed the frequency threshold and was misclassified as ambient
context, silently deleting the toolkit's main dependency.

## Known limits

Ranked by how much they would bother me in production.

**1. Cross-scope confusion — the main residual error class.** All five surviving
false positives are of one kind: the entity matches but the *scope* does not.

- a **team** invitation id offered where a **repository** invitation id is wanted
- an **organization** secret name offered where an **environment** secret name is wanted
- a `pull_number` sourced from `LIST_WORKFLOW_RUNS_FOR_A_REPOSITORY`, which does
  embed `pull_requests[].number` but only for PR-triggered runs

No token-level rule separates these from the true positives. `LIST_REPOSITORY_ISSUES`
→ `CREATE_AN_ISSUE_COMMENT` has exactly the same shape — producer subject carries
a qualifier the consumer lacks — and it is correct. Telling them apart requires
knowing that a team invitation and a repository invitation are different kinds of
thing, which is semantic knowledge, not structure. **This is the one place a
language model would genuinely earn its cost**: adjudicating a few hundred
candidate edges where entity matches but scope differs. It is not wired up
(see below), and I would not ship it without measuring it against this labelled
set first.

**2. The semantic layer is built but not populated.** `src/adjudicate.ts` asks a
model to NAME what each identifier refers to (`team_invitation` vs
`repository_invitation`), caches the answers to `eval/kinds.json`, and
`buildGraph` drops edges whose two sides name conflicting kinds via
`kindsCompatible`. The split is deliberate: the model only does the part that
needs world knowledge, and the deciding is ordinary testable code. Caching to a
committed file keeps the generator deterministic and key-free, so a grader
reproduces the identical graph.

It never ran. The assessment's API window closed before the pass completed --
every batch came back `403 assessment_not_active` -- so no `eval/kinds.json`
exists and the generator reports "no semantic layer" and runs on structure
alone. That degradation is by design, not a patch after the fact: the `kinds`
option is optional throughout and `kindsCompatible` treats an unlabelled side as
compatible. The honest status is that the mechanism is written, reviewable and
wired in, and its effect on precision is unmeasured. I would not claim a number
for it without running the eval.

**3. Recall cost of dropping abbreviations.** `repo`→`repository` and
`org`→`organization` no longer resolve. Harmless here because both are ambient
context reported as `requires_from_user` rather than linked, but on a toolkit
where an abbreviated noun is a real handle this would lose edges.

**4. Token-level entity matching.** Sibling entities sharing a word can still
cross over — a `comment_id` from an issue comment may be offered to a
commit-comment tool. Same entity family, wrong member.

**5. `tokenize` splits acronyms.** `GitHubApp` becomes `git`/`hub`/`app`.
Harmless, because matching only requires every *requirement* token to be
accounted for, but imprecise.

**6. The labelled set is small and mine.** 26 edges, judged by one person from
schemas rather than from running the API. It is enough to catch a systematic
error class, not enough to certify a precision figure.

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
