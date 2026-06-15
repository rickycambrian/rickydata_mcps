import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  RPC_REGISTRY,
  capturedActions,
  isCaptured,
  findAudioUrl,
  getSpec,
} from "../src/notebooklm/rpc.js";
import { encodeFReq } from "../src/notebooklm/client.js";
import { extractRpcPayload } from "../src/notebooklm/parse.js";
import { NotCapturedError, NotebookLMError } from "../src/notebooklm/errors.js";

const FIX = join(fileURLToPath(new URL(".", import.meta.url)), "..", "fixtures");
const fx = (name: string) => readFileSync(join(FIX, name), "utf8");

const VERIFIED = ["add_source", "generate_audio", "get_audio_status", "download_audio"];

describe("RPC registry capture state", () => {
  it("the captured set is exactly the 4 verified actions", () => {
    expect(capturedActions().sort()).toEqual([...VERIFIED].sort());
    for (const a of VERIFIED) expect(isCaptured(a)).toBe(true);
  });

  it("verified rpcids match the live capture", () => {
    expect(getSpec("add_source")!.rpcid).toBe("izAoDd");
    expect(getSpec("generate_audio")!.rpcid).toBe("R7cb6c");
    expect(getSpec("get_audio_status")!.rpcid).toBe("gArtLc");
    expect(getSpec("download_audio")!.rpcid).toBe("HpN0Ub");
  });

  it("uncaptured actions are TODO_CAPTURE and throw on encode", () => {
    for (const a of ["create_notebook", "list_notebooks", "ask_question"]) {
      expect(isCaptured(a)).toBe(false);
      expect(() => RPC_REGISTRY[a].encode({})).toThrow(NotCapturedError);
    }
  });
});

// Byte-equality: encode(args) must reproduce the captured request fixture's
// inner payload (ids substituted for the placeholders the fixture uses).
describe("encode → captured request fixture (byte-equal inner payload)", () => {
  const NB = "nb-EXAMPLE";
  const SRC = "src-EXAMPLE";

  it("add_source(text) matches izAoDd.request.txt", () => {
    const captured = JSON.parse(fx("izAoDd.request.txt"));
    const built = getSpec("add_source")!.encode({
      notebook_id: NB,
      type: "text",
      content: "<SOURCE TEXT>",
      title: "Pasted Text",
    });
    expect(built).toEqual(captured);
  });

  it("generate_audio matches R7cb6c.request.txt", () => {
    const captured = JSON.parse(fx("R7cb6c.request.txt"));
    const built = getSpec("generate_audio")!.encode({ notebook_id: NB, source_ids: [SRC] });
    expect(built).toEqual(captured);
  });

  it("get_audio_status matches gArtLc.request.txt", () => {
    const captured = JSON.parse(fx("gArtLc.request.txt"));
    const built = getSpec("get_audio_status")!.encode({ notebook_id: NB });
    expect(built).toEqual(captured);
  });

  it("download_audio matches HpN0Ub.request.txt (artifact-id authorize)", () => {
    const captured = JSON.parse(fx("HpN0Ub.request.txt"));
    const built = getSpec("download_audio")!.encode({ artifact_id: "art-EXAMPLE" });
    expect(built).toEqual(captured);
  });

  it("the f.req envelope wraps the captured payload correctly", () => {
    const payload = getSpec("get_audio_status")!.encode({ notebook_id: NB });
    const fReq = encodeFReq("gArtLc", payload);
    const parsed = JSON.parse(fReq);
    expect(parsed[0][0][0]).toBe("gArtLc");
    expect(JSON.parse(parsed[0][0][1])).toEqual(payload);
  });
});

// decode(parse(response fixture)) → typed result.
describe("decode ← captured response fixture", () => {
  function decodeFixture(rpcid: string, action: string) {
    const data = extractRpcPayload(fx(`${rpcid}.response.txt`), rpcid, action, "bl");
    return getSpec(action)!.decode(data);
  }

  it("add_source returns the new source id + title", () => {
    expect(decodeFixture("izAoDd", "add_source")).toEqual({
      source_id: "src-EXAMPLE",
      title: "Payload Architecture for Batch Source Capture",
    });
  });

  it("generate_audio returns the artifact id + status", () => {
    const r = decodeFixture("R7cb6c", "generate_audio") as Record<string, unknown>;
    expect(r.artifact_id).toBe("art-EXAMPLE");
    expect(r.status_code).toBe(1);
  });

  it("get_audio_status returns the artifact list", () => {
    const r = decodeFixture("gArtLc", "get_audio_status") as { artifacts: unknown[]; count: number };
    expect(r.count).toBe(1);
    expect((r.artifacts[0] as Record<string, unknown>).artifact_id).toBe("art-EXAMPLE");
  });
});

describe("download_audio codec (authorize RPC)", () => {
  it("requires artifact_id and encodes [PREAMBLE, null, [artifactId]]", () => {
    const spec = getSpec("download_audio")!;
    expect(() => spec.encode({ notebook_id: "nb-1" })).toThrow(NotebookLMError);
    const built = spec.encode({ artifact_id: "art-1" }) as unknown[];
    expect(built[1]).toBeNull();
    expect(built[2]).toEqual(["art-1"]);
  });
  it("decodes the empty authorize frame to authorized + guidance note", () => {
    const data = extractRpcPayload(fx("HpN0Ub.response.txt"), "HpN0Ub", "download_audio", "bl");
    const r = getSpec("download_audio")!.decode(data) as Record<string, unknown>;
    expect(r.authorized).toBe(true);
    expect(r.url).toBeNull();
    expect(String(r.note)).toMatch(/browser download navigation|Playwright/i);
  });
  it("surfaces a URL if a future build returns one inline", () => {
    const r = getSpec("download_audio")!.decode([["https://x.googleusercontent.com/y.m4a"]]) as Record<string, unknown>;
    expect(r.url).toBe("https://x.googleusercontent.com/y.m4a");
  });
});

describe("encode arg validation", () => {
  it("add_source rejects a missing notebook_id", () => {
    expect(() => getSpec("add_source")!.encode({ type: "text", content: "x" })).toThrow(NotebookLMError);
  });
  it("add_source(url) is not captured yet", () => {
    expect(() => getSpec("add_source")!.encode({ notebook_id: "n", type: "url", content: "https://x" })).toThrow(
      NotCapturedError,
    );
  });
  it("generate_audio requires source_ids", () => {
    expect(() => getSpec("generate_audio")!.encode({ notebook_id: "n" })).toThrow(NotebookLMError);
  });
});

describe("findAudioUrl", () => {
  it("finds an audio URL anywhere in the tree", () => {
    expect(findAudioUrl(["a", ["b", "https://x.googleusercontent.com/y.m4a"]])).toBe(
      "https://x.googleusercontent.com/y.m4a",
    );
  });
  it("ignores non-audio URLs and null trees", () => {
    expect(findAudioUrl(["https://example.com/page.html"])).toBeNull();
    expect(findAudioUrl([1, 2, [3, null]])).toBeNull();
  });
});
