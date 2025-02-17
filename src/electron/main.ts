import { app, BrowserWindow, ipcMain, Tray } from 'electron';
import express from 'express';
import { ipcMainOn, isDev, ipcMainHandle } from './util.js';
import { pollResources, getStaticData } from './resourceManager.js';
import { getPreloadPath, getUIPath, getAssetPath } from './pathResolver.js';
import { createTray } from './tray.js';
import { createMenu } from './menu.js';
import { createAutomationManager } from './automationManager.js';
import { generateLabel, LABEL_SIZES } from './labelGenerator.js';
import { print, isPrintComplete } from 'unix-print';
import path from 'path';
import fs from 'fs';
import { PrintManager } from './PrintManager.js';
import { execPromise } from './util.js';
// Commenting out Clerk for now
// import { Clerk } from '@clerk/clerk-sdk-node';
// const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
// const clerk = new Clerk({ secretKey: CLERK_SECRET_KEY });

// Helper function to get media size based on label size
function getMediaSize(labelSize: LabelSize): string {
  switch (labelSize) {
    case 'SMALL':
      return 'Custom.1x2.125in';
    case 'STANDARD':
      return 'Custom.1x2.625in';
    case 'LARGE':
      return 'Custom.2x3in';
    default:
      return 'Custom.1x2.625in'; // Default to standard size
  }
}

// Utility function for printing with unix-print
async function printPDFUnix(pdfPath: string, printerName?: string, options: string[] = []): Promise<boolean> {
  try {
    console.log('Using PDF path:', pdfPath);

    // Using lp with specific options for rotation and sizing
    const command = `lp -d "${printerName}" -o landscape -o orientation-requested=6 -o scaling=100 -o media=Custom.1x2.125in "${pdfPath}"`;
    
    console.log('Sending print job with command:', command);
    
    const { stdout, stderr } = await execPromise(command);
    
    if (stderr) {
      console.error('Print error:', stderr);
      return false;
    }
    
    console.log('Print job sent successfully!', stdout);
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
    resizable: false,
    webPreferences: {
      preload: getPreloadPath(),
    }
  });

  // Set the title again after creation to ensure it sticks
  mainWindow.setTitle('SMRT Seller');
  
  // Prevent title changes from the webpage
  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault();
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

  // Update popup window configuration
  const popup = new BrowserWindow({
    width: 400,
    height: 200,
    resizable: false,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false
    },
    backgroundColor: '#ffffff',
    show: false
  });
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

  ipcMainHandle<'getPrintSettings'>("getPrintSettings", async () => {
    return automationManager.getPrintSettings();
  });

  ipcMainHandle<'testPrint'>("testPrint", async (_event, settings: PrintSettings) => {
    try {
      console.log('\n=== Test Print Request ===');
      console.log('Print Settings:', {
        printer: settings.printer,
        labelSize: settings.labelSize,
        copies: settings.copies || 1
      });

      // Update automation manager's print settings first
      automationManager.setPrintSettings(settings);
      
      // Log the updated settings from automation manager to verify
      const verifySettings = automationManager.getPrintSettings();
      console.log('Verified automation manager settings:', {
        printer: verifySettings.printer,
        labelSize: verifySettings.labelSize,
        mediaSize: getMediaSize(verifySettings.labelSize),
        dimensions: LABEL_SIZES[verifySettings.labelSize]
      });

      // Only proceed with test print if we're actually testing
      if (settings.copies) {
        // Create a test label
        const testLabelPath = await generateLabel({
          fnsku: 'X00000000',
          sku: 'TEST-SKU',
          asin: 'TEST-ASIN',
          condition: 'Test Print',
          labelSize: settings.labelSize
        });

        console.log('Test label generated at:', testLabelPath);

        // Using lp with specific options for rotation and sizing
        const mediaSize = getMediaSize(settings.labelSize);
        const command = `lp -d "${settings.printer}" -n ${settings.copies || 1} -o landscape -o orientation-requested=6 -o scaling=100 -o media=${mediaSize} "${testLabelPath}"`;
        
        console.log('Print Command:', command);
        
        const { stdout, stderr } = await execPromise(command);
        
        if (stderr) {
          console.error('Print error:', stderr);
          console.log('=== End Test Print Request (Failed) ===\n');
          return false;
        }
        
        console.log('Print job details:', stdout);
        console.log('=== End Test Print Request (Success) ===\n');
      }

      return true;

    } catch (error) {
      console.error('Print error:', error);
      console.log('=== End Test Print Request (Error) ===\n');
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

  // Add ping endpoint for health checks
  server.get('/ping', (_req, res) => {
    res.status(200).json({ 
      status: 'OK',
      timestamp: new Date().toISOString()
    });
  });

  // New endpoint for printing labels
  server.post('/print-label', async (req, res) => {
    try {
      const { fnsku, sku, asin, title, condition, quantity = 1 } = req.body;
      
      console.log('\n=== Print Label Request ===');
      console.log('Request Details:', {
        fnsku,
        sku,
        asin,
        title: title ? (title.length > 30 ? title.substring(0, 30) + '...' : title) : undefined,
        condition,
        quantity
      });
      
      if (!fnsku || !sku || !asin) {
        console.log('Error: Missing required parameters');
        return res.status(400).json({ 
          success: false, 
          error: 'Missing required parameters (fnsku, sku, asin)' 
        });
      }

      // Get current print settings
      const printSettings = automationManager.getPrintSettings();
      const mediaSize = getMediaSize(printSettings.labelSize);
      console.log('Print Settings:', {
        printer: automationManager.getPrinterName(),
        labelSize: printSettings.labelSize,
        mediaSize,
        quantity,
        dimensions: LABEL_SIZES[printSettings.labelSize]
      });

      // Generate and print the label
      const labelPath = await generateLabel({
        fnsku,
        sku,
        asin,
        title,
        condition,
        labelSize: printSettings.labelSize
      });

      console.log('Label generated at:', labelPath);

      // Using lp with specific options for rotation and sizing
      const command = `lp -d "${automationManager.getPrinterName()}" -o landscape -o orientation-requested=6 -o scaling=100 -o media=${mediaSize} "${labelPath}"`;
      
      console.log('Print Command:', command);
      
      // Execute the command for each copy
      for (let i = 1; i <= quantity; i++) {
        console.log(`\nExecuting print ${i} of ${quantity}`);
        const { stdout, stderr } = await execPromise(command);
        
        if (stderr) {
          console.error(`Print error on copy ${i}:`, stderr);
          console.log('=== End Print Label Request (Failed) ===\n');
          return res.status(200).json({ success: false });
        }
        
        console.log(`Print job ${i} sent successfully!`);
        console.log('Print job details:', stdout);
      }

      console.log('=== End Print Label Request (Success) ===\n');
      return res.status(200).json({ success: true });

    } catch (error) {
      console.error('Error printing label:', error);
      console.log('=== End Print Label Request (Error) ===\n');
      // Still return 200 as requested
      return res.status(200).json({ success: true });
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

  