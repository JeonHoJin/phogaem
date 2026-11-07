import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { finishGoogleAuth } from './server/google';

void finishGoogleAuth().catch(() => 'Google 로그인 실패').then(error => {
  createRoot(document.getElementById('root')!).render(<StrictMode><App initialAuthError={error} /></StrictMode>);
});
