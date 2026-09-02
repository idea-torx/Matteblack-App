/// <reference types="vite/client" />

declare module "@assets/*" {
  const src: string;
  export default src;
}

interface ImportMetaEnv {
  readonly VITE_FAL_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** package.json version, injected by vite.config.ts at build time. */
declare const __APP_VERSION__: string;
