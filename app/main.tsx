import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initializeAnalytics } from './analytics';
import { ChessPermutations } from './chesspermutations';
import './globals.css';

initializeAnalytics();

const root = document.getElementById('root');

if (!root) {
  throw new Error('chesspermutations could not find its application root.');
}

createRoot(root).render(
  <StrictMode>
    <ChessPermutations />
  </StrictMode>,
);
