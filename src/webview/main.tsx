import { createRoot } from 'react-dom/client';
import 'tdesign-react/es/style/index.css';
import 'tdesign-react/es/button/style/index.css';
import 'tdesign-react/es/input/style/index.css';
import 'tdesign-react/es/drawer/style/index.css';
import { App } from './app.js';
import './styles.css';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Webview root element is missing.');
createRoot(root).render(<App />);
