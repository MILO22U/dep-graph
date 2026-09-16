/**
 * Renders the dependency graph as a single self-contained HTML file.
 *
 *   node --import tsx src/visualize.ts [graph.json] [out.html]
 *
 * The data is inlined into the page rather than fetched, for two reasons:
 * `dependency_graph.json` is gitignored (so a viewer that fetched it would render
 * empty for anyone cloning the repo), and a file:// page cannot fetch a sibling
 * JSON without tripping CORS. So graph.html is committed and opens anywhere.
 */
import { readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = resolve(here, "viewer.html");
const PLACEHOLDER = "__GRAPH_DATA__";

const graphPath = process.argv[2] ?? "dependency_graph.json";
const outPath = process.argv[3] ?? "graph.html";

const graph = JSON.parse(readFileSync(graphPath, "utf-8"));
const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
const edges = Array.isArray(graph.edges) ? graph.edges : [];

const template = readFileSync(TEMPLATE, "utf-8");
if (!template.includes(PLACEHOLDER)) {
  throw new Error(`${TEMPLATE} is missing the ${PLACEHOLDER} placeholder`);
}

// Inlined inside a <script type="application/json">, so the only sequence that
// could break out of the element is a literal "</script".
const payload = JSON.stringify({ nodes, edges }).replace(/<\//g, "<\\/");

writeFileSync(outPath, template.replace(PLACEHOLDER, payload), "utf-8");
console.error(`wrote ${outPath} (${nodes.length} nodes, ${edges.length} edges)`);
