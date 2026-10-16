import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { UiProvider } from './components/ui';
import { AppStateProvider } from './state/AppState';
import './styles/app.css';
import './styles/emblem.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <UiProvider>
      <AppStateProvider>
        <App />
      </AppStateProvider>
    </UiProvider>
  </StrictMode>,
);
