import { ipcMain, WebContents, IpcMainInvokeEvent } from 'electron';
import { pathToFileURL } from 'url';
import { getUIPath } from './pathResolver.js';
import { WebFrameMain } from 'electron/main';

export function isDev(): boolean {
    return process.env.NODE_ENV === 'development';
}

export function ipcMainHandle<Key extends keyof EventPayloadMapping>(
    key: Key,
    handler: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<EventPayloadMapping[Key]> | EventPayloadMapping[Key]
) {
    ipcMain.handle(key, async (event, ...args) => {
        if (!event.senderFrame) {
            throw new Error('Event sender frame is null');
        }
        validateEventFrame(event.senderFrame);
        return handler(event, ...args);
    });
}

export function ipcMainOn<Key extends keyof EventPayloadMapping>(
    key: Key,
    handler: (payload: EventPayloadMapping[Key]) => void
) {
    ipcMain.on(key, (event, payload) => {
        if (!event.senderFrame) {
            throw new Error('Event sender frame is null');
        }
        validateEventFrame(event.senderFrame);
        return handler(payload);
    });
}

export function ipcWebContentsSend<Key extends keyof EventPayloadMapping>(
    key: Key,
    webContents: WebContents,
    payload: EventPayloadMapping[Key]
) {
    webContents.send(key, payload);
}

export function validateEventFrame(frame: WebFrameMain) {
    console.log(frame.url);
    if (isDev() && new URL(frame.url).host === 'localhost:5123') {
      return;
    }
    if (frame.url !== pathToFileURL(getUIPath()).toString()) {
      throw new Error('Malicious event') ;
    }
  }