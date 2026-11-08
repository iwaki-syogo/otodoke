import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The contract between the Web's /api/demo/* (src/app/api/demo/**, docs/api/demo.md) and the iOS client
 * (ios/Otodoke/Data/DemoClient.swift): the same result codes, the same two paths, the confirmation word, and a load
 * that waits longer than the server runs. A file that cannot be read, or a list that comes out empty, is a failure.
 */
const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => (existsSync(path.join(ROOT, p)) ? readFileSync(path.join(ROOT, p), "utf8") : "");

const HANDLER = read("src/app/api/demo/handler.ts");
const DOC = read("docs/api/demo.md");
const LOAD_ROUTE = read("src/app/api/demo/load/route.ts");

/** The codes the Web's handler can answer. */
function webCodes(src: string): string[] {
  const union = src.match(/export type DemoApiCode = ([^;]+);/)?.[1] ?? "";
  return [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
}

/** The codes of docs/api/demo.md's table. */
function docCodes(src: string): string[] {
  return [...src.matchAll(/^\| \d{3} \| `([a-z_]+)` \|/gm)].map((m) => m[1]).sort();
}

/** The codes the iOS client reads (`case x = "code"` or a bare case of DemoCode). */
function iosCodes(src: string): string[] {
  const body = src.match(/enum DemoCode: String[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  const out: string[] = [];
  for (const m of body.matchAll(/^\s*case (\w+)(?: = "([a-z_]+)")?\s*$/gm)) out.push(m[2] ?? m[1]);
  return out.sort();
}

/** The endpoint names the iOS client posts to. */
function iosEndpoints(src: string): string[] {
  return [...src.matchAll(/post\("([a-z]+)"/g)].map((m) => m[1]).sort();
}

function webEndpoints(): string[] {
  const dir = path.join(ROOT, "src/app/api/demo");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(dir, e.name, "route.ts")))
    .map((e) => e.name)
    .sort();
}

describe("the iOS sample client and the Web's /api/demo/*", () => {
  const CLIENT = read("ios/Otodoke/Data/DemoClient.swift");

  it("knows exactly the codes the Web answers (handler, document and client agree)", () => {
    const web = webCodes(HANDLER);
    expect(web.length).toBeGreaterThan(0);
    expect(docCodes(DOC)).toEqual(web);
    expect(iosCodes(CLIENT)).toEqual(web);
  });

  it("posts to the two paths the Web serves, with the Web's path prefix", () => {
    expect(webEndpoints()).toEqual(["clear", "load"]);
    expect(iosEndpoints(CLIENT)).toEqual(webEndpoints());
    expect(CLIENT).toContain('"api/demo/\\(endpoint)"');
    expect(CLIENT).toContain('httpMethod = "POST"');
    expect(CLIENT).toContain('"Bearer \\(accessToken)"');
  });

  it("sends the Web's confirmation word to clear and nothing to load", () => {
    expect(HANDLER).toMatch(/parsed\.data\.confirm !== "yes"/);
    expect(CLIENT).toContain('post("clear", ["confirm": "yes"]');
    expect(CLIENT).toContain('post("load", [:]');
  });

  it("reads the load's answer as the Web writes it: processed and busy", () => {
    expect(HANDLER).toMatch(/\{ ok: true, processed: loaded\.processed, busy: loaded\.busy \}/);
    expect(CLIENT).toContain('answer["processed"]');
    expect(CLIENT).toContain('answer["busy"]');
  });

  it("the load waits longer than the 300 seconds the server may run, and shorter than a stuck wait", () => {
    expect(LOAD_ROUTE).toMatch(/maxDuration = 300/);
    const wait = Number(CLIENT.match(/static let loadTimeout: TimeInterval = (\d+)/)?.[1]);
    expect(wait).toBeGreaterThan(300);
    expect(wait).toBeLessThanOrEqual(330);
    expect(CLIENT).toContain("request.timeoutInterval = timeout");
  });

  it("negative control: a code only one side has, a renamed path or a short wait is caught", () => {
    const web = webCodes(HANDLER);
    expect(iosCodes(CLIENT.replace('case unavailable\n', "case unavailable\n    case surprise\n"))).not.toEqual(web);
    expect(iosCodes(CLIENT.replace('case unavailable\n', ""))).not.toEqual(web);
    expect(webCodes(HANDLER.replace('| "unavailable"', '| "unavailable" | "extra"'))).not.toEqual(iosCodes(CLIENT));
    expect(iosEndpoints(CLIENT.replace('post("clear"', 'post("wipe"'))).not.toEqual(webEndpoints());
    expect(Number(CLIENT.replace("loadTimeout: TimeInterval = 310", "loadTimeout: TimeInterval = 60").match(/loadTimeout: TimeInterval = (\d+)/)?.[1])).toBeLessThanOrEqual(300);
    expect(webCodes("")).toEqual([]);
    expect(iosCodes("")).toEqual([]);
  });
});
