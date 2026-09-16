/**
 * Generator entrypoint.
 *
 *   node --import tsx src/generate.ts path/to/catalog.json
 *
 * The catalog path is the LAST cli argument (the grader appends it to whatever
 * run command `generator.json` declares). Writes `dependency_graph.json` to the
 * working directory. All inference lives in ./infer.ts.
 *
 * DEBUG_TOOL=<SLUG> dumps what one tool needs and gives, then exits -- the
 * fastest way to see why a given edge does or does not exist.
 */
import { readFileSync, writeFileSync } from "fs";
import {
  buildGraph,
  gives,
  needs,
  serviceOf,
  slugOf,
  ROLE_WORDS,
  type Tool,
} from "./infer.ts";

const CATALOG_PATH = process.argv.length > 2 ? process.argv[process.argv.length - 1] : undefined;
const OUT_PATH = "dependency_graph.json";

function loadCatalog(): Tool[] {
  if (!CATALOG_PATH) {
    throw new Error("pass the toolkit catalog path as the last argument");
  }
  const data = JSON.parse(readFileSync(CATALOG_PATH, "utf-8"));
  return Array.isArray(data) ? data : (data.tools ?? data.items ?? []);
}

function debugOne(tools: Tool[], slug: string) {
  const tool = tools.find((t) => String(slugOf(t)).toUpperCase() === slug.toUpperCase());
  if (!tool) {
    console.error("no tool named " + slug);
    process.exit(1);
  }
  console.log("=== " + slugOf(tool) + "   service=" + serviceOf(tool));
  console.log("\nNEEDS:");
  for (const r of needs(tool)) {
    console.log(
      "  " + r.param.padEnd(22) +
      " entity=[" + r.entity.join(",") + "] role=" + r.role + " type=" + (r.type ?? "?"),
    );
  }
  const g = gives(tool);
  const idish = g.filter((p) => ROLE_WORDS.includes(p.field) || /_id$|_number$/.test(p.field));
  console.log("\nGIVES: " + g.length + " leaf fields, " + idish.length + " identifier-ish. First 25:");
  for (const p of idish.slice(0, 25)) {
    console.log(
      "  entity=[" + p.entity.join(",") + "] field=" + p.field.padEnd(12) +
      " type=" + (p.type ?? "?") + "  <- " + p.path,
    );
  }
}

async function main() {
  const tools = loadCatalog();
  if (process.env.DEBUG_TOOL) return debugOne(tools, process.env.DEBUG_TOOL);
  const graph = await buildGraph(tools);
  writeFileSync(OUT_PATH, JSON.stringify(graph, null, 2), "utf-8");
  console.error("wrote " + graph.nodes.length + " nodes, " + graph.edges.length + " edges to " + OUT_PATH);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
