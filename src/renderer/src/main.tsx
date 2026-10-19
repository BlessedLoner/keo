import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { CommandBarApp } from './presence/CommandBarApp';
import { CompanionApp } from './presence/CompanionApp';
import { ResultsApp } from './presence/ResultsApp';
import { PencilApp } from './presence/PencilApp';
import { KeoModeApp } from './presence/KeoModeApp';
import { UiProvider } from './components/ui';
import { invoke, subscribe } from './lib/api';
import { AppStateProvider } from './state/AppState';
import './styles/app.css';
import './styles/emblem.css';

// One renderer bundle, four windows: the main app, the floating companion, the command bar and research results.
const route = window.location.hash;

// The look (Noir or Classic) in every window: from settings, and again whenever they change.
const applyTheme = () =>
  void invoke('settings:get', {})
    .then((st) => {
      document.documentElement.dataset.theme = st.ui.theme;
    })
    .catch(() => undefined);
applyTheme();
subscribe('settings:changed', applyTheme);

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
      ) : route === '#keomode' ? (
        <KeoModeApp />
      ) : (
        <AppStateProvider>
          <App />
        </AppStateProvider>
      )}
    </UiProvider>
  </StrictMode>,
);
