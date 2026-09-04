import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChessUniverse } from './chess-universe';
import './globals.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Chess Universe could not find its application root.');
}

createRoot(root).render(
  <StrictMode>
    <ChessUniverse />
  </StrictMode>,
);
