import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { CommandBarApp } from './presence/CommandBarApp';
import { CompanionApp } from './presence/CompanionApp';
import { ResultsApp } from './presence/ResultsApp';
import { PencilApp } from './presence/PencilApp';
import { UiProvider } from './components/ui';
import { AppStateProvider } from './state/AppState';
import './styles/app.css';
import './styles/emblem.css';

// One renderer bundle, four windows: the main app, the floating companion, the command bar and research results.
const route = window.location.hash;

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <UiProvider>
      {route === '#companion' ? (
        <CompanionApp />
      ) : route === '#command' ? (
        <CommandBarApp />
      ) : route === '#results' ? (
        <ResultsApp />
      ) : route === '#pencil' ? (
        <PencilApp />
      ) : (
        <AppStateProvider>
          <App />
        </AppStateProvider>
      )}
    </UiProvider>
  </StrictMode>,
);
