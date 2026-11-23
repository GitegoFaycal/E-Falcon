import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { ToastProvider } from './context/store.jsx';
import { startDataSource } from './services/api.js';
import './index.css';

// Live mode: resume the sign-in and connect. Demo mode: start the in-browser simulator.
startDataSource();

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <App />
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
