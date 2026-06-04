import type {BrowserWindow} from 'electron';

import fetch from 'electron-fetch';
import ms from 'ms';

import {version} from './package.json';

const NEWS_URL = 'https://hyper-news.now.sh';

export default function fetchNotifications(win: BrowserWindow) {
  // Disable Vercel news notifications feed to prevent mismatched/deprecated platform warnings.
  return;
}
