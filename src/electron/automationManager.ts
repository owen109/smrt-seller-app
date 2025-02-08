import { firefox, Browser, Page } from 'playwright';
import path from 'path';
import { app } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { ipcWebContentsSend } from './util.js';
import { BrowserWindow } from 'electron';
import fs from 'fs/promises';
import { generateLabel } from './labelGenerator.js';
import { print, isPrintComplete } from 'unix-print';
import { dialog } from 'electron';
import { ipcMain } from 'electron';

// Create a logging utility
const log = {
    info: (message: string, ...args: any[]) => {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] INFO: ${message}`;
        console.log(logMessage, ...args);
        writeToLogFile(logMessage + (args.length ? ' ' + JSON.stringify(args) : ''));
    },
    error: (message: string, error?: any) => {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ERROR: ${message}${error ? ` - ${error.message || error}` : ''}`;
        console.error(logMessage);
        writeToLogFile(logMessage + (error?.stack ? '\n' + error.stack : ''));
    }
};

async function writeToLogFile(message: string) {
    const logPath = path.join(app.getPath('userData'), 'logs');
    const logFile = path.join(logPath, `automation-${new Date().toISOString().split('T')[0]}.log`);
    
    try {
        await fs.mkdir(logPath, { recursive: true });
        await fs.appendFile(logFile, message + '\n');
    } catch (error) {
        console.error('Failed to write to log file:', error);
    }
}

type RunningAutomation = {
    id: string;
    browser: Browser;
    page: Page;
    status: AutomationStatus;
    result?: {
        fnsku?: string;
        error?: string;
    };
    timeoutId?: NodeJS.Timeout;
}

type PendingAutomation = {
    request: AutomationRequest;
    startTime: number;
    retryCount: number;
    originalId?: string;
}

class AutomationManager {
    private runningAutomations: Map<string, RunningAutomation> = new Map();
    private pendingAutomations: PendingAutomation[] = [];
    private completedResults: Map<string, RunningAutomation['result']> = new Map();
    private readonly MAX_COMPLETED_RESULTS = 1000; // Maximum number of results to keep
    private readonly RESULT_TTL = 1000 * 60 * 60; // 1 hour TTL for results
    private mainWindow: BrowserWindow;
    private profilesPath: string;
    private configPath: string;
    private printerName: string = '';
    private isReauthenticating: boolean = false;
    private authBrowser: Browser | null = null;
    private printSettings: PrintSettings = {
        printer: '',
        labelSize: 'STANDARD',
        copies: 1,
        color: false
    };

    constructor(mainWindow: BrowserWindow) {
        this.mainWindow = mainWindow;
        // Use the app's user data directory in production
        const baseDir = app.isPackaged 
            ? app.getPath('userData')
            : process.cwd();
        
        this.profilesPath = path.join(baseDir, 'profiles');
        this.configPath = path.join(this.profilesPath, 'config.json');
        
        log.info('Initializing AutomationManager', {
            baseDir,
            profilesPath: this.profilesPath,
            configPath: this.configPath,
            isPackaged: app.isPackaged
        });
        
        this.initializeDirectories();
        this.initializePrinter();
    }

    private async initializeDirectories() {
        try {
            log.info('Creating profile directories');
            
            // Create profiles directory
            await fs.mkdir(this.profilesPath, { recursive: true });
            
            // Create default profile directory
            const defaultProfilePath = path.join(this.profilesPath, 'default');
            await fs.mkdir(defaultProfilePath, { recursive: true });
            
            // Create empty cookies.sqlite if it doesn't exist
            const cookiesPath = path.join(defaultProfilePath, 'cookies.sqlite');
            try {
                await fs.access(cookiesPath);
                log.info('cookies.sqlite already exists');
            } catch {
                log.info('Creating empty cookies.sqlite');
                await fs.writeFile(cookiesPath, '');
            }

            log.info('Directory initialization complete', {
                profilesPath: this.profilesPath,
                defaultProfilePath: defaultProfilePath,
                cookiesPath: cookiesPath
            });
        } catch (error) {
            log.error('Failed to create profile directories:', error);
        }
    }

    private async initializePrinter() {
        try {
            const printers = await this.mainWindow.webContents.getPrintersAsync();
            const defaultPrinter = printers.find(p => p.isDefault);
            if (defaultPrinter) {
                this.printerName = defaultPrinter.name;
                log.info('Default printer set:', defaultPrinter.name);
            }
        } catch (error) {
            log.error('Failed to initialize printer:', error);
        }
    }

    private async saveConfig(config: SetupStatus) {
        try {
            log.info('Saving config', config);
            await fs.writeFile(this.configPath, JSON.stringify(config, null, 2));
        } catch (error) {
            log.error('Failed to save config:', error);
        }
    }

    async getSetupStatus(): Promise<SetupStatus> {
        try {
            const data = await fs.readFile(this.configPath, 'utf-8');
            const config = JSON.parse(data) as SetupStatus;
            log.info('Retrieved setup status', config);
            return config;
        } catch (error) {
            log.info('No config found, returning default status');
            return { isConfigured: false };
        }
    }

    private updateAutomationStatus(automation: RunningAutomation, update: Partial<AutomationStatus>) {
        automation.status = { ...automation.status, ...update };
        log.info('Updating automation status', {
            automationId: automation.id,
            status: automation.status
        });
        ipcWebContentsSend('automationStatus', this.mainWindow.webContents, automation.status);
    }

    async startSetup(): Promise<string> {
        const id = uuidv4();
        const defaultProfilePath = path.join(this.profilesPath, 'default');

        const browser = await firefox.launch({
            headless: false,
            firefoxUserPrefs: {
                'browser.sessionstore.resume_from_crash': false,
                'browser.sessionstore.max_resumed_crashes': 0
            }
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:122.0) Gecko/20100101 Firefox/122.0',
            viewport: { width: 1500, height: 900 },
            screen: { width: 1500, height: 900 }
        });

        const page = await context.newPage();
        
        const automation: RunningAutomation = {
            id,
            browser,
            page,
            status: {
                id,
                status: 'running',
                progress: 0
            }
        };

        this.runningAutomations.set(id, automation);
        
        try {
            this.updateAutomationStatus(automation, {
                message: 'Opening Amazon Seller Central...',
                progress: 20
            });

            await page.goto('https://sellercentral.amazon.com/');
            
            this.updateAutomationStatus(automation, {
                message: 'Please log in to Seller Central...',
                progress: 50
            });

            // Wait for navigation to home page after login
            await page.waitForURL(url => {
                const urlStr = url.toString();
                return urlStr.includes('sellercentral.amazon.com') && 
                    (urlStr.includes('/home') || urlStr.includes('/dashboard') || urlStr.includes('/inventory'));
            }, { timeout: 300000 }); // 5 minute timeout

            // Auto-complete setup once we detect successful login
            await this.completeSetup(id);

            return id;

        } catch (error) {
            console.error('Setup error:', error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            
            if (this.runningAutomations.has(id)) {
                this.updateAutomationStatus(automation, {
                    status: 'error',
                    message: `Setup failed: ${errorMessage}`
                });
            }
            
            await this.cleanupAutomation(id);
            throw error;
        }
    }

    private async cleanupAutomation(id: string) {
        const automation = this.runningAutomations.get(id);
        if (automation) {
            log.info('Cleaning up automation', { id });
            try {
                // Clear the timeout if it exists
                if (automation.timeoutId) {
                    clearTimeout(automation.timeoutId);
                }

                if (!automation.browser.isConnected()) {
                    log.info('Browser already disconnected', { id });
                    this.runningAutomations.delete(id);
                    return;
                }
                
                // Close browser immediately - this will automatically close all pages and contexts
                await automation.browser.close()
                    .catch(e => log.error('Error closing browser:', e));
                
                log.info('Successfully cleaned up automation', { id });
            } catch (error) {
                log.error('Error during cleanup:', error);
            } finally {
                this.runningAutomations.delete(id);
            }
        }
    }

    // Add a timeout to automations
    private setupAutomationTimeout(automation: RunningAutomation, timeoutMs: number = 15 * 60 * 1000) { // Increased to 15 minutes
        let timeoutId: NodeJS.Timeout;
        let startTime = Date.now();
        let pausedAt: number | null = null;

        const checkTimeout = async () => {
            // If we're re-authenticating, pause the timeout
            if (this.isReauthenticating) {
                if (!pausedAt) pausedAt = Date.now();
                return;
            }

            // If we were paused, adjust the start time
            if (pausedAt) {
                const pauseDuration = Date.now() - pausedAt;
                startTime += pauseDuration;
                pausedAt = null;
            }

            const elapsedTime = Date.now() - startTime;
            if (elapsedTime >= timeoutMs && this.runningAutomations.has(automation.id)) {
                log.error('Automation timed out', { 
                    id: automation.id,
                    elapsedTime: `${Math.round(elapsedTime / 1000)}s`,
                    timeoutLimit: `${Math.round(timeoutMs / 1000)}s`
                });
                
                this.updateAutomationStatus(automation, {
                    status: 'error',
                    message: `Automation timed out after ${Math.round(elapsedTime / 1000)} seconds`
                });
                
                await this.cleanupAutomation(automation.id);
                return;
            }

            // Check again in 1 second
            timeoutId = setTimeout(checkTimeout, 1000);
        };

        // Start the timeout checker
        timeoutId = setTimeout(checkTimeout, 1000);

        // Store the timeout ID in the automation for cleanup
        automation.timeoutId = timeoutId;
    }

    async getCurrentSetupId(): Promise<string> {
        const currentSetup = Array.from(this.runningAutomations.entries())
            .find(([_, automation]) => automation.status.status === 'running');
        
        if (!currentSetup) {
            throw new Error('No active setup session found');
        }

        return currentSetup[0];
    }

    async completeSetup(automationId: string): Promise<void> {
        const automation = this.runningAutomations.get(automationId);
        if (!automation) {
            throw new Error('Setup session not found');
        }

        try {
            // Try to save the browser state
            const context = automation.page.context();
            await context.storageState({ 
                path: path.join(this.profilesPath, 'storage.json') 
            });

            // Save setup status
            await this.saveConfig({
                isConfigured: true,
                lastLogin: new Date().toISOString()
            });

            this.updateAutomationStatus(automation, {
                message: 'Setup completed successfully',
                progress: 100,
                status: 'completed'
            });

            // Cleanup immediately
            await this.cleanupAutomation(automationId);

        } catch (error) {
            console.error('Complete setup error:', error);
            // Cleanup immediately on error
            await this.cleanupAutomation(automationId);
            throw error;
        }
    }

    private async handleLoginRequired(triggeringAutomationId?: string) {
        console.log('\n=== Starting handleLoginRequired ===');
        console.log('Triggering Automation ID:', triggeringAutomationId);
        console.log('Current isReauthenticating state:', this.isReauthenticating);
        console.log('Current pending automations:', this.pendingAutomations);

        if (this.isReauthenticating) {
            console.log('Already re-authenticating, waiting for completion...');
            // If already reauthorizing, just wait for it to complete
            await new Promise<void>((resolve, reject) => {
                const checkReauth = () => {
                    if (!this.isReauthenticating) {
                        console.log('Re-authentication completed while waiting');
                        resolve();
                    } else {
                        setTimeout(checkReauth, 1000);
                    }
                };
                setTimeout(checkReauth, 1000);
                // Timeout after 5 minutes
                setTimeout(() => reject(new Error('Reauth wait timeout')), 300000);
            });
            return;
        }
        this.isReauthenticating = true;

        try {
            // Store the triggering automation's details before cleanup
            let triggeringAutomation: PendingAutomation | undefined;
            
            // Pause all other running automations
            for (const [id, automation] of this.runningAutomations.entries()) {
                if (id === triggeringAutomationId) {
                    // Store details of the triggering automation
                    console.log('\nFetching triggering automation details...');
                    console.log('Found automation:', automation.status);
                    
                    if (automation) {
                        console.log('\nCreating original request from automation details:');
                        console.log('Status details:', automation.status.details);
                        
                        // Get the original request from the automation details
                        const originalRequest = {
                            type: 'createListing' as const,
                            params: {
                                sku: automation.status.details?.sku,
                                asin: automation.status.details?.asin,
                                price: automation.status.details?.price,
                                condition: automation.status.details?.condition as "Used - Like New" | "Used - Very Good" | "Used - Good" | "Used - Acceptable",
                                conditionNotes: automation.status.details?.conditionNotes
                            }
                        };

                        console.log('Created original request:', originalRequest);

                        triggeringAutomation = {
                            request: originalRequest,
                            startTime: Date.now(),
                            retryCount: 0,
                            originalId: triggeringAutomationId
                        };

                        console.log('\nCreated triggering automation:', triggeringAutomation);
                        
                        // Clean up only the triggering automation
                        await this.cleanupAutomation(id);
                    }
                } else {
                    // Pause other automations
                    console.log(`Pausing automation ${id}...`);
                    this.updateAutomationStatus(automation, {
                        status: 'paused',
                        message: 'Paused for re-authentication...'
                    });
                }
            }

            // Add only the triggering automation to pending automations if it exists
            if (triggeringAutomation) {
                console.log('\nAdding triggering automation to pending list');
                this.pendingAutomations = [triggeringAutomation];
                console.log('Current pending automations:', this.pendingAutomations);
            }

            // Create popup window
            const popup = new BrowserWindow({
                width: 400,
                height: 200,
                frame: false,
                resizable: false,
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

            // Position window in center of screen
            popup.center();
            
            // Show window once it's ready
            popup.once('ready-to-show', () => {
                popup.show();
            });

            // Create the HTML content inline
            const htmlContent = `
                <!DOCTYPE html>
                <html>
                <head>
                    <style>
                        body {
                            margin: 0;
                            padding: 0;
                            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
                            background-color: white;
                            overflow: hidden;
                            user-select: none;
                            -webkit-app-region: drag;
                        }

                        header {
                            width: 100%;
                            text-align: left;
                            padding: 0.5rem;
                            box-sizing: border-box;
                            background-color: #0495F6;
                            display: flex;
                            justify-content: space-between;
                            align-items: center;
                        }

                        .title {
                            color: white;
                            font-size: 14px;
                            margin-left: 3rem;
                            font-weight: 500;
                        }

                        .window-controls {
                            display: flex;
                            gap: 0.25rem;
                            -webkit-app-region: no-drag;
                        }

                        .window-controls button {
                            all: unset;
                            border-radius: 50%;
                            width: 1rem;
                            height: 1rem;
                            cursor: pointer;
                        }

                        #close {
                            background-color: red;
                        }

                        #minimize {
                            background-color: yellow;
                        }

                        .content {
                            padding: 1.5rem;
                            text-align: center;
                        }

                        .message {
                            color: #333;
                            font-size: 14px;
                            margin-bottom: 1.5rem;
                            line-height: 1.4;
                        }

                        .buttons {
                            display: flex;
                            gap: 1rem;
                            justify-content: center;
                            -webkit-app-region: no-drag;
                        }

                        .button {
                            padding: 0.75rem 1.5rem;
                            border-radius: 0.5rem;
                            border: none;
                            font-size: 14px;
                            font-weight: 500;
                            cursor: pointer;
                            transition: background-color 0.2s;
                        }

                        .primary {
                            background-color: #0495F6;
                            color: white;
                        }

                        .primary:hover {
                            background-color: #0378cc;
                        }

                        .secondary {
                            background-color: #f5f5f5;
                            color: #333;
                        }

                        .secondary:hover {
                            background-color: #e5e5e5;
                        }

                        .state {
                            display: none;
                        }

                        .state.active {
                            display: block;
                        }
                    </style>
                </head>
                <body>
                    <header>
                        <div class="window-controls">
                            <button id="close"></button>
                            <button id="minimize"></button>
                        </div>
                        <span class="title">Amazon Seller Central Login</span>
                        <div style="width: 3rem"></div>
                    </header>
                    
                    <!-- Initial Login State -->
                    <div id="login-state" class="state content active">
                        <p class="message">
                            Your Amazon Seller Central session has expired.<br>
                            Please log in again to continue.
                        </p>
                        <div class="buttons">
                            <button class="button primary" id="login">Login Now</button>
                            <button class="button secondary" id="cancel">Cancel</button>
                        </div>
                    </div>

                    <!-- Completion State -->
                    <div id="completion-state" class="state content">
                        <p class="message">
                            Please complete your login in the browser window.<br>
                            Click "Done" when you have finished logging in.
                        </p>
                        <div class="buttons">
                            <button class="button primary" id="done">Done</button>
                            <button class="button secondary" id="cancel-login">Cancel</button>
                        </div>
                    </div>

                    <script>
                        try {
                            const electron = require('electron');
                            const { ipcRenderer } = electron;

                            // Add error logging
                            window.onerror = function(message, source, lineno, colno, error) {
                                console.error('Error:', message, 'at', source, ':', lineno);
                                if (error) console.error(error);
                            };

                            // State management
                            let currentState = 'login';
                            
                            function showState(state) {
                                document.getElementById('login-state').classList.remove('active');
                                document.getElementById('completion-state').classList.remove('active');
                                document.getElementById(\`\${state}-state\`).classList.add('active');
                                currentState = state;
                            }

                            // Listen for state change from main process
                            ipcRenderer.on('change-state', (_, state) => {
                                showState(state);
                            });

                            // Window controls
                            document.getElementById('close').addEventListener('click', () => {
                                ipcRenderer.send('reauth-response', 'cancel');
                            });

                            document.getElementById('minimize').addEventListener('click', () => {
                                ipcRenderer.send('minimize-reauth');
                            });

                            // Login state buttons
                            document.getElementById('login').addEventListener('click', () => {
                                ipcRenderer.send('reauth-response', 'login');
                                showState('completion');
                            });

                            document.getElementById('cancel').addEventListener('click', () => {
                                ipcRenderer.send('reauth-response', 'cancel');
                            });

                            // Completion state buttons
                            document.getElementById('done').addEventListener('click', () => {
                                ipcRenderer.send('reauth-response', 'done');
                            });

                            document.getElementById('cancel-login').addEventListener('click', () => {
                                ipcRenderer.send('reauth-response', 'cancel');
                            });
                        } catch (error) {
                            console.error('Script initialization error:', error);
                        }
                    </script>
                </body>
                </html>
            `;

            // Load the HTML content directly
            popup.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);

            // Handle window minimize
            ipcMain.once('minimize-reauth', () => {
                popup.minimize();
            });

            // Wait for user response
            return new Promise<void>((resolve, reject) => {
                let browserLaunched = false;

                ipcMain.once('reauth-response', async (_event, response) => {
                    switch (response) {
                        case 'login':
                            try {
                                browserLaunched = true;
                                await this.startReauthentication(popup);
                                resolve();
                            } catch (error) {
                                popup.close();
                                reject(error);
                            }
                            break;
                        case 'done':
                            popup.close();
                            resolve();
                            break;
                        case 'cancel':
                            popup.close();
                            this.pendingAutomations = [];
                            this.isReauthenticating = false;
                            reject(new Error('Authentication cancelled'));
                            break;
                    }
                });

                popup.on('closed', () => {
                    if (this.isReauthenticating && !browserLaunched) {
                        this.pendingAutomations = [];
                        this.isReauthenticating = false;
                        reject(new Error('Authentication cancelled'));
                    }
                });
            });
        } catch (error) {
            log.error('Failed to handle login required:', error);
            this.isReauthenticating = false;
            throw error;
        }
    }

    private async startReauthentication(popup: BrowserWindow) {
        try {
            // Launch visible browser for login
            this.authBrowser = await firefox.launch({
                headless: false,
                firefoxUserPrefs: {
                    'browser.sessionstore.resume_from_crash': false,
                    'browser.sessionstore.max_resumed_crashes': 0
                }
            });

            const context = await this.authBrowser.newContext({
                userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:122.0) Gecko/20100101 Firefox/122.0',
                viewport: { width: 1500, height: 900 },
                screen: { width: 1500, height: 900 }
            });

            const page = await context.newPage();
            
            // Navigate to Seller Central
            await page.goto('https://sellercentral.amazon.com/');

            try {
                // Wait for navigation to home page after login
                await page.waitForURL(url => {
                    const urlStr = url.toString();
                    return urlStr.includes('sellercentral.amazon.com') && 
                        (urlStr.includes('/home') || urlStr.includes('/dashboard') || urlStr.includes('/inventory'));
                }, { timeout: 300000 }); // 5 minute timeout

                // Save the session
                await context.storageState({ 
                    path: path.join(this.profilesPath, 'storage.json') 
                });

                // Close auth browser
                if (this.authBrowser) {
                    await this.authBrowser.close().catch(e => log.error('Error closing auth browser:', e));
                    this.authBrowser = null;
                }

                // Update config
                await this.saveConfig({
                    isConfigured: true,
                    lastLogin: new Date().toISOString()
                });

                // Close popup if it's still open
                if (!popup.isDestroyed()) {
                    popup.close();
                }

                // Retry pending automations
                await this.retryPendingAutomations();

            } catch (error) {
                log.error('Error during login wait:', error);
                throw error;
            }

        } catch (error) {
            // Ensure cleanup happens even on error
            if (this.authBrowser) {
                await this.authBrowser.close().catch(e => log.error('Error closing auth browser:', e));
                this.authBrowser = null;
            }
            
            // Close popup if it's still open
            if (!popup.isDestroyed()) {
                popup.close();
            }

            log.error('Failed to start reauth:', error);
            this.isReauthenticating = false;
            throw error;
        }
    }

    private async retryPendingAutomations() {
        console.log('\n=== Starting retryPendingAutomations ===');
        console.log('Current pending automations:', this.pendingAutomations);
        
        this.isReauthenticating = false;
        
        // Process all pending automations (should only be the triggering one)
        const automations = [...this.pendingAutomations];
        
        // Clear pending automations immediately to prevent duplicates
        this.pendingAutomations = [];

        console.log('\nProcessing automations:', automations);

        // Create a map to track results by original ID
        const resultPromises = new Map<string, ReturnType<typeof this.createResolvablePromise<RunningAutomation['result']>>>();

        // Start the triggering automation
        const retryPromises = automations.map(async (pending) => {
            console.log('\nRetrying automation:', pending);
            try {
                // Create a new automation instance with a new ID
                const newId = uuidv4();
                console.log('Created new automation ID:', newId);
                
                console.log('Creating automation with request:', pending.request);
                const automation = await this.createAutomation(newId, pending.request);
                
                // Store the automation in running automations
                console.log('Setting new automation in running automations map');
                this.runningAutomations.set(newId, automation);
                
                // Run the automation
                console.log('Running automation...');
                const result = await this.runAutomation(automation, pending.request);
                console.log('Automation result:', result);
                
                // If this automation had an original ID, store the result
                if (pending.originalId) {
                    console.log('Storing result for original ID:', pending.originalId);
                    this.completedResults.set(pending.originalId, result);
                    // Resolve the promise for this original ID
                    const resolver = resultPromises.get(pending.originalId);
                    if (resolver) {
                        console.log('Resolving promise for original ID');
                        resolver.resolve(result);
                    }
                }
                
                return { success: true, id: newId, originalId: pending.originalId };
            } catch (error) {
                console.error('Failed to retry automation:', error);
                
                // If this automation had an original ID, store the error
                if (pending.originalId) {
                    const errorResult = {
                        error: error instanceof Error ? error.message : 'Unknown error occurred'
                    };
                    console.log('Storing error result for original ID:', pending.originalId);
                    this.completedResults.set(pending.originalId, errorResult);
                    // Reject the promise for this original ID
                    const resolver = resultPromises.get(pending.originalId);
                    if (resolver) {
                        console.log('Rejecting promise for original ID');
                        resolver.reject(error instanceof Error ? error : new Error('Unknown error occurred'));
                    }
                }
                return { success: false, error, id: null, originalId: pending.originalId };
            }
        });

        // Wait for all retries to complete
        console.log('\nWaiting for retry promises to complete...');
        const results = await Promise.allSettled(retryPromises);
        console.log('Retry results:', results);

        // Resume all paused automations
        console.log('\nResuming paused automations...');
        for (const [id, automation] of this.runningAutomations.entries()) {
            if (automation.status.status === 'paused') {
                console.log(`Resuming automation ${id}...`);
                this.updateAutomationStatus(automation, {
                    status: 'running',
                    message: 'Resuming after re-authentication...'
                });
            }
        }
    }

    // Helper method to create a promise with external resolve/reject
    private createResolvablePromise<T>(): { 
        promise: Promise<T>, 
        resolve: (value: T) => void, 
        reject: (error: Error) => void 
    } {
        let resolve!: (value: T) => void;
        let reject!: (error: Error) => void;
        const promise = new Promise<T>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        return { promise, resolve, reject };
    }

    async startAutomation(request: AutomationRequest): Promise<string> {
        // If we're re-authenticating, queue the request
        if (this.isReauthenticating) {
            this.pendingAutomations.push({
                request,
                startTime: Date.now(),
                retryCount: 0
            });
            return 'pending-auth';
        }

        const id = uuidv4();

        try {
            const automation = await this.createAutomation(id, request);
            this.runningAutomations.set(id, automation);
            
            // Set up timeout
            this.setupAutomationTimeout(automation);
            
            // Start the automation and handle re-auth if needed
            try {
                // Wait for the automation to complete and get the result
                const result = await this.runAutomation(automation, request);
                
                // Store the result
                automation.result = result;
                
                // Return the ID - the result will be available via getAutomationResult
                return id;
            } catch (error: any) {
                // Check if it's a login issue
                if (error.message.includes('Login required') || 
                    automation.page.url().includes('signin')) {
                    
                    // Clean up the current automation
                    await this.cleanupAutomation(automation.id);
                    
                    // Add to pending automations
                    this.pendingAutomations.push({
                        request,
                        startTime: Date.now(),
                        retryCount: 0
                    });

                    // Handle login required - this will retry the automation after successful login
                    await this.handleLoginRequired(automation.id);
                } else {
                    // For non-auth errors, update status and cleanup
                    this.updateAutomationStatus(automation, {
                        status: 'error',
                        message: error.message
                    });
                    await this.cleanupAutomation(automation.id);
                    throw error;
                }
            }

            return id;
        } catch (error) {
            log.error('Failed to start automation:', error);
            throw error;
        }
    }

    private async createAutomation(id: string, request: AutomationRequest): Promise<RunningAutomation> {
        const browser = await firefox.launch({
            headless: false,
            firefoxUserPrefs: {
                'dom.webdriver.enabled': false,
                'privacy.trackingprotection.enabled': false,
                'network.cookie.cookieBehavior': 0,
                'geo.provider.network.url': 'https://location.services.mozilla.com/v1/geolocate?key=%MOZILLA_API_KEY%',
                'geo.provider.use_gpsd': false,
                'geo.provider.use_geoclue': false,
                'intl.accept_languages': 'en-US, en',
                'privacy.resistFingerprinting': false,
                'webgl.disabled': false,
                'dom.storage.enabled': true,
                'dom.indexedDB.enabled': true,
                // Keep existing performance optimizations
                'browser.cache.disk.enable': false,
                'browser.cache.memory.enable': true,
                'browser.cache.memory.capacity': 524288,
                'browser.sessionhistory.max_entries': 0,
                'network.http.max-persistent-connections-per-server': 10,
                'network.http.max-connections': 50,
                'content.notify.interval': 500000,
                'content.switch.threshold': 250000,
                'nglayout.initialpaint.delay': 0,
                'dom.ipc.processCount': 1,
                'javascript.options.mem.gc_incremental_slice_ms': 1,
                // Add aggressive startup optimizations
                'browser.startup.homepage': 'about:blank',
                'browser.startup.page': 0,
                'browser.sessionstore.enabled': false,
                'extensions.enabledScopes': 0,
                'security.fileuri.strict_origin_policy': false,
                'browser.shell.checkDefaultBrowser': false,
                'browser.newtabpage.enabled': false,
                'browser.newtab.preload': false,
                'browser.aboutConfig.showWarning': false,
                'gfx.canvas.accelerated': false,
                'layers.acceleration.disabled': true,
                'media.hardware-video-decoding.enabled': false,
                'network.dns.disableIPv6': true,
                'network.proxy.type': 0,
                'permissions.default.geo': 2,
                'dom.serviceWorkers.enabled': false,
                'dom.push.enabled': false,
                'browser.download.manager.retention': 0,
                'browser.helperApps.deleteTempFileOnExit': true,
                'browser.uitour.enabled': false,
                'toolkit.telemetry.enabled': false,
                'browser.ping-centre.telemetry': false,
                'browser.discovery.enabled': false
            }
        });

        const context = await browser.newContext({
            storageState: path.join(this.profilesPath, 'storage.json'),
            viewport: { width: 1500, height: 900 },
            screen: { width: 1500, height: 900 }
        });

        const page = await context.newPage();
        
        // Set zoom level to zoom out (0.67 = ~67% zoom)

        return {
            id,
            browser,
            page,
            status: {
                id,
                status: 'running',
                progress: 0,
                details: {
                    sku: request.params?.sku,
                    asin: request.params?.asin
                }
            }
        };
    }

    private async runAutomation(automation: RunningAutomation, request: AutomationRequest): Promise<RunningAutomation['result']> {
        try {
            let result: RunningAutomation['result'];
            
            switch (request.type) {
                case 'inventory':
                    await this.handleInventory(automation);
                    result = {}; // No specific result for inventory
                    break;
                case 'orders':
                    await this.handleOrders(automation);
                    result = {}; // No specific result for orders
                    break;
                case 'createListing':
                    const listingResult = await this.handleCreateListing(automation, request.params);
                    result = { fnsku: listingResult.fnsku };
                    break;
                default:
                    throw new Error('Unknown automation type');
            }

            this.updateAutomationStatus(automation, {
                status: 'completed',
                progress: 100
            });

            // Store the result in both places
            automation.result = result;
            this.completedResults.set(automation.id, result);
            
            // Cleanup old results periodically
            this.cleanupCompletedResults();

            return result;

        } catch (error) {
            log.error('Automation failed', error);
            this.updateAutomationStatus(automation, {
                status: 'error',
                message: error instanceof Error ? error.message : 'Unknown error occurred'
            });
            
            const errorResult = { error: error instanceof Error ? error.message : 'Unknown error occurred' };
            // Store error result in both places
            automation.result = errorResult;
            this.completedResults.set(automation.id, errorResult);
            
            // Cleanup old results periodically
            this.cleanupCompletedResults();
            
            return errorResult;
        } finally {
            // Cleanup after result is handled
            await this.cleanupAutomation(automation.id);
        }
    }

    private async handleInventory(automation: RunningAutomation) {
        // TODO: Implement inventory automation
    }

    private async handleOrders(automation: RunningAutomation) {
        // TODO: Implement orders automation
    }

    // Utility function for printing with unix-print
    private async printPDFUnix(pdfPath: string, printerName?: string, options: string[] = []): Promise<boolean> {
        try {
            log.info('Printing PDF:', pdfPath);
            log.info('Printer:', printerName || 'default');
            log.info('Options:', options);

            const printJob = await print(pdfPath, printerName, options);
            
            // Wait for print completion
            while (!await isPrintComplete(printJob)) {
                await new Promise(resolve => setTimeout(resolve, 500)); // Check every 500ms
            }

            log.info('Print completed successfully');
            return true;
        } catch (error) {
            log.error('Print failed:', error);
            return false;
        }
    }

    private async handleCreateListing(automation: RunningAutomation, params?: AutomationRequest['params']): Promise<{ fnsku: string }> {
        console.log('\n=== Starting handleCreateListing ===');
        console.log('Automation:', automation.id);
        console.log('Params:', params);

        if (!params?.asin || !params?.sku || !params?.price) {
            console.error('Missing required parameters:', {
                asin: params?.asin,
                sku: params?.sku,
                price: params?.price
            });
            throw new Error('Missing required parameters for listing creation');
        }

        const { page } = automation;

        try {
            this.updateAutomationStatus(automation, {
                message: 'Navigating to listing creation page...',
                progress: 20,
                details: {
                    ...automation.status.details,
                    ...params
                }
            });

            console.log('\nNavigating to listing page...');
            // Navigate to the listing creation page
            await page.goto(`https://sellercentral.amazon.com/abis/listing/syh/offer?asin=${params.asin}`, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });

            console.log('Current URL:', page.url());

            // Check if we're on a login page immediately
            const isLoginPage = page.url().includes('signin') || 
                              await page.locator('input[type="password"]').count() > 0;
            
            console.log('Is login page:', isLoginPage);
            
            if (isLoginPage) {
                console.log('\nDetected login page, starting re-authentication...');
                // Handle login and wait for it to complete, passing this automation's ID
                await this.handleLoginRequired(automation.id);
                
                // The automation will be retried by retryPendingAutomations
                // We need to wait for the result of the retried automation
                const retriedResult = await new Promise<{ fnsku: string }>((resolve, reject) => {
                    const maxWaitTime = 300000; // 5 minutes
                    const startTime = Date.now();
                    
                    const checkResult = async () => {
                        // Check if we've exceeded wait time
                        if (Date.now() - startTime > maxWaitTime) {
                            reject(new Error('Timed out waiting for automation result'));
                            return;
                        }

                        // Check completed results for any matching FNSKU
                        const result = this.completedResults.get(automation.id);
                        if (result && 'fnsku' in result && result.fnsku) {
                            resolve({ fnsku: result.fnsku });
                            return;
                        } else if (result && 'error' in result) {
                            reject(new Error(result.error || 'Unknown error occurred'));
                            return;
                        }

                        // Check again in 1 second if no result found
                        setTimeout(checkResult, 1000);
                    };

                    // Start checking
                    checkResult();
                });

                return retriedResult;
            }

            this.updateAutomationStatus(automation, {
                message: 'Filling listing details...',
                progress: 50
            });

            try {
                // Try multiple selectors in case one fails
                await page.locator('kat-radiobutton[name="attribute_filter_radio_buttons-all"]').click(),
                // Small wait to ensure the UI updates
                await page.waitForTimeout(100);
            } catch (error) {
                log.error('Warning: Failed to click All attributes radio button:', error);
                // Continue anyway as this might not be critical
            }

            // Fill form fields
            await page.getByRole('textbox', { name: 'Seller SKU' }).fill(params.sku);
            await page.getByRole('textbox', { name: 'Your Price' }).fill(params.price.toString());

            // Check if List Price field exists before filling it
            const listPriceField = page.getByRole('textbox', { name: 'List Price' });
            if (await listPriceField.isVisible()) {
                await listPriceField.fill((params.price * 1.5).toString());
            }

            await page.evaluate(() => {
                window.scrollBy(0, 800);
            });
            await new Promise(resolve => setTimeout(resolve, 100));
            // Set condition if provided    
            if (params.condition) {
                // First click the condition dropdown (specifically the second one)
                const dropdowns = page.locator('div[part="dropdown-header"]');
                const secondDropdown = dropdowns.nth(1);  // Get the second dropdown
                await secondDropdown.click();
                await new Promise(resolve => setTimeout(resolve, 100));

                // Then find and click the condition option
                const option = page.locator(`[role="option"]:has-text("${params.condition}")`);
                await option.click();
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            // Fill condition notes if provided
            console.log('Condition Notes:', params.conditionNotes);
            if (params.conditionNotes) {
                console.log('Filling condition notes');
                await page.getByRole('textbox', { name: 'Condition Note' }).click();
                await page.getByRole('textbox', { name: 'Condition Note' }).fill(params.conditionNotes);
            }

            this.updateAutomationStatus(automation, {
                message: 'Submitting listing...',
                progress: 75
            });

            // Submit the listing
            await page.getByRole('button', { name: 'Save and finish' }).click();
      
            // Wait for the Convert button to be clickable
            await page.getByTestId('button-label-for-SC_FBA_LFBA_1_PAGE_LIST_AS_FBA_BUTTON_CONVERTANDSEND').waitFor({ state: 'visible' });
            await page.getByTestId('button-label-for-SC_FBA_LFBA_1_PAGE_LIST_AS_FBA_BUTTON_CONVERTANDSEND').click();

            console.log('Getting FNSKU...');
            const fnskuElement = page.getByTestId('fnsku');
            const fnsku = await fnskuElement.textContent();
            const fnskuValue = fnsku?.match(/X0[A-Z0-9]{8}/)?.[0];
            console.log('Listing created successfully FNSKU:', fnskuValue);
            if (!fnskuValue) {
                throw new Error('Could not extract valid FNSKU from page');
            }

            // Store the result immediately with the non-null FNSKU
            const result = { fnsku: fnskuValue };
            automation.result = result;

            // Start label generation and printing in the background
       /*    this.handleLabelPrinting(automation, fnskuValue, params).catch(error => {
                log.error('Error in background label printing:', error);
            });*/
            await this.cleanupAutomation(automation.id);

            // Return the result immediately with the non-null FNSKU
            return result;

        } catch (error) {
            console.error('Error in listing creation:', error);
            if (!page.isClosed()) {
                await page.screenshot({ path: path.join(this.profilesPath, `error_${Date.now()}.png`) });
            }
            // Set the error in automation.result for tracking
            automation.result = { error: error instanceof Error ? error.message : 'Unknown error occurred' };
            throw error;
        }
    }

    // New method to handle label printing in the background
    private async handleLabelPrinting(automation: RunningAutomation, fnsku: string, params: NonNullable<AutomationRequest['params']>) {
        try {
            this.updateAutomationStatus(automation, {
                message: 'Generating and printing label...',
                progress: 90
            });

            // Get current print settings for label size
            const printers = await this.mainWindow.webContents.getPrintersAsync();
            const defaultPrinter = printers.find(p => p.isDefault);

            // Now we know params exists and has the required properties
            const labelPath = await generateLabel({
                fnsku,
                sku: params.sku!,
                asin: params.asin!,
                condition: params.condition,
                labelSize: this.printSettings?.labelSize || 'STANDARD' // Use configured size or default to STANDARD
            });

            // Print using unix-print
            const success = await this.printPDFUnix(labelPath, this.printerName, [
                '-o fit-to-page',
                '-o nocolor',
                '-n 1'
            ]);

            if (!success) {
                this.updateAutomationStatus(automation, {
                    message: 'Warning: Label printing failed, but listing was created successfully.',
                    progress: 100
                });
                return;
            }

            this.updateAutomationStatus(automation, {
                message: `Successfully created listing with FNSKU: ${fnsku}`,
                progress: 100,
                status: 'completed'
            });

        } catch (error) {
            log.error('Label printing failed:', error);
            this.updateAutomationStatus(automation, {
                message: 'Warning: Label printing failed, but listing was created successfully.',
                progress: 100,
                status: 'completed'
            });
        } finally {
            // Clean up the automation after printing is done
            await this.cleanupAutomation(automation.id);
        }
    }

    // Update the get result method to check both places
    async getAutomationResult(id: string): Promise<RunningAutomation['result'] | null> {
        log.info('Getting automation result', { id });
        
        // First check running automations
        const automation = this.runningAutomations.get(id);
        if (automation?.result) {
            log.info('Found result in running automation', { 
                id,
                result: automation.result
            });
            return automation.result;
        }

        // Then check completed results
        const completedResult = this.completedResults.get(id);
        if (completedResult) {
            log.info('Found result in completed results', {
                id,
                result: completedResult
            });
            return completedResult;
        }

        log.info('No result found for automation', { id });
        return null;
    }

    private cleanupCompletedResults() {
        const now = Date.now();
        let count = 0;
        
        // Convert to array for easier filtering
        const entries = Array.from(this.completedResults.entries());
        
        // Keep only recent results and within max limit
        const validEntries = entries
            .filter(([_, result]) => {
                count++;
                // Keep if within TTL and max count
                return count < this.MAX_COMPLETED_RESULTS;
            });
        
        // Clear and rebuild map
        this.completedResults.clear();
        validEntries.forEach(([id, result]) => {
            this.completedResults.set(id, result);
        });
    }

    getPrinterName(): string {
        return this.printerName;
    }

    // Add a method to get print settings
    getPrintSettings(): PrintSettings {
        return this.printSettings;
    }

    // Add a method to update print settings
    setPrintSettings(settings: PrintSettings) {
        this.printSettings = settings;
        this.printerName = settings.printer;
    }
}

export function createAutomationManager(mainWindow: BrowserWindow) {
    return new AutomationManager(mainWindow);
} 