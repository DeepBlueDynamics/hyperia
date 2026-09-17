import {BrowserWindow, clipboard, Menu, shell} from 'electron';

import {makeColorSwatch} from './constants';
import {bindOpenFile, bindStickyFile, unbindStickyFile} from './file-watch';
import {getStickySeeThrough, saveStickySeeThrough, setStickySeeThrough, stickyOpacityNow} from './preferences';
import {stickyWindows} from './registry';
import {getNote} from './store';
import {
  anyStickyHidden,
  anyStickyVisible,
  createStickyNote,
  hideAllStickys,
  hideSticky,
  openUrlInWebPane,
  otherStickysVisible,
  showAllStickys
} from './window';

export function applyStickySeeThrough(): void {
  const op = stickyOpacityNow();
  for (const [, win] of stickyWindows) {
    if (!win.isDestroyed()) win.setOpacity(op);
  }
}

export function toggleStickySeeThrough(): void {
  const next = !getStickySeeThrough();
  setStickySeeThrough(next);
  saveStickySeeThrough(next);
  applyStickySeeThrough();
}

export function showStickyContextMenu(
  event: Electron.IpcMainEvent,
  noteId: string,
  hasSelection: boolean,
  _currentColor: string,
  isFileBound?: boolean,
  link?: string | null
): void {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;

  const colors = [
    {name: 'Yellow', hex: '#fff9c4'},
    {name: 'Pink', hex: '#ffb6c1'},
    {name: 'Green', hex: '#c8e6c9'},
    {name: 'Blue', hex: '#bbdefb'},
    {name: 'Peach', hex: '#ffe0b2'},
    {name: 'Lavender', hex: '#e1bee7'},
    {name: 'Khaki', hex: '#f0e68c'},
    {name: 'Plum', hex: '#dda0dd'},
    {name: 'Tomato', hex: '#ff6347'},
    {name: 'Gold', hex: '#ffd700'},
    {name: 'Mint', hex: '#90ee90'},
    {name: 'Salmon', hex: '#ffa07a'}
  ];

  const codeThemes: Electron.MenuItemConstructorOptions[] = [
    {type: 'separator'},
    {
      label: 'Code Highlighting — Light',
      icon: makeColorSwatch('#f8f8f2'),
      click: () => event.sender.send('sticky-set-color', 'code:light')
    },
    {
      label: 'Code Highlighting — Dark',
      icon: makeColorSwatch('#1e1e2e'),
      click: () => event.sender.send('sticky-set-color', 'code:dark')
    }
  ];

  const linkMenu: Electron.MenuItemConstructorOptions[] = link
    ? [
        {label: 'Edit Link', click: () => event.sender.send('sticky-edit-link')},
        {label: 'Open Link in Browser', click: () => void shell.openExternal(link)},
        {label: 'Open Link in Web Pane', click: () => openUrlInWebPane(win, link)},
        {
          label: 'Copy Link',
          click: () => {
            clipboard.writeText(link);
            event.sender.send('sticky-toast', 'Link copied');
          }
        }
      ]
    : [];

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Color',
      submenu: [
        ...colors.map((c) => ({
          label: c.name,
          icon: makeColorSwatch(c.hex),
          click: () => {
            event.sender.send('sticky-set-color', c.hex);
          }
        })),
        ...codeThemes
      ]
    },
    {
      label: 'Syntax Highlight',
      submenu: [
        {
          label: 'Auto (highlight.js)',
          click: () => event.sender.send('sticky-set-highlight', 'static')
        },
        {
          label: 'AI Highlight',
          click: () => event.sender.send('sticky-set-highlight', 'agent')
        },
        {
          label: 'Off',
          click: () => event.sender.send('sticky-set-highlight', 'off')
        }
      ]
    },
    {type: 'separator'},
    {
      label: 'See Through',
      type: 'checkbox',
      checked: getStickySeeThrough(),
      accelerator: 'CommandOrControl+Shift+T',
      registerAccelerator: false,
      click: () => toggleStickySeeThrough()
    },
    {type: 'separator'},
    ...(isFileBound
      ? ([
          {label: 'Open File in OS Editor', click: () => bindOpenFile(noteId)},
          {label: 'Unlink File', click: () => unbindStickyFile(noteId, event.sender)}
        ] as Electron.MenuItemConstructorOptions[])
      : ([
          {label: 'Link to File…', click: () => bindStickyFile(noteId, event.sender)}
        ] as Electron.MenuItemConstructorOptions[])),
    {type: 'separator'},
    {
      label: 'Cut',
      enabled: hasSelection,
      role: 'cut'
    },
    {
      label: 'Copy',
      enabled: hasSelection,
      role: 'copy'
    },
    {
      label: 'Paste',
      role: 'paste'
    },
    {
      label: 'Copy All',
      click: () => event.sender.send('sticky-copy-all')
    },
    {
      label: 'Copy Sticky name + ID',
      click: () => {
        const n = getNote(noteId);
        if (n) {
          const name = (n.name || n.text?.split('\n')[0].slice(0, 20) || 'Sticky').trim();
          const shortId = n.id.replace(/-/g, '').slice(0, 8);
          clipboard.writeText(`Hyperia StickyNote: ${name} (${shortId})`);
        }
      }
    },
    {type: 'separator'},
    {label: 'New Stickys', click: () => createStickyNote({focus: true})},
    {
      label: 'Clone This Sticky',
      click: () => {
        const n = getNote(noteId);
        createStickyNote({
          text: n?.text,
          color: n?.color,
          width: n?.width,
          height: n?.height,
          name: n?.name ? `${n.name} (copy)` : undefined,
          focus: true
        });
      }
    },
    {
      label: 'Search Stickys...',
      click: () => {
        createStickyNote({
          id: 'sticky-search-window',
          name: '🔍 Search Stickys',
          color: '#ffffff',
          width: 400,
          height: 500,
          focus: true
        });
      }
    },
    {
      label: isFileBound ? 'Rename… (linked to file)' : 'Rename...',
      enabled: !isFileBound,
      click: () => event.sender.send('sticky-rename')
    },
    {type: 'separator'},
    {
      label: 'Hide This',
      click: () => {
        hideSticky(noteId);
      }
    },
    ...(otherStickysVisible(noteId) ? [{label: 'Hide Other Stickys', click: () => hideAllStickys(noteId)}] : []),
    ...(anyStickyVisible() ? [{label: 'Hide Active Stickys', click: () => hideAllStickys()}] : []),
    ...(anyStickyHidden() ? [{label: 'Show Active Stickys', click: () => showAllStickys()}] : []),
    {type: 'separator'},
    {
      label: 'Delete',
      click: () => event.sender.send('sticky-delete')
    }
  ];

  const menu = Menu.buildFromTemplate(link ? linkMenu : template);
  menu.popup({window: win});
}
