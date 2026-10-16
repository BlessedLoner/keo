import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { CommandBarApp } from './presence/CommandBarApp';
import { CompanionApp } from './presence/CompanionApp';
import { UiProvider } from './components/ui';
import { AppStateProvider } from './state/AppState';
import './styles/app.css';
import './styles/emblem.css';

// One renderer bundle, three windows: the main app, the floating companion and the command bar.
const route = window.location.hash;

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <UiProvider>
      {route === '#companion' ? (
        <CompanionApp />
      ) : route === '#command' ? (
        <CommandBarApp />
      ) : (
        <AppStateProvider>
          <App />
        </AppStateProvider>
      )}
    </UiProvider>
  </StrictMode>,
);
