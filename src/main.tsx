import { Buffer } from 'buffer';
(window as any).Buffer = Buffer;

import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  document.body.innerHTML = '<div style="color:red;padding:2rem;font-family:sans-serif">Fatal: #root element not found</div>';
} else {
  try {
    createRoot(rootEl).render(<App />);
  } catch (e) {
    rootEl.innerHTML = `<div style="color:red;padding:2rem;font-family:sans-serif;white-space:pre-wrap">
      <h2>App failed to start</h2>
      <p>${String(e)}</p>
    </div>`;
  }
}
