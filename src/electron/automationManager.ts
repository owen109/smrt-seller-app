import { firefox, Browser, Page } from 'playwright';
import path from 'path';
import { app } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { ipcWebContentsSend, execPromise } from './util.js';
import { BrowserWindow } from 'electron';
import fs from 'fs/promises';
import { existsSync } from 'fs';
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
    private settingsPath: string;
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
        this.settingsPath = path.join(baseDir, 'settings.json');
        
        log.info('Initializing AutomationManager', {
            baseDir,
            profilesPath: this.profilesPath,
            configPath: this.configPath,
            settingsPath: this.settingsPath,
            isPackaged: app.isPackaged,
            platform: process.platform,
            arch: process.arch,
            electronVersion: process.versions.electron,
            chromeVersion: process.versions.chrome,
            nodeVersion: process.version
        });
        
        this.initializeDirectories();
        this.loadSettings();
        this.initializePrinter();

        // Send initial active count
        this.updateActiveAutomationCount();
    }

    private async initializeDirectories() {
        try {
            log.info('Creating profile directories');
            
            // Create profiles directory
            await fs.mkdir(this.profilesPath, { recursive: true });
            
            // Create default profile directory
            const defaultProfilePath = path.join(this.profilesPath, 'default');
            await fs.mkdir(defaultProfilePath, { recursive: true });
            
            // Create storage.json if it doesn't exist
            const storagePath = path.join(this.profilesPath, 'storage.json');
            try {
                await fs.access(storagePath);
                log.info('storage.json already exists');
            } catch {
                log.info('Creating empty storage.json');
                await fs.writeFile(storagePath, JSON.stringify({
                    cookies: [],
                    origins: []
                }));
            }

            log.info('Directory initialization complete', {
                profilesPath: this.profilesPath,
                defaultProfilePath: defaultProfilePath,
                storagePath: storagePath
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

        try {
            log.info('Starting setup process', {
                id,
                defaultProfilePath,
                isPackaged: app.isPackaged,
                platform: process.platform,
                arch: process.arch,
                electronVersion: process.versions.electron,
                chromeVersion: process.versions.chrome,
                nodeVersion: process.version
            });

            // Get the correct Firefox path based on environment
            const getFirefoxPath = () => {
                if (app.isPackaged) {
                    // In production, use the bundled Firefox from resources
                    if (process.platform === 'win32') {
                        // Windows: Use the correct path structure for Windows
                        return path.join(
                            process.resourcesPath,
                            'ms-playwright',
                            'firefox-1471',
                            'firefox',
                            'firefox.exe'
                        );
                    } else {
                        // Mac/Linux: Keep existing path structure
                        return path.join(
                            app.getAppPath(),
                            '..',
                            'ms-playwright',
                            'firefox-1471',
                            'firefox',
                            process.platform === 'darwin' ? 'Nightly.app/Contents/MacOS/firefox' : 'firefox'
                        );
                    }
                }

                // In development
                if (process.platform === 'win32') {
                    // Windows development
                    return path.join(
                        process.env.APPDATA || '',
                        '..',
                        'Local',
                        'ms-playwright',
                        'firefox-1471',
                        'firefox',
                        'firefox.exe'
                    );
                }
                // Mac/Linux development: Keep existing path
                return path.join(
                    app.getPath('home'),
                    'Library',
                    'Caches',
                    'ms-playwright',
                    'firefox-1471',
                    'firefox',
                    process.platform === 'darwin' ? 'Nightly.app/Contents/MacOS/firefox' : 'firefox'
                );
            };

            const firefoxPath = getFirefoxPath();
            log.info('Using Firefox path:', [firefoxPath]);

            // Check if Firefox exists
            try {
                await fs.access(firefoxPath);
                log.info('Firefox executable found at:', firefoxPath);
            } catch (error) {
                log.error('Firefox executable not found:', error);
                throw new Error(`Firefox executable not found at ${firefoxPath}. Please ensure the application is properly installed.`);
            }

            log.info('Launching Firefox with preferences:', {
                headless: false,
                firefoxUserPrefs: {
                    'browser.sessionstore.resume_from_crash': false,
                    'browser.sessionstore.max_resumed_crashes': 0
                },
                executablePath: firefoxPath
            });

            const browser = await firefox.launch({
                headless: false,
                executablePath: firefoxPath,
                firefoxUserPrefs: {
                    'browser.sessionstore.resume_from_crash': false,
                    'browser.sessionstore.max_resumed_crashes': 0
                }
            });

            log.info('Browser launched successfully. Creating browser context...');

            const context = await browser.newContext({
                userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:122.0) Gecko/20100101 Firefox/122.0',
                viewport: { width: 1500, height: 900 },
                screen: { width: 1500, height: 900 }
            }).catch(error => {
                log.error('Failed to create browser context:', error);
                throw new Error(`Context creation failed: ${error.message}`);
            });

            log.info('Browser context created successfully. Creating new page...');

            const page = await context.newPage().catch(error => {
                log.error('Failed to create new page:', error);
                throw new Error(`Page creation failed: ${error.message}`);
            });
            
            log.info('New page created successfully');
            
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
            log.info('Automation registered with ID:', id);
            
            try {
                this.updateAutomationStatus(automation, {
                    message: 'Opening Amazon Seller Central...',
                    progress: 20
                });

                log.info('Navigating to Amazon Seller Central...');
                await page.goto('https://sellercentral.amazon.com/', {
                    waitUntil: 'domcontentloaded',
                    timeout: 30000
                }).catch(error => {
                    log.error('Failed to navigate to Amazon:', error);
                    throw new Error(`Navigation failed: ${error.message}`);
                });
                
                log.info('Successfully loaded Amazon Seller Central');
                
                this.updateAutomationStatus(automation, {
                    message: 'Please log in to Seller Central. Setup will complete automatically...',
                    progress: 50
                });

                log.info('Waiting for successful login and navigation...');
                // Wait for navigation to home page after login
                await page.waitForURL(url => {
                    const urlStr = url.toString();
                    const isValidUrl = urlStr.includes('sellercentral.amazon.com') && 
                        (urlStr.includes('/home') || urlStr.includes('/dashboard') || urlStr.includes('/inventory'));
                    log.info('URL check:', { url: urlStr, isValid: isValidUrl });
                    return isValidUrl;
                }, { timeout: 300000 }); // 5 minute timeout

                log.info('Login successful, saving browser state...');
                // Save the browser state
                await context.storageState({ 
                    path: path.join(this.profilesPath, 'storage.json') 
                }).catch(error => {
                    log.error('Failed to save browser state:', error);
                    throw new Error(`State save failed: ${error.message}`);
                });

                log.info('Browser state saved successfully');

                // Save setup status
                await this.saveConfig({
                    isConfigured: true,
                    lastLogin: new Date().toISOString()
                });

                log.info('Setup completed successfully');

                this.updateAutomationStatus(automation, {
                    message: 'Setup completed successfully! You can now close this window.',
                    progress: 100,
                    status: 'completed'
                });

                // Wait a brief moment for the user to see the success message
                await new Promise(resolve => setTimeout(resolve, 2000));

                // Cleanup and close browser
                await this.cleanupAutomation(id);

                return id;

            } catch (error) {
                log.error('Setup process error:', error);
                const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
                
                if (this.runningAutomations.has(id)) {
                    this.updateAutomationStatus(automation, {
                        status: 'error',
                        message: `Setup failed: ${errorMessage}. Check if Firefox is installed and up to date.`
                    });
                }
                
                await this.cleanupAutomation(id);
                throw error;
            }
        } catch (error) {
            log.error('Critical setup error:', error);
            throw new Error(`Setup failed: ${error instanceof Error ? error.message : 'Unknown error occurred'}. Please ensure Firefox is installed and up to date.`);
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

                // Make sure we've stored the result before closing the browser
                if (automation.result && !this.completedResults.has(id)) {
                    log.info('Storing result before cleanup', { id, result: automation.result });
                    this.completedResults.set(id, automation.result);
                }

                // Check if browser is still connected
                if (!automation.browser.isConnected()) {
                    log.info('Browser already disconnected', { id });
                    this.runningAutomations.delete(id);
                    this.updateActiveAutomationCount();
                    return;
                }
                
                // Close browser with retry logic
                let retries = 3;
                while (retries > 0) {
                    try {
                        await automation.browser.close();
                        log.info('Successfully closed browser', { id });
                        break;
                    } catch (e) {
                        retries--;
                        if (retries === 0) {
                            log.error('Failed to close browser after multiple attempts:', e);
                        } else {
                            log.info(`Error closing browser, retrying (${retries} attempts left):`, e);
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                    }
                }
                
                log.info('Successfully cleaned up automation', { id });
            } catch (error) {
                log.error('Error during cleanup:', error);
                // Even if cleanup fails, make sure we store the result
                if (automation.result && !this.completedResults.has(id)) {
                    log.info('Storing result after cleanup error', { id, result: automation.result });
                    this.completedResults.set(id, automation.result);
                }
            } finally {
                this.runningAutomations.delete(id);
                this.updateActiveAutomationCount();
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
                frame: true,  // Enable window frame
                resizable: false,
                alwaysOnTop: true,
                skipTaskbar: false,
                webPreferences: {
                    nodeIntegration: true,
                    contextIsolation: false,
                    webSecurity: false
                },
                backgroundColor: '#ffffff',
                show: false,
                title: 'Re-authentication Required'  // Add window title
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
                            padding: 2rem;
                            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
                            background-color: white;
                            overflow: hidden;
                        }

                        .content {
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
                        }

                        .button {
                            padding: 0.75rem 1.5rem;
                            border-radius: 0.5rem;
                            border: none;
                            font-size: 14px;
                            font-weight: 500;
                            cursor: pointer;
                            transition: background-color 0.2s;
                            min-width: 120px;
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
                            min-width: 140px;
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

                    <!-- Loading State -->
                    <div id="loading-state" class="state content">
                        <p class="message">
                            Please complete your login in the browser window.<br>
                            The process will continue automatically once you're logged in.
                        </p>
                        <div class="buttons">
                            <button class="button secondary" id="cancel-login">Cancel</button>
                        </div>
                    </div>

                    <script>
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
                            document.getElementById('loading-state').classList.remove('active');
                            document.getElementById(\`\${state}-state\`).classList.add('active');
                            currentState = state;
                        }

                        // Listen for state change from main process
                        ipcRenderer.on('change-state', (_, state) => {
                            showState(state);
                        });

                        // Login state buttons
                        document.getElementById('login').addEventListener('click', () => {
                            ipcRenderer.send('reauth-response', 'login');
                            showState('loading');
                        });

                        document.getElementById('cancel').addEventListener('click', () => {
                            ipcRenderer.send('reauth-response', 'cancel');
                        });

                        // Loading state buttons
                        document.getElementById('cancel-login').addEventListener('click', () => {
                            ipcRenderer.send('reauth-response', 'cancel');
                        });
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
            // Get Firefox path using the same method as initial setup
            const firefoxPath = this.getFirefoxPath();
            console.log('Using Firefox path for reauth:', firefoxPath);

            // Launch visible browser for login with the correct Firefox path
            this.authBrowser = await firefox.launch({
                headless: false,
                executablePath: firefoxPath,
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
            this.updateActiveAutomationCount();
            
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
        const browser = await this.launchBrowser({
            firefoxUserPrefs: {
                'dom.webdriver.enabled': false,
                'privacy.trackingprotection.enabled': false,
                'network.cookie.cookieBehavior': 0,
                'intl.accept_languages': 'en-US, en',
                'privacy.resistFingerprinting': false,
                'browser.cache.disk.enable': false,
                'browser.cache.memory.enable': true,
                'browser.sessionhistory.max_entries': 0,
                'dom.ipc.processCount': 1
            }
        });

        const context = await this.createBrowserContext(browser);
        const page = await context.newPage();

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

    private async launchBrowser(options: any = {}): Promise<Browser> {
        const firefoxPath = this.getFirefoxPath();
        
        try {
            await fs.access(firefoxPath);
            log.info('Firefox executable found at:', firefoxPath);
        } catch (error) {
            log.error('Firefox executable not found:', error);
            throw new Error(`Firefox executable not found at ${firefoxPath}. Please ensure the application is properly installed.`);
        }

        const browser = await firefox.launch({
            headless: true,
            executablePath: firefoxPath,
            firefoxUserPrefs: {
                'browser.sessionstore.resume_from_crash': false,
                'browser.sessionstore.max_resumed_crashes': 0,
                'browser.shell.checkDefaultBrowser': false,
                'browser.startup.homepage': 'about:blank',
                ...options.firefoxUserPrefs
            },
            ...options
        });

        return browser;
    }

    private getFirefoxPath(): string {
        let firefoxPath: string;
        const caller = new Error().stack?.split('\n')[2]?.trim() || 'unknown';
        
        if (app.isPackaged) {
            // In production, use the bundled Firefox from resources
            if (process.platform === 'win32') {
                // Windows: Use the correct path structure for Windows
                firefoxPath = path.join(
                    process.resourcesPath,
                    'ms-playwright',
                    'firefox-1471',
                    'firefox',
                    'firefox.exe'
                );
            } else {
                // Mac/Linux: Keep existing path structure
                firefoxPath = path.join(
                    app.getAppPath(),
                    '..',
                    'ms-playwright',
                    'firefox-1471',
                    'firefox',
                    process.platform === 'darwin' ? 'Nightly.app/Contents/MacOS/firefox' : 'firefox'
                );
            }
        } else {
            // In development
            if (process.platform === 'win32') {
                // Windows development
                firefoxPath = path.join(
                    process.env.APPDATA || '',
                    '..',
                    'Local',
                    'ms-playwright',
                    'firefox-1471',
                    'firefox',
                    'firefox.exe'
                );
            } else {
                // Mac/Linux development: Keep existing path
                firefoxPath = path.join(
                    app.getPath('home'),
                    'Library',
                    'Caches',
                    'ms-playwright',
                    'firefox-1471',
                    'firefox',
                    process.platform === 'darwin' ? 'Nightly.app/Contents/MacOS/firefox' : 'firefox'
                );
            }
        }

        log.info('Getting Firefox path:', {
            caller,
            isPackaged: app.isPackaged,
            platform: process.platform,
            resourcesPath: app.isPackaged ? process.resourcesPath : 'n/a',
            appPath: app.getAppPath(),
            firefoxPath,
            exists: existsSync(firefoxPath)
        });

        return firefoxPath;
    }

    private async createBrowserContext(browser: Browser): Promise<any> {
        const context = await browser.newContext({
            viewport: { width: 1500, height: 900 },
            screen: { width: 1500, height: 900 },
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:122.0) Gecko/20100101 Firefox/122.0',
            // Load stored state if available
            storageState: path.join(this.profilesPath, 'storage.json')
        });

        // Set up context event handlers
        context.on('page', async page => {
            page.on('console', msg => {
                const text = msg.text();
                // Filter out noisy messages
                if (!text.includes('Cookie') && 
                    !text.includes('SameSite') && 
                    !text.includes('Quirks Mode') && 
                    !text.includes('InstallTrigger') && 
                    !text.includes('onmozfullscreen') && 
                    !text.includes('downloadable font') && 
                    !text.includes('Unsatisfied version') && 
                    !text.includes('Emitting metrics') && 
                    !text.includes('lit-element') && 
                    !text.includes('Ignoring unsupported entryTypes') &&
                    !text.includes('re-reselect')) {
                    log.info('Browser console:', text);
                }
            });
            
            page.on('pageerror', error => {
                // Only log actual errors, not warnings
                if (!error.toString().toLowerCase().includes('warning')) {
                    log.error('Browser page error:', error);
                }
            });
        });

        return context;
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
            log.info('Using PDF path:', pdfPath);

            // Using lp with specific options for rotation and sizing
            const command = `lp -d "${printerName}" -o landscape -o orientation-requested=6 -o scaling=100 -o media=Custom.1x2.125in "${pdfPath}"`;
            
            log.info('Sending print job with command:', command);
            
            const { stdout, stderr } = await execPromise(command);
            
            if (stderr) {
                log.error('Print error:', stderr);
                return false;
            }
            
            log.info('Print job sent successfully!', stdout);
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

            // Select FBA fulfillment
            await page.locator('#offerFulfillment-AFN > .kat-radiobutton-icon').click();

            this.updateAutomationStatus(automation, {
                message: 'Submitting listing...',
                progress: 75
            });

            // Submit the listing
            await page.getByRole('button', { name: 'Save and finish' }).click();

            
            await page.getByTestId('button-label-for-SC_FBA_LFBA_1_PAGE_LIST_AS_FBA_BUTTON_CONVERTANDSEND').waitFor({ state: 'visible' });
            

            // Add delay and check for the popup before clicking Convert and Send
            console.log('Checking for popup before Convert and Send...');
            await page.waitForTimeout(200); // Wait 1 second
            
            // Check if popup button exists
            const popupExists = await page.getByTestId('dgq-button-link').isVisible().catch(() => false);
            if (popupExists) {
                console.log('Popup detected, handling popup...');
                await page.getByTestId('dgq-button-link').click();
                await page.getByTestId('dgq-button-link').locator('a').click();
                
                // Handle the options in the popup
                await page.locator('kat-radiobutton:nth-child(2) > .kat-radiobutton-icon').first().click();
                await page.locator('kat-radiobutton:nth-child(2) > .kat-radiobutton-icon').nth(1).click();
                await page.getByRole('button', { name: 'Submit' }).click();
                await page.getByTestId('button-label-for-SC_FBA_LFBA_1_PAGE_LIST_AS_FBA_BUTTON_CONVERTANDSEND').click();
            } else {
                console.log('No popup found, proceeding with Convert and Send...');
                await page.getByTestId('button-label-for-SC_FBA_LFBA_1_PAGE_LIST_AS_FBA_BUTTON_CONVERTANDSEND').click();
            }

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

            // Handle prep steps
            console.log('Handling prep steps...');
            try {
                // Use a flag to ensure only one action is taken
                let actionTaken = false;
                
                // Use Promise.race to try different selectors
                await Promise.race([
                    // Option 1: "sku-action-info-prep-missing-link" on page
                    page.getByTestId('sku-action-info-prep-missing-link').locator('a')
                      .waitFor({ state: 'visible', timeout: 10000 })
                      .then(async () => {
                        if (actionTaken) return;
                        actionTaken = true;
                        console.log('Found and clicking: sku-action-info-prep-missing-link');
                        await page.getByTestId('sku-action-info-prep-missing-link').locator('a').click();
                        await page.waitForTimeout(500);
                      }),
                      
                    // Option 2: "Prep information updated" link on page2
                    page.getByRole('link', { name: 'Prep information updated' })
                      .waitFor({ state: 'visible', timeout: 10000 })
                      .then(async () => {
                        if (actionTaken) return;
                        actionTaken = true;
                        console.log('Found and clicking: Prep information updated link');
                        await page.getByRole('link', { name: 'Prep information updated' }).click();
                        await page.waitForTimeout(500);
                      }),
                      
                    // Option 3: "prep-modal-link" on page2
                    page.getByTestId('prep-modal-link').locator('a')
                      .waitFor({ state: 'visible', timeout: 10000 })
                      .then(async () => {
                        if (actionTaken) return;
                        actionTaken = true;
                        console.log('Found and clicking: prep-modal-link');
                        await page.getByTestId('prep-modal-link').locator('a').click();
                        await page.waitForTimeout(500);
                      })
                ]);
                
                // If no action was taken, continue with the direct approach
                if (!actionTaken) {
                    await page.getByTestId('sku-action-info-prep-missing-link').locator('a').click();
                }
            } catch (error) {
                console.error('Error handling prep steps:', error);
                // Fallback to the direct approach if the Promise.race approach fails
                await page.getByTestId('sku-action-info-prep-missing-link').locator('a').click();
            }

            await page.waitForTimeout(200);

            // Check for prep dropdown using data-testid
            console.log('Checking for prep dropdown...');
            const prepDropdown = page.getByTestId('prep-guidance-prep-category-dropdown');
            const isDropdownVisible = await prepDropdown.isVisible();
            
            if (isDropdownVisible) {
                console.log('Found prep dropdown, clicking it...');
                await prepDropdown.click();
                await page.waitForTimeout(500);
                
                // Click "No Prep Needed" option using the value
                const noPrepOption = page.locator('kat-option[value="NONE"]');
                await noPrepOption.click();
                await page.waitForTimeout(300);
            } else {
                console.log('No prep dropdown found, continuing with save...');
            }

            // Wait for first Save button to be visible and clickable
            await page.getByRole('button', { name: 'Save' }).waitFor({ state: 'visible' });
            await page.getByRole('button', { name: 'Save' }).click();
            console.log('First Save button clicked');
            
            // Wait a moment for UI to update after first save
            await page.waitForTimeout(500);
            
            // Check if second Save button exists and is visible before clicking
            const secondSaveButton = await page.getByRole('button', { name: 'Save' });
            const hasSecondSave = await secondSaveButton.count() > 0;
            console.log('Second Save button: ', hasSecondSave);
            if (hasSecondSave) {
                await secondSaveButton.waitFor({ state: 'visible' });
                await secondSaveButton.click();
                console.log('Second Save button clicked');
            }
            await page.waitForTimeout(1200);

            // Check for missing ASIN data link
            console.log('Checking for missing ASIN data link...');
            const missingDataLink = page.getByRole('link', { name: 'Data is missing for ASIN' });
            const hasLink = await missingDataLink.count() > 0;
            if (hasLink) {
                console.log('Found missing ASIN data link, clicking it...');
                await missingDataLink.click();
                await page.waitForTimeout(1000);

                // Create popup window for dimensions input
                const popup = new BrowserWindow({
                    width: 500,
                    height: 480,
                    frame: true,  // Enable window frame
                    resizable: false,
                    alwaysOnTop: true,
                    skipTaskbar: false,
                    webPreferences: {
                        nodeIntegration: true,
                        contextIsolation: false,
                        webSecurity: false
                    },
                    backgroundColor: '#ffffff',
                    show: false,
                    title: 'Enter Product Dimensions'  // Add window title
                });

                // Position window in center of screen
                popup.center();

                // Create the HTML content for dimensions input
                const dimensionsHtmlContent = `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <style>
                            body {
                                margin: 0;
                                padding: 2rem;
                                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
                                background-color: white;
                                overflow: hidden;
                            }

                            .content {
                                text-align: center;
                            }

                            .sku-info {
                                background-color: #f5f5f5;
                                border-radius: 8px;
                                padding: 1rem;
                                margin-bottom: 1.5rem;
                                text-align: left;
                            }

                            .sku-info h2 {
                                margin: 0;
                                font-size: 14px;
                                color: #666;
                            }

                            .sku-info p {
                                margin: 0.5rem 0 0 0;
                                font-size: 16px;
                                color: #333;
                                font-weight: 500;
                            }

                            .dimensions-grid {
                                display: grid;
                                grid-template-columns: repeat(2, 1fr);
                                gap: 1rem;
                                margin-bottom: 1.5rem;
                            }

                            .input-group {
                                text-align: left;
                            }

                            .input-group label {
                                display: block;
                                margin-bottom: 0.5rem;
                                font-size: 14px;
                                color: #333;
                                font-weight: 500;
                            }

                            .input-group input {
                                width: 100%;
                                padding: 0.75rem;
                                border: 1px solid #ddd;
                                border-radius: 6px;
                                font-size: 14px;
                                box-sizing: border-box;
                            }

                            .input-group input:focus {
                                outline: none;
                                border-color: #0495F6;
                                box-shadow: 0 0 0 2px rgba(4, 149, 246, 0.1);
                            }

                            .buttons {
                                display: flex;
                                gap: 1rem;
                                justify-content: flex-end;
                                margin-top: 2rem;
                            }

                            .button {
                                padding: 0.75rem 2rem;
                                border-radius: 6px;
                                border: none;
                                font-size: 14px;
                                font-weight: 500;
                                cursor: pointer;
                                transition: all 0.2s;
                            }

                            .primary {
                                background-color: #0495F6;
                                color: white;
                            }

                            .primary:hover {
                                background-color: #0378cc;
                                transform: translateY(-1px);
                            }

                            .unit {
                                color: #666;
                                font-size: 13px;
                                margin-left: 4px;
                            }
                        </style>
                    </head>
                    <body>
                        <div class="content">
                            <div class="sku-info">
                                <h2>Product Information</h2>
                                <p>SKU: ${params?.sku || 'Unknown'}</p>
                                <p>ASIN: ${params?.asin || 'Unknown'}</p>
                            </div>

                            <div class="dimensions-grid">
                                <div class="input-group">
                                    <label>Length<span class="unit">(inches)</span></label>
                                    <input type="number" id="length" step="0.1" min="0" required placeholder="0.0">
                                </div>
                                <div class="input-group">
                                    <label>Width<span class="unit">(inches)</span></label>
                                    <input type="number" id="width" step="0.1" min="0" required placeholder="0.0">
                                </div>
                                <div class="input-group">
                                    <label>Height<span class="unit">(inches)</span></label>
                                    <input type="number" id="height" step="0.1" min="0" required placeholder="0.0">
                                </div>
                                <div class="input-group">
                                    <label>Weight<span class="unit">(lbs)</span></label>
                                    <input type="number" id="weight" step="0.1" min="0" required placeholder="0.0">
                                </div>
                            </div>

                            <div class="buttons">
                                <button class="button primary" id="submit">Save Dimensions</button>
                            </div>
                        </div>

                        <script>
                            const electron = require('electron');
                            const { ipcRenderer } = electron;

                            document.getElementById('submit').addEventListener('click', () => {
                                const dimensions = {
                                    length: document.getElementById('length').value,
                                    width: document.getElementById('width').value,
                                    height: document.getElementById('height').value,
                                    weight: document.getElementById('weight').value
                                };
                                ipcRenderer.send('dimensions-response', dimensions);
                            });

                            // Handle enter key
                            document.addEventListener('keypress', (e) => {
                                if (e.key === 'Enter') {
                                    document.getElementById('submit').click();
                                }
                            });

                            // Focus first input on load
                            window.onload = () => {
                                document.getElementById('length').focus();
                            };
                        </script>
                    </body>
                    </html>
                `;

                // Load the HTML content
                popup.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(dimensionsHtmlContent)}`);

                // Show window once it's ready
                popup.once('ready-to-show', () => {
                    popup.show();
                });

                // Handle window minimize
                ipcMain.once('minimize-dimensions', () => {
                    popup.minimize();
                });

                // Define the dimensions type
                type Dimensions = {
                    length: string;
                    width: string;
                    height: string;
                    weight: string;
                };

                // Wait for user input
                const dimensions = await new Promise<Dimensions>((resolve, reject) => {
                    ipcMain.once('dimensions-response', (_event, response: Dimensions | 'cancel') => {
                        popup.close();
                        if (response === 'cancel') {
                            reject(new Error('Dimensions input cancelled'));
                        } else {
                            resolve(response);
                        }
                    });

                    popup.on('closed', () => {
                        reject(new Error('Dimensions input cancelled'));
                    });
                });

                // Fill in the dimensions
                console.log('Filling in dimensions:', dimensions);
                await page.locator('#katal-id-181').click();
                await page.locator('#katal-id-181').fill(dimensions.length.toString());
                await page.locator('#katal-id-182').click();
                await page.locator('#katal-id-182').fill(dimensions.width.toString());
                await page.locator('#katal-id-183').click();
                await page.locator('#katal-id-183').fill(dimensions.height.toString());
                await page.locator('#katal-id-184').click();
                await page.locator('#katal-id-184').fill(dimensions.weight.toString());
                
                // Click the save dimensions button
                console.log('Clicking Save button in dimensions dialog...');
                await page.getByTestId('save-dimensions-button').click();
                await page.waitForTimeout(1000);

                // Click the additional save buttons twice
                const saveButton = page.getByRole('button', { name: 'Save' });
                await saveButton.waitFor({ state: 'visible' });
                await saveButton.click();
            } else {
                console.log('No missing ASIN data link found, proceeding with cleanup...');
            }

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
               // await page.screenshot({ path: path.join(this.profilesPath, `error_${Date.now()}.png`) });
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

            // Now we know params exists and has the required properties
            const labelPath = await generateLabel({
                fnsku,
                sku: params.sku!,
                asin: params.asin!,
                condition: params.condition,
                labelSize: this.printSettings?.labelSize || 'STANDARD', // Use configured size or default to STANDARD
                customSize: this.printSettings?.customSize // Pass through custom size if set
            });

            log.info('Using PDF path:', labelPath);

            // Get the media size based on current settings
            const mediaSize = this.printSettings?.labelSize === 'CUSTOM' && this.printSettings?.customSize
                ? `Custom.${this.printSettings.customSize.height}x${this.printSettings.customSize.width}in`
                : 'Custom.1x2.125in';

            // Using lp with specific options for rotation and sizing
            const command = `lp -d "${this.printerName}" -o landscape -o orientation-requested=6 -o scaling=100 -o media=${mediaSize} "${labelPath}"`;
            
            log.info('Sending print job with command:', command);
            
            const { stdout, stderr } = await execPromise(command);
            
            if (stderr) {
                log.error('Print error:', stderr);
                this.updateAutomationStatus(automation, {
                    message: 'Warning: Label printing failed, but listing was created successfully.',
                    progress: 100
                });
                return;
            }
            
            log.info('Print job sent successfully!', stdout);

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
        log.info('Updating print settings:', settings);
        // Only update provided settings, preserve others
        this.printSettings = {
            ...this.printSettings,  // Keep existing settings
            ...settings,            // Override with new settings
            copies: settings.copies || this.printSettings.copies || 0  // Preserve copies if not explicitly set
        };
        
        if (settings.printer) {
            this.printerName = settings.printer;
        }
        
        log.info('Final print settings:', this.printSettings);
        
        this.saveSettings().catch(error => {
            log.error('Failed to save print settings:', error);
        });
    }

    // Add new methods for settings persistence
    private async saveSettings() {
        try {
            const settingsToSave = {
                printSettings: this.printSettings
            };
            await fs.writeFile(this.settingsPath, JSON.stringify(settingsToSave, null, 2));
            log.info('Settings saved successfully:', settingsToSave);
        } catch (error) {
            log.error('Failed to save settings:', error);
        }
    }

    private async loadSettings() {
        try {
            if (await fs.access(this.settingsPath).then(() => true).catch(() => false)) {
                const data = await fs.readFile(this.settingsPath, 'utf-8');
                const settings = JSON.parse(data);
                if (settings.printSettings) {
                    // Preserve existing settings, only override with saved ones
                    this.printSettings = {
                        ...this.printSettings,
                        ...settings.printSettings
                    };
                    log.info('Settings loaded successfully:', this.printSettings);
                }
            }
        } catch (error) {
            log.error('Failed to load settings:', error);
        }
    }

    // Add a method to update active automation count
    private updateActiveAutomationCount() {
        const activeCount = this.runningAutomations.size;
        ipcWebContentsSend('activeAutomationsCount', this.mainWindow.webContents, activeCount);
        log.info('Updated active automation count', { activeCount });
    }
}

export function createAutomationManager(mainWindow: BrowserWindow) {
    return new AutomationManager(mainWindow);
} 