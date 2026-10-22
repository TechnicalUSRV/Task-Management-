import "@fontsource-variable/noto-sans-sc/wght.css";
import "@fontsource-variable/noto-sans-khmer/wght.css";
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MiniApp, syncTelegramTheme } from './tg-app';
import './styles/tg.css';

// V5.6.8: apply Telegram's light or dark theme (and header colours) before the first screen is drawn.
syncTelegramTheme();
import "./styles/languages.css";

createRoot(document.getElementById('root')!).render(<React.StrictMode><MiniApp /></React.StrictMode>);
