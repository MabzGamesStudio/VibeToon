import { createRoot } from 'react-dom/client';
import { App } from './App';
import { StudioProvider } from './state/store';
import { ViewProvider } from './state/view';
import './styles/main.scss';

const container = document.getElementById('root');
if (!container) throw new Error('No #root element');

createRoot(container).render(
  <ViewProvider>
    <StudioProvider>
      <App />
    </StudioProvider>
  </ViewProvider>,
);
