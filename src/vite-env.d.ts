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
