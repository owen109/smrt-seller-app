const electron = require('electron');

// EXPOSE TO MAIN
electron.contextBridge.exposeInMainWorld('electron', {
    subscribeStatistics: (callback) =>
        // @ts-ignore
        ipcOn('statistics', (stats) => {
            callback(stats);
        }),
    subscribeChangeView: (callback) =>
        // @ts-ignore
        ipcOn('changeView', (view) => {
            callback(view);
        }),
    getStaticData: () => ipcInvoke('getStaticData'),
    sendFrameAction: (payload) => ipcSend('sendFrameAction', payload),
    startAutomation: (request: AutomationRequest) => ipcInvoke<'startAutomation'>('startAutomation', request),
    subscribeAutomationStatus: (callback) =>
        ipcOn('automationStatus', (status) => {
            callback(status);
        }),
    getSetupStatus: () => ipcInvoke<'getSetupStatus'>('getSetupStatus'),
    startSetup: () => ipcInvoke<'startSetup'>('startSetup'),
    completeSetup: () => ipcInvoke<'completeSetup'>('completeSetup'),
    getLogs: () => ipcInvoke<'getLogs'>('getLogs'),
    getPrinters: () => ipcInvoke<'getPrinters'>('getPrinters'),
    testPrint: (settings: PrintSettings) => ipcInvoke<'testPrint'>('testPrint', settings)
} satisfies Window['electron']); 


function ipcInvoke<Key extends keyof EventPayloadMapping>(
    key: Key,
    payload?: any
): Promise<EventPayloadMapping[Key]> {
    return electron.ipcRenderer.invoke(key, payload);
}
  
function ipcOn<Key extends keyof EventPayloadMapping>(
    key: Key,
    callback: (payload: EventPayloadMapping[Key]) => void
) {
    const cb = (_: Electron.IpcRendererEvent, payload: any) => callback(payload);
    electron.ipcRenderer.on(key, cb);
    return () => electron.ipcRenderer.off(key, cb);
}

function ipcSend<Key extends keyof EventPayloadMapping>(
    key: Key,
    payload: EventPayloadMapping[Key]
) {
    electron.ipcRenderer.send(key, payload);
}