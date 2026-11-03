/**
 * Tests only: drive a client component's handlers without a DOM.
 *
 * `expand(element)` calls each function component with its props and returns the host elements
 * (`<a>`, `<select>`, ...) with their props, so a test can call `onClick` / `onChange` /
 * `onSubmit` itself. Hooks are answered by `forcedHooks(actual)`, which a test file installs with
 * `vi.mock("react", ...)`:
 *   - while expanding: useState / useRef keep their initial values, effects do not run, and
 *     useContext reads the nearest provider above in the tree being expanded;
 *   - always: useTransition answers `forced.pending` and its start function runs the callback
 *     at once (renderToStaticMarkup uses the real hooks otherwise).
 *
 * This module imports nothing from react at runtime, so a mock factory can load it.
 */

export const forced = { pending: false, expanding: false };

export interface Host {
  type: string;
  props: Record<string, unknown>;
  children: Array<Host | string>;
}

const FRAGMENT = Symbol.for("react.fragment");
const CONTEXT = Symbol.for("react.context");
const PROVIDER = Symbol.for("react.provider");
const CONSUMER = Symbol.for("react.consumer");
const MEMO = Symbol.for("react.memo");
const FORWARD_REF = Symbol.for("react.forward_ref");
const SUSPENSE = Symbol.for("react.suspense");

type Ctx = { $$typeof: symbol; _currentValue?: unknown; _context?: Ctx };

const stacks = new Map<unknown, unknown[]>();

function contextValue(ctx: Ctx): unknown {
  const stack = stacks.get(ctx);
  return stack && stack.length > 0 ? stack[stack.length - 1] : ctx._currentValue;
}

function isContext(v: unknown): v is Ctx {
  return typeof v === "object" && v !== null && (v as Ctx).$$typeof === CONTEXT;
}

/** The react module with the hooks answered as described above. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function forcedHooks<T extends Record<string, any>>(actual: T): T {
  const startNow = (fn: () => unknown) => {
    void fn();
  };
  return {
    ...actual,
    useTransition: () => (forced.pending ? [true, startNow] : forced.expanding ? [false, startNow] : actual.useTransition()),
    useState: (init: unknown) => (forced.expanding ? [typeof init === "function" ? (init as () => unknown)() : init, () => {}] : actual.useState(init)),
    useReducer: (r: unknown, init: unknown, f?: (x: unknown) => unknown) => (forced.expanding ? [f ? f(init) : init, () => {}] : actual.useReducer(r, init, f)),
    useRef: (init: unknown) => (forced.expanding ? { current: init } : actual.useRef(init)),
    useEffect: (...a: unknown[]) => (forced.expanding ? undefined : actual.useEffect(...a)),
    useLayoutEffect: (...a: unknown[]) => (forced.expanding ? undefined : actual.useLayoutEffect(...a)),
    useInsertionEffect: (...a: unknown[]) => (forced.expanding ? undefined : actual.useInsertionEffect(...a)),
    useCallback: (fn: unknown, deps: unknown) => (forced.expanding ? fn : actual.useCallback(fn, deps)),
    useMemo: (f: () => unknown, deps: unknown) => (forced.expanding ? f() : actual.useMemo(f, deps)),
    useContext: (ctx: Ctx) => (forced.expanding ? contextValue(ctx) : actual.useContext(ctx)),
    use: (x: unknown) => (forced.expanding && isContext(x) ? contextValue(x) : actual.use(x)),
    useId: () => (forced.expanding ? "id" : actual.useId()),
    useDeferredValue: (v: unknown, i?: unknown) => (forced.expanding ? v : actual.useDeferredValue(v, i)),
    useOptimistic: (s: unknown, r?: unknown) => (forced.expanding ? [s, () => {}] : actual.useOptimistic(s, r)),
  };
}

type El = { type: unknown; props: Record<string, unknown> & { children?: unknown } };

function isElement(n: unknown): n is El {
  return typeof n === "object" && n !== null && "type" in n && "props" in n;
}

function walk(node: unknown): Array<Host | string> {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(walk);
  if (!isElement(node)) {
    if (typeof node === "object" && Symbol.iterator in (node as object)) return [...(node as Iterable<unknown>)].flatMap(walk);
    throw new Error(`expand: cannot expand ${String(node)}`);
  }
  const { type, props } = node;
  if (typeof type === "string") return [{ type, props, children: walk(props.children) }];
  if (type === FRAGMENT || type === SUSPENSE) return walk(props.children);
  if (typeof type === "function") {
    if ((type as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent) throw new Error("expand: class components are not supported");
    const out = (type as (p: unknown) => unknown)(props);
    if (out && typeof (out as Promise<unknown>).then === "function") throw new Error("expand: async components are not supported");
    return walk(out);
  }
  if (typeof type === "object" && type !== null) {
    const t = type as Ctx & { type?: unknown; render?: (p: unknown, r: unknown) => unknown };
    if (t.$$typeof === CONTEXT || t.$$typeof === PROVIDER) {
      const ctx = t.$$typeof === PROVIDER ? (t._context as Ctx) : t;
      const stack = stacks.get(ctx) ?? [];
      stacks.set(ctx, stack);
      stack.push(props.value);
      try {
        return walk(props.children);
      } finally {
        stack.pop();
      }
    }
    if (t.$$typeof === CONSUMER) return walk((props.children as (v: unknown) => unknown)(contextValue(t._context as Ctx)));
    if (t.$$typeof === MEMO) return walk({ type: t.type, props });
    if (t.$$typeof === FORWARD_REF) return walk(t.render?.(props, null));
  }
  throw new Error(`expand: unknown element type ${String(type)}`);
}

/** The host elements `node` renders to, with hooks answered as described at the top. */
export function expand(node: unknown): Array<Host | string> {
  const was = forced.expanding;
  forced.expanding = true;
  try {
    return walk(node);
  } finally {
    forced.expanding = was;
  }
}

export function findHosts(nodes: Array<Host | string>, pred: (h: Host) => boolean): Host[] {
  const out: Host[] = [];
  const visit = (n: Host | string) => {
    if (typeof n === "string") return;
    if (pred(n)) out.push(n);
    n.children.forEach(visit);
  };
  nodes.forEach(visit);
  return out;
}

export function hostText(n: Host | string): string {
  return typeof n === "string" ? n : n.children.map(hostText).join("");
}

/** A stand-in for a DOM event: enough for handlers that read target / currentTarget and prevent the default. */
export function fakeEvent(target: Record<string, unknown> = {}) {
  let prevented = false;
  return {
    target,
    currentTarget: target,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    nativeEvent: {},
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {},
    isDefaultPrevented: () => prevented,
  };
}
