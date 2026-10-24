/**
 * A minimal JSX runtime that renders to an HTML string, for static documents (the report). Text and attribute
 * values are always escaped; only `dangerouslySetInnerHTML` inserts raw markup. Used with
 * `/** @jsxImportSource @/server/report/jsx *\/` so the report needs neither React nor react-dom/server.
 */

/** Markup produced by an element: never escaped again. */
export class Html {
  constructor(readonly html: string) {}
  toString(): string {
    return this.html;
  }
}

type Child = Html | string | number | boolean | null | undefined | Child[];
type Props = Record<string, unknown> & { children?: Child };
type Component = (props: Props) => Html | null;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const ATTR_NAMES: Record<string, string> = { className: "class", htmlFor: "for", charSet: "charset", colSpan: "colspan", rowSpan: "rowspan", httpEquiv: "http-equiv" };

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
}

function renderChildren(children: Child): string {
  if (children === null || children === undefined || typeof children === "boolean") return "";
  if (Array.isArray(children)) return children.map(renderChildren).join("");
  if (children instanceof Html) return children.html;
  return escapeHtml(String(children));
}

function cssProperty(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function attributes(props: Props): string {
  let out = "";
  for (const [key, value] of Object.entries(props)) {
    if (key === "children" || key === "key" || key === "dangerouslySetInnerHTML" || value === null || value === undefined || value === false) continue;
    const name = ATTR_NAMES[key] ?? key;
    if (value === true) {
      out += ` ${name}`;
      continue;
    }
    const text =
      key === "style" && typeof value === "object"
        ? Object.entries(value as Record<string, string | number>)
            .map(([k, v]) => `${cssProperty(k)}:${v}`)
            .join(";")
        : String(value);
    out += ` ${name}="${escapeHtml(text)}"`;
  }
  return out;
}

export function jsx(type: string | Component, props: Props): Html | null {
  if (typeof type === "function") return type(props);
  const inner = props.dangerouslySetInnerHTML as { __html: string } | undefined;
  const open = `<${type}${attributes(props)}`;
  if (VOID.has(type)) return new Html(`${open}/>`);
  return new Html(`${open}>${inner ? inner.__html : renderChildren(props.children)}</${type}>`);
}

export const jsxs = jsx;
export const jsxDEV = jsx;

export function Fragment(props: { children?: Child; key?: string | number }): Html {
  return new Html(renderChildren(props.children));
}

// TypeScript reads the JSX types of a `@jsxImportSource` runtime from a namespace named JSX.
// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace JSX {
  type Element = Html | null;
  interface ElementChildrenAttribute {
    children: unknown;
  }
  interface IntrinsicAttributes {
    key?: string | number;
  }
  interface IntrinsicElements {
    [tag: string]: Record<string, unknown>;
  }
}
