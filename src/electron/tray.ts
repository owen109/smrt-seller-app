import {BrowserWindow, Tray, app, Menu} from 'electron';
import { getAssetPath } from './pathResolver.js';
import path from 'path';

export function createTray(mainWindow: BrowserWindow){
    const tray = new Tray(path.join(getAssetPath(), process.platform === 'darwin' ? 'trayIconTemplate.png' : 'trayIcon.png'));
    
    // Set tooltip to show app name on hover
    tray.setToolTip('SMRT Seller');
    
    // Show window on click
    tray.on('click', () => {
        mainWindow.show();
        if(app.dock){
            app.dock.show();
        }
    });
}