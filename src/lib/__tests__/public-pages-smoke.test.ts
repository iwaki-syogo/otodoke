import { describe, expect, it } from "vitest";
import { localBaseUrl } from "../../../scripts/check-public-pages";

describe("public-page HTTP smoke check stays local", () => {
  it.each(["http://localhost:3100", "http://127.0.0.1:3100/", "http://[::1]:3100", "http://localhost"])("accepts the local server form %s", (url) => {
    expect(localBaseUrl(url).pathname).toBe("/");
  });

  it.each([undefined, "https://otodoke.app", "http://localhost.example.test:3100", "http://127.0.0.1:3100/app", "http://localhost:3100/?send=1", "http://localhost:3100/#x", "http://user:pass@localhost:3100", "file:///tmp/help"])("refuses non-local or ambiguous input %s before fetching", (url) => {
    expect(() => localBaseUrl(url)).toThrow();
  });
});
