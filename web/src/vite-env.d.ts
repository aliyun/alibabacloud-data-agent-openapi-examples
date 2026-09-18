/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 后端地址。不设的话回落 http://127.0.0.1:3000。 */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
