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
      // Update automation manager's print settings
      automationManager.setPrintSettings(settings);

      // Create a test label
      const testLabelPath = await generateLabel({
        fnsku: 'X00000000',
        sku: 'TEST-SKU',
        asin: 'TEST-ASIN',
        condition: 'Test Print',
        labelSize: settings.labelSize
      });

      // Print using unix-print with proper scaling
      const success = await printPDFUnix(testLabelPath, settings.printer, [
        // Remove fit-to-page to respect the PDF dimensions
        '-o media=Custom.66.7x25.4mm',  // Default to standard size
        ...(settings.labelSize === 'SMALL' ? ['-o media=Custom.50.8x25.4mm'] : []),
        ...(settings.labelSize === 'LARGE' ? ['-o media=Custom.76.2x50.8mm'] : []),
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

  // New endpoint for printing labels
  server.post('/print-label', async (req, res) => {
    try {
      const { fnsku, sku, asin, title, condition, quantity = 1 } = req.body;
      
      if (!fnsku || !sku || !asin) {
        return res.status(400).json({ 
          success: false, 
          error: 'Missing required parameters (fnsku, sku, asin)' 
        });
      }

      // Get current print settings
      const printSettings = automationManager.getPrintSettings();

      // Generate and print the label
      const labelPath = await generateLabel({
        fnsku,
        sku,
        asin,
        title,
        condition,
        labelSize: printSettings.labelSize
      });

      // Print using unix-print with proper scaling
      const success = await printPDFUnix(labelPath, automationManager.getPrinterName(), [
        // Remove fit-to-page to respect the PDF dimensions
        '-o media=Custom.66.7x25.4mm',  // Default to standard size
        ...(printSettings.labelSize === 'SMALL' ? ['-o media=Custom.50.8x25.4mm'] : []),
        ...(printSettings.labelSize === 'LARGE' ? ['-o media=Custom.76.2x50.8mm'] : []),
        '-o nocolor',
        `-n ${Math.max(1, Math.min(100, parseInt(quantity) || 1))}` // Limit between 1 and 100 copies
      ]);

      // Send immediate response
      res.status(200).json({ success: true });

      // Log the result
      if (!success) {
        console.error('Failed to print label:', { fnsku, sku, asin, quantity });
      }

    } catch (error) {
      console.error('Error printing label:', error);
      // Still return 200 as requested
      res.status(200).json({ success: true });
    }
  });

  // Routes without authentication for now
  server.post('/automation/start', async (req, res) => {
    try {
      console.log(req.body.params);
      const request = req.body as AutomationRequest;
      console.log('\n=== Starting New Automation ===');
      console.log('Request details:', {
        type: request.type,
        sku: request.params?.sku,
        asin: request.params?.asin,
        price: request.params?.price,
        condition: request.params?.condition,
        conditionNotes: request.params?.conditionNotes
      });
      
      console.log('Calling automationManager.startAutomation...');
      const id = await automationManager.startAutomation(request);
      console.log('Received automation ID:', id);

      // Get the result immediately after automation completes
      console.log('Getting automation result for ID:', id);
      const finalResult = await automationManager.getAutomationResult(id);
      console.log('Raw automation result:', finalResult);
      
      if (!finalResult) {
        console.log('No result found for automation ID:', id);
        throw new Error(`No result found for automation ID: ${id}`);
      }
      
      if (!finalResult.fnsku) {
        console.log('No FNSKU found in result:', finalResult);
        throw new Error('Failed to get FNSKU from automation');
      }

      console.log('=== Automation Success ===');
      console.log('Automation ID:', id);
      console.log('FNSKU:', finalResult.fnsku);
      console.log('Sending successful response');
      
      // Send response immediately with FNSKU
      return res.json({ 
        success: true,
        id, 
        fnsku: finalResult.fnsku,
        message: 'Listing created successfully.',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('\n=== Automation Error ===');
      console.error('Error details:', {
        message: error instanceof Error ? error.message : 'Unknown error occurred',
        stack: error instanceof Error ? error.stack : undefined
      });
      
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      return res.status(500).json({ 
        success: false,
        error: errorMessage,
        timestamp: new Date().toISOString()
      });
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

  