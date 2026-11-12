import { Children, isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monthParam } from "@/lib/format";
import { LoginForm } from "@/app/login/login-form";
import { MonthPicker } from "@/app/app/month-picker";

vi.mock("@/app/login/login-form", () => ({ LoginForm: () => null }));
vi.mock("@/components/wordmark", () => ({ Wordmark: () => null }));
vi.mock("@/app/app/month-picker", () => ({ MonthPicker: () => null }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/supabase/read-all", () => ({ readAll: async () => [] }));
const LoginPage = (await import("@/app/login/page")).default;
const CalendarPage = (await import("@/app/app/calendar/page")).default;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-15T03:00:00Z"));
});
afterEach(() => vi.useRealTimers());

function propsOf(root: ReactNode, component: unknown): Array<Record<string, unknown>> {
  if (!isValidElement<Record<string, unknown>>(root)) return [];
  return [
    ...(root.type === component ? [root.props] : []),
    ...Children.toArray(root.props.children as ReactNode).flatMap((child) => propsOf(child, component)),
  ];
}
type QueryValue = string | string[] | undefined;

describe("the real login page normalizes duplicate next values before passing a client prop", () => {
  const cases: Array<{ name: string; next: QueryValue; expected: string }> = [
    { name: "two values", next: ["/app/settings/delete", "/app/settings/demo"], expected: "/app" },
    { name: "an empty array", next: [], expected: "/app" },
    { name: "missing", next: undefined, expected: "/app" },
    { name: "an ordinary string", next: "/app/settings?tab=demo#old", expected: "/app/settings?tab=demo#old" },
  ];
  it.each(cases)("handles $name without throwing or passing an array to LoginForm", async ({ next, expected }) => {
    const props = { searchParams: Promise.resolve(next === undefined ? {} : { next }) } as unknown as Parameters<typeof LoginPage>[0];
    const forms = propsOf(await LoginPage(props), LoginForm);
    expect(forms).toHaveLength(1);
    expect(forms[0].next).toBe(expected);
  });
});

const monthCases: Array<{ name: string; m: QueryValue; expected: string }> = [
  { name: "one array value", m: ["2026-12"], expected: "2026-11" },
  { name: "two array values", m: ["2026-12", "2027-01"], expected: "2026-11" },
  { name: "an empty array", m: [], expected: "2026-11" },
  { name: "missing", m: undefined, expected: "2026-11" },
  { name: "an ordinary string", m: "2026-12", expected: "2026-12" },
];

describe("month query validation returns a string before calendar rendering splits it", () => {
  it.each(monthCases)("monthParam rejects non-string $name without RegExp coercion", ({ m, expected }) => {
    expect(monthParam(m as unknown as string, "2026-11-15")).toBe(expected);
  });

  it.each(monthCases)("the real CalendarPage handles $name before ym.split", async ({ m, expected }) => {
    const props = { searchParams: Promise.resolve(m === undefined ? {} : { m }) } as unknown as Parameters<typeof CalendarPage>[0];
    const pickers = propsOf(await CalendarPage(props), MonthPicker);
    expect(pickers).toHaveLength(1);
    expect(pickers[0].value).toBe(expected);
  });
});
