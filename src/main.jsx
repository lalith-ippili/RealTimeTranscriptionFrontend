import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { API_URL } from './api/client.js';
import './styles.css';

// Open the TLS connection to the API early (saves a round-trip on first request).
try {
  const link = document.createElement('link');
  link.rel = 'preconnect';
  link.href = new URL(API_URL).origin;
  link.crossOrigin = 'anonymous';
  document.head.appendChild(link);
} catch {
  /* invalid API_URL – requests will report it */
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
