// Image files imported by the screens are copied by Vite into /assets and imported as their address.
declare module '*.png' { const src: string; export default src; }

declare module '*.svg' {const src:string;export default src;}
