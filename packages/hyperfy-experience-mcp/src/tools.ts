import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { v4 as uuidv4 } from "uuid";

type JsonObject = Record<string, unknown>;

const DEFAULT_HYPERFY_REPO =
  "/Users/riccardoesclapon/Documents/github/knowledgeflow_hyperfy";

function hyperfyRepo(): string {
  return process.env.HYPERFY_REPO || DEFAULT_HYPERFY_REPO;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stableStationId(title: string): string {
  return slugify(title).replace(/-/g, "_");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath: string): Promise<JsonObject> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as JsonObject;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function roomPlan(args: JsonObject): JsonObject {
  const objective = asString(args.objective, "Create a RickyData Hyperfy room.");
  const theme = asString(args.theme, "photorealistic collaborative AI office");
  const targetAgents = asStringArray(args.target_agent_ids);
  const stationCount = Math.max(3, Math.min(8, asNumber(args.station_count, 5)));
  const slug = slugify(asString(args.slug, objective)) || `experience-${Date.now()}`;

  const baseStations = [
    {
      title: "Briefing Desk",
      purpose: "Clarify the task, user objective, data sources, constraints, and success proof.",
      agentId: targetAgents[0] || "hyperfy-experience-builder",
      suggestedAsset: "concierge workstation with large planning monitor",
    },
    {
      title: "Asset Studio",
      purpose: "Generate, compare, and approve Meshy/Gemini assets for the room.",
      agentId: targetAgents[1] || "hyperfy-experience-builder",
      suggestedAsset: "asset review table with turntable display",
    },
    {
      title: "Data Console",
      purpose: "Query KFDB, benchmark data, notes, and deterministic graph records.",
      agentId: targetAgents[2] || "rickydatascience-copilot",
      suggestedAsset: "analytics console with graph wall and notebook surface",
    },
    {
      title: "Build Console",
      purpose: "Assemble app scripts, manifests, asset references, and CI deployment intent.",
      agentId: targetAgents[3] || "hyperfy-experience-builder",
      suggestedAsset: "engineering console with repository status screens",
    },
    {
      title: "Proof Wall",
      purpose: "Show browser screenshots, production checks, deploy status, and signed evidence.",
      agentId: targetAgents[4] || "erc8004-expert",
      suggestedAsset: "evidence wall with live verification panels",
    },
  ].slice(0, stationCount);

  return {
    slug,
    title: asString(args.title, slug.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ")),
    objective,
    theme,
    layout: {
      shape: "rectangular office suite",
      zones: ["entry briefing", "asset studio", "data wall", "build console", "proof gallery"],
      navigation: "single loop path with clear walk-up station prompts",
    },
    stations: baseStations.map((station, index) => ({
      id: stableStationId(station.title),
      order: index + 1,
      ...station,
      interaction: "walk_up_action_and_overlay",
    })),
    assetPrompts: baseStations.map((station) => ({
      name: station.title,
      prompt: `${theme}, ${station.suggestedAsset}, ${station.purpose}, game ready, realistic PBR materials, no people`,
      category: "furniture",
      tags: ["hyperfy", "rickydata", "agent-office", slug, stableStationId(station.title)],
    })),
    registryRecord: {
      id: uuidv4(),
      type: "HyperfyExperience",
      slug,
      title: asString(args.title, slug),
      status: "draft",
      source: "hyperfy-experience-mcp",
      createdAt: new Date().toISOString(),
    },
  };
}

export const TOOLS: Tool[] = [
  {
    name: "plan_experience_room",
    description: "Create a structured room-scale Hyperfy experience plan with walk-up stations, asset prompts, and a registry record.",
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string", description: "The user-facing goal for the Hyperfy room." },
        theme: { type: "string", description: "Visual style and spatial theme." },
        title: { type: "string", description: "Optional display title." },
        slug: { type: "string", description: "Optional stable app slug." },
        station_count: { type: "number", description: "Number of station specs to include, 3-8." },
        target_agent_ids: { type: "array", items: { type: "string" }, description: "RickyData agent IDs to assign to stations." },
      },
      required: ["objective"],
    },
  },
  {
    name: "create_agent_station_spec",
    description: "Create one walk-up Hyperfy station spec for a RickyData agent, including action text, overlay mode, and asset prompt.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        agent_id: { type: "string" },
        purpose: { type: "string" },
        interaction: { type: "string" },
        visual_prompt: { type: "string" },
      },
      required: ["title", "agent_id", "purpose"],
    },
  },
  {
    name: "list_hyperfy_assets",
    description: "Search the local Hyperfy asset library index. Requires HYPERFY_REPO when not using the default local path.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        category: { type: "string" },
        limit: { type: "number" },
      },
      required: [],
    },
  },
  {
    name: "generate_meshy_asset",
    description: "Generate and register a Meshy Text-to-3D asset through the Hyperfy repo generation script. Requires local HYPERFY_REPO and Meshy env key.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        name: { type: "string" },
        category: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        refine: { type: "boolean", description: "When false, pass --no-refine for fast preview validation." },
        timeout_ms: { type: "number" },
      },
      required: ["prompt", "name"],
    },
  },
  {
    name: "create_hyperfy_app_record",
    description: "Create a portable Hyperfy application/experience registry record and optionally write it into the Hyperfy repo artifacts folder.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        app_name: { type: "string" },
        agent_ids: { type: "array", items: { type: "string" } },
        asset_ids: { type: "array", items: { type: "string" } },
        stations: { type: "array", items: { type: "object" } },
        write_local: { type: "boolean" },
      },
      required: ["slug", "title"],
    },
  },
  {
    name: "publish_experience_to_kfdb",
    description: "Prepare or submit a KFDB write payload for a public HyperfyExperience record. Defaults to dry run unless publish=true.",
    inputSchema: {
      type: "object",
      properties: {
        record: { type: "object" },
        publish: { type: "boolean" },
      },
      required: ["record"],
    },
  },
];

export async function handleToolCall(name: string, args: JsonObject): Promise<unknown> {
  if (name === "plan_experience_room") return roomPlan(args);

  if (name === "create_agent_station_spec") {
    const title = asString(args.title);
    const agentId = asString(args.agent_id);
    const purpose = asString(args.purpose);
    return {
      id: stableStationId(title),
      title,
      agentId,
      purpose,
      actionLabel: `Open: ${title}`,
      overlayMode: asString(args.interaction, "chat_and_task_console"),
      visualPrompt: asString(
        args.visual_prompt,
        `photorealistic Hyperfy walk-up station for ${title}, ${purpose}, clean readable display, realistic PBR materials, no people`,
      ),
      proof: ["station visible in browser", "E prompt appears", "agent chat succeeds"],
    };
  }

  if (name === "list_hyperfy_assets") {
    const indexPath = path.join(hyperfyRepo(), "assets/library/index.json");
    if (!(await pathExists(indexPath))) {
      return { success: false, error: `Asset index not found: ${indexPath}` };
    }
    const index = await readJson(indexPath);
    const query = asString(args.query).toLowerCase();
    const category = asString(args.category);
    const limit = Math.max(1, Math.min(100, asNumber(args.limit, 20)));
    const assets = Array.isArray(index.assets) ? (index.assets as JsonObject[]) : [];
    const results = assets
      .filter((asset) => !category || asset.category === category)
      .filter((asset) => {
        if (!query) return true;
        const text = JSON.stringify(asset).toLowerCase();
        return text.includes(query);
      })
      .slice(0, limit)
      .map((asset) => ({
        id: asset.id,
        name: asset.name,
        category: asset.category,
        tags: asset.tags,
        modelPath: asset.modelPath,
      }));
    return { success: true, count: results.length, results };
  }

  if (name === "generate_meshy_asset") {
    const repo = hyperfyRepo();
    const scriptPath = path.join(repo, "scripts/generation/meshy-text-to-3d.mjs");
    if (!(await pathExists(scriptPath))) {
      return { success: false, error: `Meshy script not found: ${scriptPath}` };
    }
    const prompt = asString(args.prompt);
    const assetName = asString(args.name);
    const category = asString(args.category, "props");
    const tags = asStringArray(args.tags).join(",");
    const timeoutMs = Math.max(30000, asNumber(args.timeout_ms, 900000));
    const commandArgs = [
      scriptPath,
      prompt,
      "--name",
      assetName,
      "--category",
      category,
      "--timeout-ms",
      String(timeoutMs),
    ];
    if (tags) commandArgs.push("--tags", tags);
    if (args.refine === false) commandArgs.push("--no-refine");
    const result = await runCommand(process.execPath, commandArgs, {
      cwd: repo,
      timeoutMs: timeoutMs + 5000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    const idMatch = output.match(/Registered asset:\s+([a-zA-Z0-9_-]+)/);
    const pathMatch = output.match(/Generated GLB:\s+(.+)/);
    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      assetId: idMatch?.[1] || null,
      modelPath: pathMatch?.[1]?.trim() || null,
      stdoutTail: result.stdout.slice(-2000),
      stderrTail: result.stderr.slice(-2000),
    };
  }

  if (name === "create_hyperfy_app_record") {
    const slug = slugify(asString(args.slug));
    const record = {
      id: `hyperfy-experience:${slug}`,
      type: "HyperfyExperience",
      slug,
      title: asString(args.title),
      description: asString(args.description),
      appName: asString(args.app_name, slug),
      agentIds: asStringArray(args.agent_ids),
      assetIds: asStringArray(args.asset_ids),
      stations: Array.isArray(args.stations) ? args.stations : [],
      visibility: "public",
      status: "draft",
      source: "hyperfy-experience-mcp",
      updatedAt: new Date().toISOString(),
    };
    if (args.write_local === true) {
      const outputPath = path.join(
        hyperfyRepo(),
        "artifacts/hyperfy-experience-mcp",
        `${slug}.json`,
      );
      await writeJson(outputPath, record);
      return { success: true, record, outputPath };
    }
    return { success: true, record };
  }

  if (name === "publish_experience_to_kfdb") {
    const record = args.record as JsonObject;
    const payload = {
      operations: [
        {
          operation: "upsert_node",
          label: "HyperfyExperience",
          id: asString(record.id, `hyperfy-experience:${asString(record.slug, uuidv4())}`),
          properties: Object.fromEntries(
            Object.entries(record).map(([key, value]) => [
              key,
              typeof value === "number"
                ? { Double: value }
                : typeof value === "boolean"
                  ? { Boolean: value }
                  : { String: typeof value === "string" ? value : JSON.stringify(value) },
            ]),
          ),
        },
      ],
    };
    if (args.publish !== true) {
      return { success: true, dryRun: true, payload };
    }
    const apiUrl = process.env.KFDB_API_URL;
    const apiKey = process.env.KFDB_API_KEY;
    if (!apiUrl || !apiKey) {
      return { success: false, error: "KFDB_API_URL and KFDB_API_KEY are required to publish", payload };
    }
    const response = await fetch(`${apiUrl.replace(/\/$/, "")}/api/v1/write`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    return { success: response.ok, status: response.status, response: text.slice(0, 4000), payload };
  }

  return { success: false, error: `Unknown tool: ${name}` };
}
