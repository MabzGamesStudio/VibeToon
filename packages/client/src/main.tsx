import { createRoot } from 'react-dom/client';
import { App } from './App';
import { StudioProvider } from './state/store';
import { TipsProvider } from './state/tips';
import './styles/main.scss';

const container = document.getElementById('root');
if (!container) throw new Error('No #root element');

createRoot(container).render(
  <TipsProvider>
    <StudioProvider>
      <App />
    </StudioProvider>
  </TipsProvider>,
);
