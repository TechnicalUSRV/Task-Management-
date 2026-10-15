// Image files imported by the screens are copied by Vite into /assets and imported as their address.
declare module '*.png' { const src: string; export default src; }

declare module '*.svg' {const src:string;export default src;}

// Build-time settings read by the app (Vite exposes only variables starting with VITE_).
interface ImportMetaEnv { readonly VITE_API_BASE_URL?: string }
interface ImportMeta { readonly env: ImportMetaEnv }
