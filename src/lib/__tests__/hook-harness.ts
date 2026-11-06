/**
 * Tests only: mount one client component and keep its hooks between renders, without a DOM.
 *
 * element-tree.ts answers hooks with their first values and never runs effects. This harness
 * keeps state, refs and effects from render to render, so a test can follow a component through
 * time: a press, a token arriving, a send finishing, an unmount.
 *
 * A test file installs `harnessHooks(actual)` with `vi.mock("react", ...)`. Only while a component
 * mounted here renders are useState / useRef / useEffect / useLayoutEffect / useCallback /
 * useMemo answered by the harness; anywhere else the real hooks run (renderToStaticMarkup keeps
 * working in the same file).
 *
 * - A state update renders again on the next microtask (as React batches outside its own events).
 * - After each render, the effects whose deps changed run, each after its previous cleanup.
 * - An object `ref` on a host element gets a stand-in node from `node(type)` on the first render
 *   and keeps it; the element's `data-*` props are copied into `node.dataset` after every render
 *   (as React would set the attributes). unmount() sets those refs back to null, then runs every
 *   effect cleanup (React detaches refs before passive cleanups run).
 * - The component must render host elements only (no child components).
 *
 * This module imports nothing from react at runtime, so a mock factory can load it.
 */
import { expand, findHosts, hostText, type Host } from "./element-tree";

type Cleanup = void | (() => void);
type Cell = { value?: unknown; set?: (next: unknown) => void; ready?: boolean; deps?: readonly unknown[]; cleanup?: Cleanup };

interface Instance {
  cells: Cell[];
  next: number;
  effects: Array<[Cell, () => Cleanup]>;
  mounted: boolean;
  scheduled: boolean;
  render: () => void;
}

let rendering: Instance | null = null;

function nextCell(inst: Instance): Cell {
  const i = inst.next++;
  inst.cells[i] ??= {};
  return inst.cells[i];
}

function depsChanged(prev: readonly unknown[] | undefined, deps: readonly unknown[] | undefined): boolean {
  return !prev || !deps || prev.length !== deps.length || prev.some((v, i) => !Object.is(v, deps[i]));
}

function schedule(inst: Instance) {
  if (inst.scheduled || !inst.mounted) return;
  inst.scheduled = true;
  queueMicrotask(() => {
    inst.scheduled = false;
    if (inst.mounted) inst.render();
  });
}

/** The react module, with the hooks of a mounted component answered as described above. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function harnessHooks<T extends Record<string, any>>(actual: T): T {
  const effectHook =
    (real: (fn: () => Cleanup, deps?: readonly unknown[]) => void) =>
    (fn: () => Cleanup, deps?: readonly unknown[]) => {
      const inst = rendering;
      if (!inst) return real(fn, deps);
      const cell = nextCell(inst);
      if (depsChanged(cell.deps, deps)) {
        cell.deps = deps;
        inst.effects.push([cell, fn]);
      }
    };
  return {
    ...actual,
    useState: (init: unknown) => {
      const inst = rendering;
      if (!inst) return actual.useState(init);
      const cell = nextCell(inst);
      if (!cell.ready) {
        cell.ready = true;
        cell.value = typeof init === "function" ? (init as () => unknown)() : init;
        cell.set = (next: unknown) => {
          const value = typeof next === "function" ? (next as (v: unknown) => unknown)(cell.value) : next;
          if (Object.is(value, cell.value)) return;
          cell.value = value;
          schedule(inst);
        };
      }
      return [cell.value, cell.set];
    },
    useRef: (init: unknown) => {
      const inst = rendering;
      if (!inst) return actual.useRef(init);
      const cell = nextCell(inst);
      if (!cell.ready) {
        cell.ready = true;
        cell.value = { current: init };
      }
      return cell.value;
    },
    useEffect: effectHook(actual.useEffect),
    useLayoutEffect: effectHook(actual.useLayoutEffect),
    useCallback: (fn: unknown, deps?: readonly unknown[]) => {
      const inst = rendering;
      if (!inst) return actual.useCallback(fn, deps);
      const cell = nextCell(inst);
      if (depsChanged(cell.deps, deps)) {
        cell.deps = deps;
        cell.value = fn;
      }
      return cell.value;
    },
    useMemo: (factory: () => unknown, deps?: readonly unknown[]) => {
      const inst = rendering;
      if (!inst) return actual.useMemo(factory, deps);
      const cell = nextCell(inst);
      if (depsChanged(cell.deps, deps)) {
        cell.deps = deps;
        cell.value = factory();
      }
      return cell.value;
    },
  };
}

export interface Mounted {
  /** The host elements of the latest render. */
  readonly tree: Array<Host | string>;
  /** Every host element of the latest render that matches. */
  hosts(pred: (h: Host) => boolean): Host[];
  /** The one host element that matches (throws unless there is exactly one). */
  host(pred: (h: Host) => boolean): Host;
  /** The text of the latest render. */
  text(): string;
  /** The stand-in node behind a host element's ref. */
  nodeOf<N = Record<string, unknown>>(h: Host): N;
  /** Render again now (e.g. after changing what a mocked hook answers). */
  rerender(): void;
  unmount(): void;
}

/** A stand-in node for a host element's ref: a plain object with a dataset. */
export type NodeFactory = (type: string) => Record<string, unknown> & { dataset?: Record<string, string> };

export function mount(component: () => unknown, node: NodeFactory = () => ({ dataset: {} })): Mounted {
  let output: unknown = null;
  const refs = new Set<{ current: unknown }>();

  const attachRefs = () => {
    for (const h of findHosts(expand(output), () => true)) {
      const ref = h.props.ref as { current: unknown } | undefined;
      if (!ref || typeof ref !== "object") continue;
      ref.current ??= node(h.type);
      refs.add(ref);
      const dataset = (ref.current as { dataset?: Record<string, string> }).dataset;
      if (!dataset) continue;
      for (const [key, value] of Object.entries(h.props)) {
        if (!key.startsWith("data-")) continue;
        const name = key.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        if (value === undefined || value === null || value === false) delete dataset[name];
        else dataset[name] = value === true ? "" : String(value);
      }
    }
  };

  const inst: Instance = {
    cells: [],
    next: 0,
    effects: [],
    mounted: true,
    scheduled: false,
    render: () => {
      inst.next = 0;
      inst.effects = [];
      rendering = inst;
      try {
        output = component();
      } finally {
        rendering = null;
      }
      attachRefs();
      for (const [cell, fn] of inst.effects) {
        if (typeof cell.cleanup === "function") cell.cleanup();
        cell.cleanup = fn();
      }
    },
  };
  inst.render();

  const hosts = (pred: (h: Host) => boolean) => findHosts(expand(output), pred);
  return {
    get tree() {
      return expand(output);
    },
    hosts,
    host(pred) {
      const found = hosts(pred);
      if (found.length !== 1) throw new Error(`expected one matching element, found ${found.length}`);
      return found[0];
    },
    text: () => expand(output).map(hostText).join(""),
    nodeOf<N>(h: Host): N {
      const ref = h.props.ref as { current: unknown } | undefined;
      if (!ref?.current) throw new Error(`<${h.type}> has no ref node`);
      return ref.current as N;
    },
    rerender: () => {
      if (inst.mounted) inst.render();
    },
    unmount: () => {
      inst.mounted = false;
      for (const ref of refs) ref.current = null;
      for (const cell of inst.cells) if (cell && typeof cell.cleanup === "function") cell.cleanup();
    },
  };
}
