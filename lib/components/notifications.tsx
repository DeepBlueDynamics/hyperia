import React, {forwardRef, useEffect, useRef} from 'react';

import type {NotificationsProps} from '../../typings/hyper';
import {onToastLayerAction, setLayerToasts, useToastLayer} from '../toast-layer';
import type {ToastLayerItem} from '../toast-layer';
import {decorate} from '../utils/plugins';

import Notification_ from './notification';

const Notification = decorate(Notification_, 'Notification');

const openExternal = (url: string | undefined | null) => {
  if (url) void window.require('electron').shell.openExternal(url);
};

const releaseNotesUrl = (version: string | null | undefined) =>
  `https://github.com/DeepBlueDynamics/hyperia/releases/tag/v${version}`;

// The same notices as layer items, so they draw above web panes.
function layerItems(props: NotificationsProps): ToastLayerItem[] {
  const items: ToastLayerItem[] = [];
  if (props.fontShowing) items.push({id: 'note-font', kind: 'toast', emoji: 'Aa', text: `${props.fontSize}px`});
  if (props.resizeShowing)
    items.push({id: 'note-resize', kind: 'toast', emoji: '⤡', text: `${props.cols}x${props.rows}`});
  if (props.messageShowing)
    items.push({
      id: 'note-message',
      kind: 'toast',
      tone: 'error',
      text: String(props.messageText ?? ''),
      buttons: props.messageURL ? [{id: 'more', label: 'More'}] : undefined,
      dismissable: !!props.messageDismissable
    });
  if (props.updateShowing) {
    const note = props.updateNote ? ` ${props.updateNote.trim().replace(/\.$/, '')}.` : '';
    items.push({
      id: 'note-update',
      kind: 'toast',
      emoji: '⬆',
      text: `Version ${props.updateVersion} ready.${note}`,
      buttons: [
        {id: 'notes', label: 'Notes'},
        props.updateCanInstall ? {id: 'restart', label: 'Restart'} : {id: 'download', label: 'Download'}
      ],
      dismissable: true
    });
  }
  return items;
}

const Notifications = forwardRef<HTMLDivElement, NotificationsProps>((props, ref) => {
  // Plugins that decorate the stack keep the DOM version.
  const layer = useToastLayer();
  const native = layer && !props.customChildren && !props.customChildrenBefore;
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    if (!native) return;
    setLayerToasts('notifications', 1, layerItems(props), 'bottom-right');
  });
  useEffect(() => {
    if (!native) return;
    return () => setLayerToasts('notifications', 1, [], 'bottom-right');
  }, [native]);

  // The DOM <Notification> owns the 1s auto-dismiss; on the layer we do.
  useEffect(() => {
    if (!native || !props.fontShowing) return;
    const t = setTimeout(() => latest.current.onDismissFont(), 1000);
    return () => clearTimeout(t);
  }, [native, props.fontShowing, props.fontSize]);
  useEffect(() => {
    if (!native || !props.resizeShowing) return;
    const t = setTimeout(() => latest.current.onDismissResize(), 1000);
    return () => clearTimeout(t);
  }, [native, props.resizeShowing, props.cols, props.rows]);

  useEffect(() => {
    if (!native) return;
    return onToastLayerAction(({toastId, buttonId}) => {
      const p = latest.current;
      if (toastId === 'note-message') {
        if (buttonId === 'close') p.onDismissMessage();
        else if (buttonId === 'more') openExternal(p.messageURL);
      } else if (toastId === 'note-update') {
        if (buttonId === 'close') p.onDismissUpdate();
        else if (buttonId === 'notes') openExternal(releaseNotesUrl(p.updateVersion));
        else if (buttonId === 'restart') p.onUpdateInstall();
        else if (buttonId === 'download') openExternal(p.updateReleaseUrl);
      }
    });
  }, [native]);

  if (native) return <div className="notifications_view" ref={ref} />;

  return (
    <div className="notifications_view" ref={ref}>
      {props.customChildrenBefore}
      {props.fontShowing && (
        <Notification
          key="font"
          backgroundColor="rgba(255, 255, 255, .2)"
          text={`${props.fontSize}px`}
          userDismissable={false}
          onDismiss={props.onDismissFont}
          dismissAfter={1000}
        />
      )}

      {props.resizeShowing && (
        <Notification
          key="resize"
          backgroundColor="rgba(255, 255, 255, .2)"
          text={`${props.cols}x${props.rows}`}
          userDismissable={false}
          onDismiss={props.onDismissResize}
          dismissAfter={1000}
        />
      )}

      {props.messageShowing && (
        <Notification
          key="message"
          backgroundColor="#FE354E"
          color="#fff"
          text={props.messageText}
          onDismiss={props.onDismissMessage}
          userDismissable={props.messageDismissable}
        >
          {props.messageURL ? (
            <>
              {props.messageText} (
              <a
                style={{color: '#fff'}}
                onClick={(ev) => {
                  void window.require('electron').shell.openExternal(ev.currentTarget.href);
                  ev.preventDefault();
                }}
                href={props.messageURL}
              >
                more
              </a>
              )
            </>
          ) : null}
        </Notification>
      )}

      {props.updateShowing && (
        <Notification
          key="update"
          backgroundColor="#18E179"
          color="#000"
          text={`Version ${props.updateVersion} ready`}
          onDismiss={props.onDismissUpdate}
          userDismissable
        >
          Version <b>{props.updateVersion}</b> ready.
          {props.updateNote && ` ${props.updateNote.trim().replace(/\.$/, '')}`} (
          <a
            style={{color: '#000'}}
            onClick={(ev) => {
              void window.require('electron').shell.openExternal(ev.currentTarget.href);
              ev.preventDefault();
            }}
            href={`https://github.com/DeepBlueDynamics/hyperia/releases/tag/v${props.updateVersion}`}
          >
            notes
          </a>
          ).{' '}
          {props.updateCanInstall ? (
            <a
              style={{
                cursor: 'pointer',
                textDecoration: 'underline',
                fontWeight: 'bold'
              }}
              onClick={props.onUpdateInstall}
            >
              Restart
            </a>
          ) : (
            <a
              style={{
                color: '#000',
                cursor: 'pointer',
                textDecoration: 'underline',
                fontWeight: 'bold'
              }}
              onClick={(ev) => {
                void window.require('electron').shell.openExternal(ev.currentTarget.href);
                ev.preventDefault();
              }}
              href={props.updateReleaseUrl!}
            >
              Download
            </a>
          )}
          .{' '}
        </Notification>
      )}
      {props.customChildren}

      <style jsx>{`
        .notifications_view {
          position: fixed;
          bottom: 20px;
          right: 20px;
        }
      `}</style>
    </div>
  );
});

Notifications.displayName = 'Notifications';

export default Notifications;
