/// <reference types="vite/client" />

declare module "@vitejs/plugin-react" {
  export default function react(): unknown;
}

declare module "vite" {
  export function defineConfig(config: { readonly plugins?: readonly unknown[] }): unknown;
}

declare module "*.css";

declare module "react-dom/client" {
  export function createRoot(container: Element): {
    render(children: unknown): void;
  };
}

declare module "react/jsx-runtime" {
  export const Fragment: symbol;
  export function jsx(type: unknown, props: unknown, key?: unknown): unknown;
  export function jsxs(type: unknown, props: unknown, key?: unknown): unknown;
}

declare namespace JSX {
  type Element = unknown;

  interface IntrinsicElements {
    readonly [elementName: string]: Record<string, unknown>;
  }
}
