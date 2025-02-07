import { app, BrowserWindow, ipcMain, Tray } from 'electron';
import express from 'express';
import { ipcMainOn, isDev, ipcMainHandle } from './util.js';
import { pollResources, getStaticData } from './resourceManager.js';
import { getPreloadPath, getUIPath, getAssetPath } from './pathResolver.js';
import { createTray } from './tray.js';
import { createMenu } from './menu.js';
import { createAutomationManager } from './automationManager.js';
import { generateLabel } from './labelGenerator.js';
import { print, isPrintComplete } from 'unix-print';
import path from 'path';
import fs from 'fs';
// Commenting out Clerk for now
// import { Clerk } from '@clerk/clerk-sdk-node';
// const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
// const clerk = new Clerk({ secretKey: CLERK_SECRET_KEY });

// Utility function for printing with unix-print
async function printPDFUnix(pdfPath: string, printerName?: string, options: string[] = []): Promise<boolean> {
  try {
    console.log('Printing PDF:', pdfPath);
    console.log('Printer:', printerName || 'default');
    console.log('Options:', options);

    const printJob = await print(pdfPath, printerName, options);
    
    // Wait for print completion
    while (!await isPrintComplete(printJob)) {
      await new Promise(resolve => setTimeout(resolve, 500)); // Check every 500ms
    }

    console.log('Print completed successfully');
    return true;
  } catch (error) {
    console.error('Print failed:', error);
    return false;
  }
}

app.on('ready', () => {
  const mainWindow = new BrowserWindow({
    title: 'SMRT Seller',
    width: 800,
    height: 600,
    webPreferences: {
      preload: getPreloadPath(),
    },
    frame: false,
  });
  if (isDev()) {
    mainWindow.loadURL(`http://localhost:5123`);
  } else {
    mainWindow.loadFile(getUIPath());
  }

  // Create automation manager
  const automationManager = createAutomationManager(mainWindow);

  // Set up IPC handlers
  setupIpcHandlers(automationManager, mainWindow);

  // Set up HTTP server
  setupHttpServer(automationManager);

  pollResources(mainWindow);

  ipcMainHandle("getStaticData", () => {
    return getStaticData();
  })

  ipcMainOn("sendFrameAction", (payload) => {
    switch(payload){
      case "CLOSE":
        mainWindow.close();
        break;
      case "MINIMIZE":
        mainWindow.minimize();
        break;
      case "MAXIMIZE":
        mainWindow.maximize();
        break;
    }
  })

  createTray(mainWindow);
  handleClose(mainWindow);
  createMenu(mainWindow);
});

function setupIpcHandlers(automationManager: ReturnType<typeof createAutomationManager>, mainWindow: BrowserWindow) {
  ipcMainHandle<'startAutomation'>("startAutomation", async (_event, request: AutomationRequest) => {
    const id = await automationManager.startAutomation(request);
    return id;
  });

  ipcMainHandle<'getSetupStatus'>("getSetupStatus", async () => {
    return await automationManager.getSetupStatus();
  });

  ipcMainHandle<'startSetup'>("startSetup", async () => {
    return await automationManager.startSetup();
  });

  ipcMainHandle<'completeSetup'>("completeSetup", async () => {
    const setupId = await automationManager.getCurrentSetupId();
    await automationManager.completeSetup(setupId);
  });

  ipcMainHandle<'getLogs'>("getLogs", async () => {
    const logPath = path.join(app.getPath('userData'), 'logs');
    const today = new Date().toISOString().split('T')[0];
    const logFile = path.join(logPath, `automation-${today}.log`);
    
    try {
      // Use fs.promises for proper Promise-based API
      const logs = await fs.promises.readFile(logFile, 'utf-8');
      return logs;
    } catch (error) {
      console.error('Failed to read logs:', error);
      return ''; // Return empty string instead of undefined
    }
  });

  ipcMainHandle<'getPrinters'>("getPrinters", async () => {
    const printers = await mainWindow.webContents.getPrintersAsync();
    return printers.map((printer: Electron.PrinterInfo) => ({
      name: printer.name,
      description: printer.description || '',
      status: String(printer.status || 'unknown'),
      isDefault: printer.isDefault
    }));
  });

  ipcMainHandle<'testPrint'>("testPrint", async (_event, settings: PrintSettings) => {
    try {
      // Create a test label
      const testLabelPath = await generateLabel({
        fnsku: 'X00000000',
        sku: 'TEST-SKU',
        asin: 'TEST-ASIN',
        condition: 'Test Print'
      });

      // Print using unix-print
      const success = await printPDFUnix(testLabelPath, settings.printer, [
        '-o fit-to-page',
        settings.color ? '-o color' : '-o nocolor',
        `-n ${settings.copies || 1}`
      ]);

      return success;
    } catch (error) {
      console.error('Print error:', error);
      return false;
    }
  });
}

function setupHttpServer(automationManager: ReturnType<typeof createAutomationManager>) {
  const server = express();
  server.use(express.json());

  // Simple CORS middleware for testing
  server.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    next();
  });

  // Routes without authentication for now
  server.post('/automation/start', async (req, res) => {
    try {
      const request = req.body as AutomationRequest;
      const id = await automationManager.startAutomation(request);

      // Wait for automation to complete
      await new Promise<void>((resolve, reject) => {
        let attempts = 0;
        const maxAttempts = 30; // 30 seconds timeout

        const checkStatus = async () => {
          const result = await automationManager.getAutomationResult(id);
          
          if (result) {
            if (result.error) {
              reject(new Error(result.error));
            } else if (result.fnsku) {
              resolve();
            } else {
              // Keep waiting if we have a result but no FNSKU yet
              if (attempts++ < maxAttempts) {
                setTimeout(checkStatus, 1000);
              } else {
                reject(new Error('Timeout waiting for FNSKU'));
              }
            }
          } else {
            if (attempts++ < maxAttempts) {
              setTimeout(checkStatus, 1000);
            } else {
              reject(new Error('Timeout waiting for result'));
            }
          }
        };
        checkStatus();
      });

      // Get the final result
      const result = await automationManager.getAutomationResult(id);
      if (!result?.fnsku) {
        throw new Error('Failed to get FNSKU from automation');
      }
      res.json({ id, fnsku: result.fnsku });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      res.status(500).json({ error: errorMessage });
    }
  });

  server.get('/setup/status', async (_req, res) => {
    try {
      const status = await automationManager.getSetupStatus();
      res.json(status);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      res.status(500).json({ error: errorMessage });
    }
  });

  server.post('/setup/start', async (_req, res) => {
    try {
      const id = await automationManager.startSetup();
      res.json({ id });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      res.status(500).json({ error: errorMessage });
    }
  });

  const port = process.env.PORT || 3456;
  server.listen(port, () => {
    console.log(`HTTP server running on port ${port}`);
  });
}

function handleClose(mainWindow: BrowserWindow){
  let willClose = false;
  mainWindow.on('close', (e) => {
    if(willClose){
      return;
    }
    e.preventDefault();
    mainWindow.hide();
    if(app.dock){
      app.dock.hide();
    }
  })
  app.on('before-quit', () => {
    willClose = true;
  });

  mainWindow.on('show', () => {
    willClose = false;
  })
}

  