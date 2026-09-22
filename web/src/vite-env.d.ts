/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 后端地址。不设或为空时使用当前网页的 origin（LAN 代理 / 同源部署）。 */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
