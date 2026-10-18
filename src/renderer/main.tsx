import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { OverlayHost } from './components/ui/Modal.js';
import './styles.css';
createRoot(document.getElementById('root')!).render(<OverlayHost><App /></OverlayHost>);
